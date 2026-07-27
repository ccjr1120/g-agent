use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};

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

const RECONNECT_BASE_MS: u64 = 300;
const RECONNECT_MAX_MS: u64 = 5_000;

impl AgentClient {
    /// Connect to the server, reconnecting automatically (with backoff) when
    /// the connection drops or cannot be established. Between attempts the
    /// background server is re-spawned if it died.
    pub fn connect(server_url: String) -> (Self, mpsc::UnboundedReceiver<AgentEvent>) {
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<ClientMessage>();
        tokio::spawn(connection_loop(server_url, event_tx, cmd_rx));
        (Self { outbound: cmd_tx }, event_rx)
    }

    pub fn send(&self, message: ClientMessage) {
        let _ = self.outbound.send(message);
    }
}

async fn connection_loop(
    server_url: String,
    events: mpsc::UnboundedSender<AgentEvent>,
    mut cmd_rx: mpsc::UnboundedReceiver<ClientMessage>,
) {
    let mut attempt: u32 = 0;
    loop {
        if events
            .send(AgentEvent::Connection(ConnectionState::Connecting))
            .is_err()
        {
            return;
        }

        if let Ok((ws, _)) = connect_async(&server_url).await {
            attempt = 0;
            let app_alive = run_connection(ws, &events, &mut cmd_rx).await;
            if !app_alive
                || events
                    .send(AgentEvent::Connection(ConnectionState::Disconnected))
                    .is_err()
            {
                return;
            }
        }

        // The server may have died with the connection — bring it back up
        // before retrying.
        let url = server_url.clone();
        let _ = tokio::task::spawn_blocking(move || {
            crate::server::ensure_server_running(&url)
        })
        .await;

        attempt = attempt.saturating_add(1);
        let delay = (RECONNECT_BASE_MS << attempt.min(4)).min(RECONNECT_MAX_MS);
        tokio::time::sleep(Duration::from_millis(delay)).await;
    }
}

/// Drive one live connection until it drops. Returns false when the app side
/// hung up (command channel closed) and the loop should exit for good.
async fn run_connection(
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
    events: &mpsc::UnboundedSender<AgentEvent>,
    cmd_rx: &mut mpsc::UnboundedReceiver<ClientMessage>,
) -> bool {
    let (mut write, mut read) = ws.split();
    loop {
        tokio::select! {
            cmd = cmd_rx.recv() => {
                let Some(cmd) = cmd else { return false; };
                let Ok(raw) = serde_json::to_string(&cmd) else { continue; };
                if write.send(Message::Text(raw.into())).await.is_err() {
                    return true;
                }
            }
            msg = read.next() => {
                let Some(msg) = msg else { return true; };
                match msg {
                    Ok(Message::Text(text)) => {
                        dispatch_server_message(events, &text);
                    }
                    Ok(Message::Close(_)) | Err(_) => return true,
                    _ => {}
                }
            }
        }
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
