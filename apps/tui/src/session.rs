use std::collections::VecDeque;
use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::config::config_dir;
use crate::protocol::ConversationTurn;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSession {
    pub id: String,
    pub agent: String,
    pub model: String,
    pub started_at: i64,
    pub updated_at: i64,
    pub preview: String,
    pub turn_count: u64,
    pub history: Vec<ConversationTurn>,
}

#[derive(Debug, Clone)]
pub struct SavedSessionSummary {
    pub id: String,
    pub agent: String,
    pub preview: String,
    pub updated_at: i64,
    pub turn_count: u64,
}

fn sessions_dir() -> PathBuf {
    config_dir().join("sessions")
}

fn session_path(id: &str) -> PathBuf {
    sessions_dir().join(format!("{id}.json"))
}

pub fn list_sessions() -> Result<Vec<SavedSessionSummary>> {
    let dir = sessions_dir();
    if !dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut sessions = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_type()?.is_file() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let raw = fs::read_to_string(&path)?;
            if let Ok(session) = serde_json::from_str::<SavedSession>(&raw) {
                sessions.push(SavedSessionSummary {
                    id: session.id,
                    agent: session.agent,
                    preview: session.preview,
                    updated_at: session.updated_at,
                    turn_count: session.turn_count,
                });
            }
        }
    }

    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(sessions)
}

pub fn load_session(id_or_prefix: &str) -> Result<Option<SavedSession>> {
    let dir = sessions_dir();
    if !dir.is_dir() {
        return Ok(None);
    }

    let mut exact = None;
    let mut prefix_matches = Vec::new();

    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let path = entry.path();
        let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        if stem == id_or_prefix {
            exact = Some(path);
            break;
        }
        if stem.starts_with(id_or_prefix) {
            prefix_matches.push(path);
        }
    }

    let path = exact.or_else(|| {
        prefix_matches.sort();
        prefix_matches.into_iter().next()
    });

    let Some(path) = path else {
        return Ok(None);
    };

    let raw = fs::read_to_string(path)?;
    Ok(Some(serde_json::from_str(&raw)?))
}

pub fn save_session(session: &SavedSession) -> Result<()> {
    fs::create_dir_all(sessions_dir())?;
    let raw = serde_json::to_string_pretty(session)?;
    fs::write(session_path(&session.id), raw)?;
    Ok(())
}

pub fn format_session_age(updated_at: i64) -> String {
    let now = chrono::Utc::now().timestamp();
    let delta = (now - updated_at).max(0);
    if delta < 60 {
        return "just now".to_string();
    }
    if delta < 3600 {
        return format!("{}m ago", delta / 60);
    }
    if delta < 86_400 {
        return format!("{}h ago", delta / 3600);
    }
    format!("{}d ago", delta / 86_400)
}

pub fn build_session_preview(history: &[ConversationTurn]) -> String {
    history
        .iter()
        .find(|turn| turn.role == "user")
        .map(|turn| truncate(&turn.content.replace('\n', " ").trim(), 60))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Untitled session".to_string())
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    format!("{}…", text.chars().take(max.saturating_sub(1)).collect::<String>())
}

pub fn write_conversation_log(lines: &[(String, String)]) -> Result<PathBuf> {
    let log_dir = config_dir().join("logs");
    fs::create_dir_all(&log_dir).context("create log dir")?;
    let filename = format!(
        "conversation-{}.md",
        chrono::Utc::now().format("%Y-%m-%dT%H-%M-%S")
    );
    let path = log_dir.join(filename);
    let mut output = String::from("# Conversation Log\n\n");
    for (role, content) in lines {
        let heading = if role == "user" {
            "## User"
        } else {
            "## Assistant"
        };
        output.push_str(heading);
        output.push_str("\n\n");
        output.push_str(content);
        output.push_str("\n\n---\n\n");
    }
    fs::write(&path, output)?;
    Ok(path)
}

pub fn format_session_label(summary: &SavedSessionSummary) -> String {
    format!(
        "{} · {} · {} msgs · {}",
        summary.preview,
        format_session_age(summary.updated_at),
        summary.turn_count,
        summary.id
    )
}

#[derive(Debug, Clone)]
pub enum UndoEntry {
    Chat {
        user_index: usize,
        text: String,
    },
    Local {
        line_index: usize,
    },
}

pub struct UndoStack {
    entries: VecDeque<UndoEntry>,
}

impl UndoStack {
    pub fn new() -> Self {
        Self {
            entries: VecDeque::new(),
        }
    }

    pub fn push(&mut self, entry: UndoEntry) {
        self.entries.push_back(entry);
    }

    pub fn pop(&mut self) -> Option<UndoEntry> {
        self.entries.pop_back()
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }
}

impl Default for UndoStack {
    fn default() -> Self {
        Self::new()
    }
}
