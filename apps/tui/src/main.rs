mod agent;
mod config;
mod protocol;
mod server;
mod session;
mod ui;

use std::fmt;
use std::io::{stdout, Write};
use std::time::Duration;

use anyhow::Result;
use clap::{Parser, Subcommand};
use crossterm::{
    cursor::{Hide, Show},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
    Command,
};

use crate::config::{default_ws_url, load_banner_lines, server_url};
use crate::server::{ensure_server_running, restart_server};
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
}

#[derive(Subcommand)]
enum ServerCommands {
    /// Restart the background server process
    Restart,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let ws_url = server_url();

    if let Some(Commands::Server { command }) = cli.command {
        match command {
            ServerCommands::Restart => {
                restart_server(&ws_url)?;
                println!("g-agent: server restarted at {ws_url}");
            }
        }
        return Ok(());
    }

    ensure_server_running(&ws_url)?;
    let banner = load_banner_lines();
    run_tui(default_ws_url(), banner).await
}

async fn run_tui(server_url: String, banner: Vec<String>) -> Result<()> {
    enable_raw_mode()?;
    let mut stdout = stdout();
    execute!(stdout, EnterAlternateScreen, EnableAlternateScroll, Hide)?;

    let result = App::new(server_url, banner).await.run().await;

    execute!(stdout, DisableAlternateScroll, LeaveAlternateScreen, Show)?;
    disable_raw_mode()?;
    stdout.flush()?;

    result
}

/// Wheel → cursor up/down in the alternate screen, without capturing mouse clicks/drags.
#[derive(Debug, Clone, Copy)]
struct EnableAlternateScroll;

impl Command for EnableAlternateScroll {
    fn write_ansi(&self, f: &mut impl fmt::Write) -> fmt::Result {
        f.write_str("\x1b[?1007h")
    }
}

#[derive(Debug, Clone, Copy)]
struct DisableAlternateScroll;

impl Command for DisableAlternateScroll {
    fn write_ansi(&self, f: &mut impl fmt::Write) -> fmt::Result {
        f.write_str("\x1b[?1007l")
    }
}

pub fn sleep_ms(ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_url_is_valid() {
        assert!(default_ws_url().starts_with("ws://"));
    }
}
