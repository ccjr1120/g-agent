use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};

use crate::protocol::{
    parse_server_message, ActiveAgentTurn, AgentInfo, AgentTaskInfo, ClientMessage, McpServerInfo,
    ScheduledTaskInfo, ScheduledTaskRun, ServerMessage, SkillInfo,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionState {
    Connecting,
    Connected,
    Disconnected,
}

#[derive(Debug, Clone, Default)]
pub struct ContextUsage {
    pub percent: u8,
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
    Skills(Vec<SkillInfo>),
    Mcp(Vec<McpServerInfo>),
    Context(ContextUsage),
    TurnStarted,
    ThinkingDelta(String),
    Delta(String),
    ToolCall {
        name: String,
        args: String,
    },
    TurnDone,
    Error(String),
    Resumed,
    AgentTasks(Vec<AgentTaskInfo>),
    AgentSession {
        slot: Option<u64>,
        agent: String,
        model: String,
        history: Vec<crate::protocol::ConversationTurn>,
        active_turn: Option<ActiveAgentTurn>,
    },
    ScheduledTasks(Vec<ScheduledTaskInfo>),
    ScheduledTaskUpdate(ScheduledTaskInfo),
    ScheduledTaskHistory {
        id: String,
        runs: Vec<ScheduledTaskRun>,
    },
    Notice(String),
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
        let _ =
            tokio::task::spawn_blocking(move || crate::server::ensure_server_running(&url)).await;

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
        ServerMessage::Agents {
            agents,
            active,
            model,
        } => {
            let _ = events.send(AgentEvent::Agents {
                agents,
                active,
                model,
            });
        }
        ServerMessage::Skills { skills } => {
            let _ = events.send(AgentEvent::Skills(skills));
        }
        ServerMessage::Mcp { servers } => {
            let _ = events.send(AgentEvent::Mcp(servers));
        }
        ServerMessage::Context {
            used_tokens: _,
            max_tokens: _,
            percent,
        } => {
            let _ = events.send(AgentEvent::Context(ContextUsage { percent }));
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
        ServerMessage::AgentTasks { tasks } => {
            let _ = events.send(AgentEvent::AgentTasks(tasks));
        }
        ServerMessage::AgentSession {
            slot,
            agent,
            model,
            history,
            active_turn,
        } => {
            let _ = events.send(AgentEvent::AgentSession {
                slot,
                agent,
                model,
                history,
                active_turn,
            });
        }
        ServerMessage::ScheduledTasks { tasks } => {
            let _ = events.send(AgentEvent::ScheduledTasks(tasks));
        }
        ServerMessage::ScheduledTaskUpdate { task } => {
            let _ = events.send(AgentEvent::ScheduledTaskUpdate(task));
        }
        ServerMessage::ScheduledTaskHistory { id, runs } => {
            let _ = events.send(AgentEvent::ScheduledTaskHistory { id, runs });
        }
        ServerMessage::Notice { message } => {
            let _ = events.send(AgentEvent::Notice(message));
        }
        ServerMessage::SystemPrompt { .. } | ServerMessage::ToolResult { .. } => {}
    }
}

pub fn format_tool_call(name: &str, args: &str) -> String {
    let parsed = serde_json::from_str::<serde_json::Value>(args).ok();

    if let Some(parsed) = &parsed {
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
        if name == "update_plan" {
            if let Some(steps) = parsed.get("steps").and_then(|value| value.as_array()) {
                let completed = steps
                    .iter()
                    .filter(|step| {
                        step.get("status").and_then(|value| value.as_str()) == Some("completed")
                    })
                    .count();
                return format!("Plan · {completed}/{}", steps.len());
            }
        }
        if name == "schedule_task" {
            let label = parsed
                .get("label")
                .and_then(|value| value.as_str())
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("Scheduled task");
            let interval = parsed
                .get("intervalSeconds")
                .and_then(|value| value.as_f64())
                .map(|value| format!(" · every {}s", value.round() as u64))
                .unwrap_or_default();
            return format!("Schedule · {label}{interval}");
        }
        if name == "unschedule_task" {
            if let Some(id) = parsed.get("id").and_then(|value| value.as_str()) {
                return format!("Unschedule · {id}");
            }
        }
        if name == "list_scheduled_tasks" {
            return "List scheduled tasks".into();
        }
    }

    // MCP / unknown tools: show a readable name, plus a primary arg when available.
    let display_name = display_tool_name(name);
    if let Some(summary) = parsed.as_ref().and_then(primary_arg_summary) {
        return format!("{} · {}", display_name, truncate(&summary, 48));
    }
    truncate(&display_name, 64)
}

/// `mcp__server__tool` → `server/tool`; otherwise the raw name.
fn display_tool_name(name: &str) -> String {
    if let Some(rest) = name.strip_prefix("mcp__") {
        if let Some((server, tool)) = rest.split_once("__") {
            if !server.is_empty() && !tool.is_empty() {
                return format!("{server}/{tool}");
            }
        }
    }
    name.to_string()
}

fn primary_arg_summary(parsed: &serde_json::Value) -> Option<String> {
    const PREFERRED_KEYS: &[&str] = &[
        "query", "q", "path", "url", "uri", "name", "message", "text", "prompt", "command",
        "pattern", "input", "content", "title", "id",
    ];

    let obj = parsed.as_object()?;
    for key in PREFERRED_KEYS {
        if let Some(value) = obj.get(*key).and_then(|value| value.as_str()) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }

    for value in obj.values() {
        if let Some(text) = value.as_str() {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }

    None
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    format!(
        "{}…",
        text.chars().take(max.saturating_sub(1)).collect::<String>()
    )
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_builtin_tools() {
        assert_eq!(
            format_tool_call("bash", r#"{"command":"ls -la"}"#),
            "ls -la"
        );
        assert_eq!(
            format_tool_call("read", r#"{"path":"README.md"}"#),
            "README.md"
        );
        assert_eq!(
            format_tool_call(
                "update_plan",
                r#"{"steps":[{"step":"Inspect","status":"completed"},{"step":"Verify","status":"in_progress"}]}"#
            ),
            "Plan · 1/2"
        );
        assert_eq!(
            format_tool_call(
                "schedule_task",
                r#"{"prompt":"fetch","intervalSeconds":600,"label":"需求列表"}"#
            ),
            "Schedule · 需求列表 · every 600s"
        );
        assert_eq!(
            format_tool_call("unschedule_task", r#"{"id":"st01"}"#),
            "Unschedule · st01"
        );
        assert_eq!(
            format_tool_call("list_scheduled_tasks", "{}"),
            "List scheduled tasks"
        );
    }

    #[test]
    fn formats_mcp_tool_with_query() {
        assert_eq!(
            format_tool_call(
                "mcp__knowledge-mcp__search_code_knowledge",
                r#"{"query":"how does auth work"}"#
            ),
            "knowledge-mcp/search_code_knowledge · how does auth work"
        );
    }

    #[test]
    fn formats_mcp_tool_without_useful_args() {
        assert_eq!(
            format_tool_call("mcp__knowledge-mcp__list_projects", "{}"),
            "knowledge-mcp/list_projects"
        );
    }
}
