use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const DEFAULT_SERVER_PORT: u16 = 3847;
pub const DEFAULT_SERVER_URL: &str = "ws://127.0.0.1:3847";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationTurn {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ClientMessage {
    Chat { message: String },
    Reset,
    Agent { #[serde(skip_serializing_if = "Option::is_none")] name: Option<String> },
    Skill { name: String },
    Mcp,
    Resume { agent: String, history: Vec<ConversationTurn> },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
#[allow(dead_code)]
pub enum ServerMessage {
    Ready,
    Agents {
        agents: Vec<AgentInfo>,
        active: String,
        model: String,
    },
    AgentFallback { requested: String, active: String },
    Skills { skills: Vec<SkillInfo> },
    Mcp { servers: Vec<McpServerInfo> },
    Context {
        used_tokens: u64,
        max_tokens: u64,
        percent: u8,
    },
    Start,
    SystemPrompt { text: String },
    ThinkingDelta { text: String },
    Delta { text: String },
    ToolCall { name: String, args: String },
    ToolResult { name: String, output: String },
    Done,
    Error { message: String },
    Resumed { agent: String, turns: u64 },
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct AgentInfo {
    pub name: String,
    pub description: String,
    pub active: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct McpServerInfo {
    pub name: String,
    pub source: String,
    pub transport: String,
    pub target: String,
    pub connected: bool,
    #[serde(default)]
    pub error: Option<String>,
    pub tool_count: u64,
    #[serde(default)]
    pub tools: Vec<McpToolInfo>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct McpToolInfo {
    pub name: String,
    #[serde(default)]
    pub description: String,
}

pub fn parse_server_message(raw: &str) -> Option<ServerMessage> {
    serde_json::from_str(raw).ok()
}

pub fn health_check_url(server_url: &str) -> String {
    server_url.replacen("ws://", "http://", 1).replacen("wss://", "https://", 1)
}

#[allow(dead_code)]
pub fn parse_loose_json(raw: &str) -> Option<Value> {
    serde_json::from_str(raw).ok()
}
