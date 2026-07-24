use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::protocol::{
    parse_server_message, AgentInfo, ClientMessage, McpServerInfo, ServerMessage,
    SkillInfo,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionState {
    Connecting,
    Connected,
    Disconnected,
}

#[derive(Debug, Clone)]
pub struct ContextUsage {
    pub used_tokens: u64,
    pub max_tokens: u64,
    pub percent: u8,
}

impl Default for ContextUsage {
    fn default() -> Self {
        Self {
            used_tokens: 0,
            max_tokens: 0,
            percent: 0,
        }
    }
}

#[derive(Debug, Clone)]
pub struct AgentFallback {
    pub requested: String,
    pub active: String,
}

#[derive(Debug, Clone)]
pub struct ToolCallDisplay {
    pub name: String,
    pub label: String,
}

#[derive(Debug, Clone)]
pub struct ChatLine {
    pub role: String,
    pub text: String,
    pub sent_content: Option<String>,
    pub thinking: String,
    pub tools: Vec<ToolCallDisplay>,
    pub duration_ms: Option<u64>,
    pub queued: bool,
}

#[derive(Debug)]
pub enum AgentEvent {
    Connection(ConnectionState),
    Agents {
        agents: Vec<AgentInfo>,
        active: String,
        model: String,
    },
    AgentFallback(AgentFallback),
    Skills(Vec<SkillInfo>),
    Mcp(Vec<McpServerInfo>),
    Context(ContextUsage),
    TurnStarted,
    ThinkingDelta(String),
    Delta(String),
    ToolCall { name: String, args: String },
    TurnDone,
    Error(String),
    Resumed,
}

pub struct AgentClient {
    outbound: mpsc::UnboundedSender<ClientMessage>,
}

impl AgentClient {
    pub async fn connect(server_url: String) -> anyhow::Result<(Self, mpsc::UnboundedReceiver<AgentEvent>)> {
        let (ws, _) = connect_async(&server_url).await?;
        let (mut write, mut read) = ws.split();
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<ClientMessage>();

        let events = event_tx.clone();
        events.send(AgentEvent::Connection(ConnectionState::Connecting)).ok();

        tokio::spawn(async move {
            loop {
                tokio::select! {
                    cmd = cmd_rx.recv() => {
                        let Some(cmd) = cmd else { break; };
                        let Ok(raw) = serde_json::to_string(&cmd) else { continue; };
                        if write.send(Message::Text(raw.into())).await.is_err() {
                            events.send(AgentEvent::Connection(ConnectionState::Disconnected)).ok();
                            break;
                        }
                    }
                    msg = read.next() => {
                        let Some(msg) = msg else {
                            events.send(AgentEvent::Connection(ConnectionState::Disconnected)).ok();
                            break;
                        };
                        match msg {
                            Ok(Message::Text(text)) => {
                                dispatch_server_message(&events, &text);
                            }
                            Ok(Message::Close(_)) => {
                                events.send(AgentEvent::Connection(ConnectionState::Disconnected)).ok();
                                break;
                            }
                            Err(_) => {
                                events.send(AgentEvent::Connection(ConnectionState::Disconnected)).ok();
                                break;
                            }
                            _ => {}
                        }
                    }
                }
            }
        });

        Ok((Self { outbound: cmd_tx }, event_rx))
    }

    pub fn send(&self, message: ClientMessage) {
        let _ = self.outbound.send(message);
    }
}

fn dispatch_server_message(events: &mpsc::UnboundedSender<AgentEvent>, raw: &str) {
    let Some(message) = parse_server_message(raw) else {
        return;
    };

    match message {
        ServerMessage::Ready => {
            let _ = events.send(AgentEvent::Connection(ConnectionState::Connected));
        }
        ServerMessage::Agents { agents, active, model } => {
            let _ = events.send(AgentEvent::Agents { agents, active, model });
        }
        ServerMessage::AgentFallback { requested, active } => {
            let _ = events.send(AgentEvent::AgentFallback(AgentFallback { requested, active }));
        }
        ServerMessage::Skills { skills } => {
            let _ = events.send(AgentEvent::Skills(skills));
        }
        ServerMessage::Mcp { servers } => {
            let _ = events.send(AgentEvent::Mcp(servers));
        }
        ServerMessage::Context {
            used_tokens,
            max_tokens,
            percent,
        } => {
            let _ = events.send(AgentEvent::Context(ContextUsage {
                used_tokens,
                max_tokens,
                percent,
            }));
        }
        ServerMessage::Start => {
            let _ = events.send(AgentEvent::TurnStarted);
        }
        ServerMessage::ThinkingDelta { text } => {
            let _ = events.send(AgentEvent::ThinkingDelta(text));
        }
        ServerMessage::Delta { text } => {
            let _ = events.send(AgentEvent::Delta(text));
        }
        ServerMessage::ToolCall { name, args } => {
            let _ = events.send(AgentEvent::ToolCall { name, args });
        }
        ServerMessage::Done => {
            let _ = events.send(AgentEvent::TurnDone);
        }
        ServerMessage::Error { message } => {
            let _ = events.send(AgentEvent::Error(message));
        }
        ServerMessage::Resumed { .. } => {
            let _ = events.send(AgentEvent::Resumed);
        }
        ServerMessage::SystemPrompt { .. } | ServerMessage::ToolResult { .. } => {}
    }
}

pub fn format_tool_call(name: &str, args: &str) -> String {
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(args) {
        if name == "bash" {
            if let Some(command) = parsed.get("command").and_then(|value| value.as_str()) {
                return truncate(command, 64);
            }
        }
        if name == "read" || name == "write" {
            if let Some(path) = parsed.get("path").and_then(|value| value.as_str()) {
                return compact_path(path, 48);
            }
        }
        if name == "glob" || name == "grep" {
            if let Some(pattern) = parsed.get("pattern").and_then(|value| value.as_str()) {
                return truncate(pattern, 48);
            }
        }
    }
    "…".to_string()
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    format!("{}…", text.chars().take(max.saturating_sub(1)).collect::<String>())
}

fn compact_path(path: &str, max: usize) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let short = if !home.is_empty() && path.starts_with(&home) {
        format!("~{}", &path[home.len()..])
    } else {
        path.to_string()
    };
    truncate(&short, max)
}
