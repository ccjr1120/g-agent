use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use crate::protocol::{DEFAULT_SERVER_PORT, DEFAULT_SERVER_URL};

const BANNER_FILENAME: &str = "banner.txt";
const DEFAULT_BANNER: &str =
    include_str!("../../../packages/agent/src/banners/builtin/banner.txt");

pub fn server_url() -> String {
    if let Ok(url) = env::var("G_AGENT_SERVER_URL") {
        let trimmed = url.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }

    let host = env::var("G_AGENT_HOST")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "127.0.0.1".to_string());
    let port = env::var("G_AGENT_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_SERVER_PORT);

    format!("ws://{host}:{port}")
}

pub fn config_dir() -> PathBuf {
    if let Ok(home) = env::var("G_AGENT_HOME") {
        if !home.trim().is_empty() {
            return PathBuf::from(home);
        }
    }

    directories::ProjectDirs::from("", "", "g-agent")
        .map(|dirs| dirs.config_dir().to_path_buf())
        .unwrap_or_else(|| PathBuf::from(".config/g-agent"))
}

pub fn config_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(path) = env::var("G_AGENT_CONFIG") {
        candidates.push(PathBuf::from(path));
    }
    candidates.push(config_dir().join("config.json"));
    if let Some(home) = directories::UserDirs::new() {
        candidates.push(home.home_dir().join(".local/share/g-agent/config.json"));
    }
    candidates
}

pub fn resolve_config_path() -> Option<PathBuf> {
    config_candidates()
        .into_iter()
        .find(|path| path.is_file())
}

pub fn load_banner_lines() -> Vec<String> {
    for path in banner_paths() {
        if !path.is_file() {
            continue;
        }
        if let Ok(content) = fs::read_to_string(&path) {
            let lines = parse_banner_content(&content);
            if !lines.is_empty() {
                return lines;
            }
        }
    }
    parse_banner_content(DEFAULT_BANNER)
}

fn parse_banner_content(content: &str) -> Vec<String> {
    let mut lines: Vec<String> = content
        .replace("\r\n", "\n")
        .lines()
        .map(str::to_string)
        .collect();
    if lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    lines
}

fn banner_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();

    if let Ok(dir) = env::var("G_AGENT_BANNERS_DIR") {
        paths.push(PathBuf::from(dir).join(BANNER_FILENAME));
    }
    if let Ok(home) = env::var("G_AGENT_HOME") {
        if !home.trim().is_empty() {
            paths.push(PathBuf::from(home).join("banners").join(BANNER_FILENAME));
        }
    }
    if let Some(user_dirs) = directories::UserDirs::new() {
        let home = user_dirs.home_dir();
        paths.push(home.join(".config/g-agent/banners/banner.txt"));
        paths.push(home.join(".local/share/g-agent/banners/banner.txt"));
    }
    paths.push(config_dir().join("banners/banner.txt"));

    if let Some(root) = repo_root_from_exe() {
        paths.push(
            root.join("packages/agent/src/banners/builtin/banner.txt"),
        );
    }

    if let Ok(exe) = env::current_exe() {
        if let Some(mut dir) = exe.parent().map(Path::to_path_buf) {
            for _ in 0..8 {
                paths.push(
                    dir.join("packages/agent/src/banners/builtin/banner.txt"),
                );
                if dir.join("apps/server/src/index.ts").is_file() {
                    break;
                }
                if !dir.pop() {
                    break;
                }
            }
        }
    }

    paths
}

pub fn repo_root_from_exe() -> Option<PathBuf> {
    for root in repo_root_candidates() {
        if root.join("apps/server/src/index.ts").is_file() {
            return Some(root);
        }
    }
    None
}

fn repo_root_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(path) = env::var("G_AGENT_INSTALL_DIR") {
        candidates.push(PathBuf::from(path));
    }

    if let Ok(path) = env::var("G_AGENT_HOME") {
        candidates.push(PathBuf::from(path));
    }

    if let Some(home) = directories::UserDirs::new() {
        candidates.push(home.home_dir().join(".local/share/g-agent"));
    }

    if let Ok(exe) = env::current_exe() {
        if let Some(mut dir) = exe.parent().map(Path::to_path_buf) {
            for _ in 0..8 {
                candidates.push(dir.clone());
                if dir.join("apps/server/src/index.ts").is_file() {
                    break;
                }
                if !dir.pop() {
                    break;
                }
            }
        }
    }

    candidates
}

pub fn read_config_server_hint() -> Result<Option<String>> {
    let Some(path) = resolve_config_path() else {
        return Ok(None);
    };
    let raw = fs::read_to_string(&path)
        .with_context(|| format!("read config at {}", path.display()))?;
    let value: serde_json::Value = serde_json::from_str(&raw)?;
    Ok(value
        .get("serverUrl")
        .and_then(|item| item.as_str())
        .map(str::to_string))
}

pub fn default_ws_url() -> String {
    read_config_server_hint()
        .ok()
        .flatten()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_SERVER_URL.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_banner_is_embedded() {
        let lines = load_banner_lines();
        assert!(!lines.is_empty());
        assert!(lines[0].contains('G') || lines[0].contains('█'));
    }
}
