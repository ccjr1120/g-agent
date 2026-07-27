use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use reqwest::blocking::Client;

use crate::config::{config_dir, repo_root_from_exe};
use crate::protocol::health_check_url;

const POLL_INTERVAL: Duration = Duration::from_millis(100);
const POLL_ATTEMPTS: usize = 50;

pub fn ensure_server_running(server_url: &str) -> Result<()> {
    let health_url = health_check_url(server_url);
    if is_server_up(&health_url)? {
        return Ok(());
    }

    if !has_live_server_lock()? {
        spawn_server()?;
    }

    for _ in 0..POLL_ATTEMPTS {
        if is_server_up(&health_url)? {
            return Ok(());
        }
        thread::sleep(POLL_INTERVAL);
    }

    Err(anyhow!("server did not become ready at {server_url}"))
}

pub fn restart_server(server_url: &str) -> Result<()> {
    let health_url = health_check_url(server_url);
    stop_running_server(server_url, &health_url)?;

    spawn_server()?;

    for _ in 0..POLL_ATTEMPTS {
        if is_server_up(&health_url)? {
            return Ok(());
        }
        thread::sleep(POLL_INTERVAL);
    }

    Err(anyhow!("server did not become ready at {server_url}"))
}

pub fn stop_server(server_url: &str) -> Result<()> {
    let health_url = health_check_url(server_url);
    stop_running_server(server_url, &health_url)
}

pub fn print_server_status(server_url: &str) -> Result<()> {
    let health_url = health_check_url(server_url);
    let up = is_server_up(&health_url)?;
    let pid = read_server_pid()?;

    if up {
        match pid.filter(|value| is_pid_alive(*value)) {
            Some(pid) => println!("g-agent: server running at {server_url} (pid {pid})"),
            None => println!(
                "g-agent: server running at {server_url} (no pid file — started externally?)"
            ),
        }
    } else {
        match pid.filter(|value| is_pid_alive(*value)) {
            Some(pid) => println!(
                "g-agent: server process alive (pid {pid}) but not answering at {server_url}"
            ),
            None => println!("g-agent: server not running"),
        }
    }
    println!("g-agent: log file {}", log_path().display());
    Ok(())
}

pub fn tail_logs(follow: bool) -> Result<()> {
    let path = log_path();
    if !path.is_file() {
        return Err(anyhow!("no log file at {}", path.display()));
    }
    let mut command = Command::new("tail");
    if follow {
        command.arg("-f");
    } else {
        command.args(["-n", "200"]);
    }
    let status = command.arg(&path).status().context("run tail")?;
    if !status.success() && follow {
        // Ctrl-C on `tail -f` is a normal way to leave.
        return Ok(());
    }
    Ok(())
}

/// Run the server in the foreground, replacing this process. Used as the
/// launchd program so the daemon manages bun's lifetime directly.
pub fn run_server_foreground() -> Result<()> {
    let root = server_repo_root()?;
    let entry = root.join("apps/server/src/index.ts");

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let err = Command::new(bun_binary()).current_dir(&root).arg(entry).exec();
        Err(anyhow!("failed to exec bun: {err}"))
    }
    #[cfg(not(unix))]
    {
        let status = Command::new(bun_binary())
            .current_dir(&root)
            .arg(entry)
            .status()
            .context("run bun server")?;
        if status.success() {
            Ok(())
        } else {
            Err(anyhow!("server exited with {status}"))
        }
    }
}

fn stop_running_server(server_url: &str, health_url: &str) -> Result<()> {
    if !is_server_up(health_url)? {
        let _ = stop_server_from_pid_file()?;
        return Ok(());
    }

    match stop_server_from_pid_file()? {
        StopResult::Stopped if wait_for_server_down(health_url) => return Ok(()),
        StopResult::StalePid if wait_for_server_down(health_url) => return Ok(()),
        _ => {}
    }

    if is_server_up(health_url)? {
        stop_listeners_on_port(server_port(server_url))?;
        if !wait_for_server_down(health_url) {
            return Err(anyhow!("failed to stop existing server at {server_url}"));
        }
    }

    let _ = fs::remove_file(pid_path());
    Ok(())
}

