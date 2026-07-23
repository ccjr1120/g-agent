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
    let stop_result = stop_server_from_pid_file()?;

    if stop_result == StopResult::NotRunning && is_server_up(&health_url)? {
        return Err(anyhow!(
            "server is already running at {server_url}, but pid file is missing; cannot safely restart"
        ));
    }

    spawn_server()?;

    for _ in 0..POLL_ATTEMPTS {
        if is_server_up(&health_url)? {
            return Ok(());
        }
        thread::sleep(POLL_INTERVAL);
    }

    Err(anyhow!("server did not become ready at {server_url}"))
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

    let _ = Command::new("kill").arg(pid.to_string()).status();
    if !wait_for_pid_exit(pid, 30) {
        let _ = Command::new("kill")
            .args(["-9", &pid.to_string()])
            .status();
        let _ = wait_for_pid_exit(pid, 20);
    }
    let _ = fs::remove_file(pid_path());
    Ok(StopResult::Stopped)
}

fn spawn_server() -> Result<()> {
    let root = repo_root_from_exe().context("could not locate @g-agent/server entry point")?;
    let entry = root.join("apps/server/src/index.ts");
    if !entry.is_file() {
        return Err(anyhow!("server entry not found at {}", entry.display()));
    }

    fs::create_dir_all(log_path().parent().unwrap_or(Path::new(".")))?;
    let log_file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path())?;
    let log_err = log_file.try_clone()?;

    let mut command = Command::new("bun");
    command
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
