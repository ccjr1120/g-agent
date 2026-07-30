mod agent;
mod config;
mod protocol;
mod server;
mod session;
mod ui;

use std::io::{stdout, Write};
use std::time::Duration;

use anyhow::Result;
use clap::{Parser, Subcommand};
use crossterm::{
    cursor::{Hide, Show},
    event::{DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};

use crate::config::{load_banner_lines, server_url};
use crate::server::{
    disable_autostart, enable_autostart, ensure_server_running, print_autostart_status,
    print_server_status, restart_server, run_server_foreground, stop_server, tail_logs,
};
use crate::ui::App;

#[derive(Parser)]
#[command(name = "g-agent", about = "G-Agent terminal UI")]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand)]
enum Commands {
    /// Server management
    Server {
        #[command(subcommand)]
        command: ServerCommands,
    },
    /// Launch the server automatically at login (macOS launchd)
    Autostart {
        #[command(subcommand)]
        command: AutostartCommands,
    },
}

#[derive(Subcommand)]
enum ServerCommands {
    /// Start the background server if it is not already running
    Start,
    /// Stop the background server process
    Stop,
    /// Restart the background server process
    Restart,
    /// Show whether the server is running and where
    Status,
    /// Print the server log (use -f to follow)
    Logs {
        /// Keep following the log like `tail -f`
        #[arg(short, long)]
        follow: bool,
    },
    /// Run the server in the foreground (used by launchd / for debugging)
    Run,
}

#[derive(Subcommand)]
enum AutostartCommands {
    /// Install and load the launchd agent
    Enable,
    /// Unload and remove the launchd agent
    Disable,
    /// Show whether the launchd agent is installed
    Status,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let ws_url = server_url();

    match cli.command {
        Some(Commands::Server { command }) => {
            match command {
                ServerCommands::Start => {
                    ensure_server_running(&ws_url)?;
                    println!("g-agent: server running at {ws_url}");
                }
                ServerCommands::Stop => {
                    stop_server(&ws_url)?;
                    println!("g-agent: server stopped");
                }
                ServerCommands::Restart => {
                    restart_server(&ws_url)?;
                    println!("g-agent: server restarted at {ws_url}");
                }
                ServerCommands::Status => print_server_status(&ws_url)?,
                ServerCommands::Logs { follow } => tail_logs(follow)?,
                ServerCommands::Run => run_server_foreground()?,
            }
            return Ok(());
        }
        Some(Commands::Autostart { command }) => {
            match command {
                AutostartCommands::Enable => enable_autostart()?,
                AutostartCommands::Disable => disable_autostart()?,
                AutostartCommands::Status => print_autostart_status()?,
            }
            return Ok(());
        }
        None => {}
    }

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    rt.block_on(async_main(ws_url))
}

async fn async_main(ws_url: String) -> Result<()> {
    ensure_server_running(&ws_url)?;
    let banner = load_banner_lines();
    // Connect to the same URL we just ensured is up (env / port overrides
    // take precedence over a stale config.json `serverUrl`).
    run_tui(ws_url, banner).await
}

async fn run_tui(server_url: String, banner: Vec<String>) -> Result<()> {
    enable_raw_mode()?;
    let mut stdout = stdout();
    execute!(
        stdout,
        EnterAlternateScreen,
        EnableMouseCapture,
        EnableBracketedPaste,
        Hide
    )?;

    let result = App::new(server_url, banner).run().await;

    execute!(
        stdout,
        DisableMouseCapture,
        DisableBracketedPaste,
        LeaveAlternateScreen,
        Show
    )?;
    disable_raw_mode()?;
    stdout.flush()?;

    result
}

pub fn sleep_ms(ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
}