fn server_port(server_url: &str) -> u16 {
    let without_scheme = server_url
        .strip_prefix("ws://")
        .or_else(|| server_url.strip_prefix("wss://"))
        .or_else(|| server_url.strip_prefix("http://"))
        .or_else(|| server_url.strip_prefix("https://"))
        .unwrap_or(server_url);
    let host_port = without_scheme.split('/').next().unwrap_or(without_scheme);
    if let Some((_host, port_str)) = host_port.rsplit_once(':') {
        if let Ok(port) = port_str.parse::<u16>() {
            return port;
        }
    }
    crate::protocol::DEFAULT_SERVER_PORT
}

fn wait_for_server_down(health_url: &str) -> bool {
    for _ in 0..POLL_ATTEMPTS {
        if !is_server_up(health_url).unwrap_or(true) {
            return true;
        }
        thread::sleep(POLL_INTERVAL);
    }
    !is_server_up(health_url).unwrap_or(true)
}

fn stop_listeners_on_port(port: u16) -> Result<()> {
    for pid in find_listener_pids(port)? {
        stop_pid(pid);
    }
    Ok(())
}

fn find_listener_pids(port: u16) -> Result<Vec<u32>> {
    let port_arg = format!("TCP:{port}");
    let output = Command::new("lsof")
        .args(["-ti", &port_arg, "-sTCP:LISTEN"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .with_context(|| format!("run lsof for port {port}"))?;

    if !output.status.success() {
        return Ok(vec![]);
    }

    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .collect())
}

fn stop_pid(pid: u32) {
    let _ = Command::new("kill").arg(pid.to_string()).status();
    if !wait_for_pid_exit(pid, 30) {
        let _ = Command::new("kill")
            .args(["-9", &pid.to_string()])
            .status();
        let _ = wait_for_pid_exit(pid, 20);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StopResult {
    Stopped,
    NotRunning,
    StalePid,
}

fn pid_path() -> PathBuf {
    config_dir().join("server.pid")
}

fn log_path() -> PathBuf {
    config_dir().join("logs/server.log")
}

fn is_server_up(health_url: &str) -> Result<bool> {
    let client = Client::builder()
        .timeout(Duration::from_millis(300))
        .build()?;
    Ok(client.get(health_url).send().map(|resp| resp.status().is_success()).unwrap_or(false))
}

fn has_live_server_lock() -> Result<bool> {
    let Some(pid) = read_server_pid()? else {
        return Ok(false);
    };
    Ok(is_pid_alive(pid))
}

fn read_server_pid() -> Result<Option<u32>> {
    let path = pid_path();
    if !path.is_file() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path)?;
    Ok(raw.trim().parse::<u32>().ok())
}

fn is_pid_alive(pid: u32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn wait_for_pid_exit(pid: u32, attempts: usize) -> bool {
    for _ in 0..attempts {
        if !is_pid_alive(pid) {
            return true;
        }
        thread::sleep(POLL_INTERVAL);
    }
    !is_pid_alive(pid)
}

fn stop_server_from_pid_file() -> Result<StopResult> {
    let Some(pid) = read_server_pid()? else {
        return Ok(StopResult::NotRunning);
    };

    if !is_pid_alive(pid) {
        let _ = fs::remove_file(pid_path());
        return Ok(StopResult::StalePid);
    }

    stop_pid(pid);
    let _ = fs::remove_file(pid_path());
    Ok(StopResult::Stopped)
}

fn server_repo_root() -> Result<PathBuf> {
    let root = repo_root_from_exe().context(
        "could not locate @g-agent/server entry point; set G_AGENT_HOME to your g-agent checkout, or reinstall with install.sh / cargo install --path apps/tui from the repo",
    )?;
    let entry = root.join("apps/server/src/index.ts");
    if !entry.is_file() {
        return Err(anyhow!("server entry not found at {}", entry.display()));
    }
    Ok(root)
}

/// launchd starts agents with a minimal PATH, so prefer well-known install
/// locations over relying on the environment.
fn bun_binary() -> PathBuf {
    if let Some(home) = directories::UserDirs::new() {
        let candidate = home.home_dir().join(".bun/bin/bun");
        if candidate.is_file() {
            return candidate;
        }
    }
    for candidate in ["/opt/homebrew/bin/bun", "/usr/local/bin/bun"] {
        let path = Path::new(candidate);
        if path.is_file() {
            return path.to_path_buf();
        }
    }
    PathBuf::from("bun")
}

fn spawn_server() -> Result<()> {
    let root = server_repo_root()?;
    let entry = root.join("apps/server/src/index.ts");

    fs::create_dir_all(log_path().parent().unwrap_or(Path::new(".")))?;
    let log_file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path())?;
    let log_err = log_file.try_clone()?;

    let mut command = Command::new(bun_binary());
    command
        .current_dir(&root)
        .arg(entry)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(log_err));

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let child = command.spawn().context("spawn bun server")?;
    fs::write(pid_path(), child.id().to_string())?;
    Ok(())
}

const LAUNCHD_LABEL: &str = "com.ccjr.g-agent.server";

fn launchd_plist_path() -> Result<PathBuf> {
    let home = directories::UserDirs::new()
        .map(|dirs| dirs.home_dir().to_path_buf())
        .context("resolve home directory")?;
    Ok(home.join(format!("Library/LaunchAgents/{LAUNCHD_LABEL}.plist")))
}

pub fn enable_autostart() -> Result<()> {
    if !cfg!(target_os = "macos") {
        return Err(anyhow!("autostart is only supported on macOS (launchd)"));
    }
    // Fail early with a clear message if the server entry can't be found —
    // otherwise launchd would crash-loop silently.
    server_repo_root()?;

    let exe = std::env::current_exe().context("resolve g-agent binary path")?;
    let log = log_path();
    fs::create_dir_all(log.parent().unwrap_or(Path::new(".")))?;

    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{exe}</string>
        <string>server</string>
        <string>run</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>{log}</string>
    <key>StandardErrorPath</key>
    <string>{log}</string>
</dict>
</plist>
"#,
        exe = exe.display(),
        log = log.display(),
    );

    let plist_path = launchd_plist_path()?;
    fs::create_dir_all(plist_path.parent().unwrap_or(Path::new(".")))?;

    // Reload cleanly if it is already installed.
    let _ = Command::new("launchctl")
        .args(["unload", "-w"])
        .arg(&plist_path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();

    fs::write(&plist_path, plist)
        .with_context(|| format!("write {}", plist_path.display()))?;

    // The launchd job owns the server now — stop any manually spawned one so
    // they don't fight over the port.
    let _ = stop_server_from_pid_file();

    let status = Command::new("launchctl")
        .args(["load", "-w"])
        .arg(&plist_path)
        .status()
        .context("run launchctl load")?;
    if !status.success() {
        return Err(anyhow!("launchctl load failed for {}", plist_path.display()));
    }

    println!("g-agent: autostart enabled ({})", plist_path.display());
    println!("g-agent: the server now starts at login and restarts if it crashes");
    Ok(())
}

pub fn disable_autostart() -> Result<()> {
    let plist_path = launchd_plist_path()?;
    if !plist_path.is_file() {
        println!("g-agent: autostart is not enabled");
        return Ok(());
    }

    let status = Command::new("launchctl")
        .args(["unload", "-w"])
        .arg(&plist_path)
        .status()
        .context("run launchctl unload")?;
    if !status.success() {
        eprintln!(
            "g-agent: warning: launchctl unload failed — removing {} anyway",
            plist_path.display()
        );
    }
    fs::remove_file(&plist_path)
        .with_context(|| format!("remove {}", plist_path.display()))?;
    println!("g-agent: autostart disabled");
    Ok(())
}

pub fn print_autostart_status() -> Result<()> {
    let plist_path = launchd_plist_path()?;
    if !plist_path.is_file() {
        println!("g-agent: autostart disabled");
        return Ok(());
    }

    let loaded = Command::new("launchctl")
        .args(["list", LAUNCHD_LABEL])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    println!(
        "g-agent: autostart enabled ({}) — launchd job {}",
        plist_path.display(),
        if loaded { "loaded" } else { "not loaded" }
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::server_port;
    use crate::protocol::DEFAULT_SERVER_PORT;

    #[test]
    fn server_port_parses_ws_url() {
        assert_eq!(server_port("ws://127.0.0.1:3847"), 3847);
        assert_eq!(server_port("ws://127.0.0.1:4000/ws"), 4000);
    }

    #[test]
    fn server_port_falls_back_to_default() {
        assert_eq!(server_port("ws://127.0.0.1"), DEFAULT_SERVER_PORT);
    }
}
