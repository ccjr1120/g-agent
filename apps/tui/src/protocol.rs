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
    Chat {
        message: String,
    },
    Cancel,
    Reset,
    Agent {
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
    },
    Skill {
        name: String,
    },
    Mcp,
    McpAuth {
        name: String,
    },
    Reload,
    #[serde(rename = "agent_task")]
    AgentTask {
        slot: u64,
    },
    #[serde(rename = "agent_tasks")]
    AgentTasks,
    #[serde(rename = "agent_back")]
    AgentBack,
    Resume {
        agent: String,
        history: Vec<ConversationTurn>,
    },
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
    Skills {
        skills: Vec<SkillInfo>,
    },
    Mcp {
        servers: Vec<McpServerInfo>,
    },
    Context {
        used_tokens: u64,
        max_tokens: u64,
        percent: u8,
    },
    Start,
    #[serde(rename = "system_prompt")]
    SystemPrompt {
        text: String,
    },
    ThinkingDelta {
        text: String,
    },
    Delta {
        text: String,
    },
    #[serde(rename = "tool_call")]
    ToolCall {
        name: String,
        args: String,
    },
    #[serde(rename = "tool_result")]
    ToolResult {
        name: String,
        output: String,
    },
    Done,
    Error {
        message: String,
    },
    Resumed {
        agent: String,
        turns: u64,
    },
    #[serde(rename = "agent_tasks")]
    AgentTasks {
        tasks: Vec<AgentTaskInfo>,
    },
    #[serde(rename = "agent_session")]
    AgentSession {
        #[serde(default)]
        slot: Option<u64>,
        agent: String,
        model: String,
        history: Vec<ConversationTurn>,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentTaskInfo {
    pub slot: u64,
    pub agent: String,
    pub title: String,
    pub status: String,
    #[serde(default)]
    pub activity: Option<String>,
    pub elapsed_ms: u64,
    pub unread: bool,
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
#[serde(rename_all = "camelCase")]
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
    #[serde(default)]
    pub oauth: bool,
    #[serde(default)]
    pub auth_required: bool,
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
    server_url
        .replacen("ws://", "http://", 1)
        .replacen("wss://", "https://", 1)
}

#[allow(dead_code)]
pub fn parse_loose_json(raw: &str) -> Option<Value> {
    serde_json::from_str(raw).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_snake_case_tool_call_from_server() {
        let message = parse_server_message(
            r#"{"type":"tool_call","name":"read","args":"{\"path\":\"README.md\"}"}"#,
        );
        assert!(matches!(
            message,
            Some(ServerMessage::ToolCall { name, .. }) if name == "read"
        ));
    }

    #[test]
    fn parses_camel_case_mcp_catalog_from_server() {
        let message = parse_server_message(
            r#"{"type":"mcp","servers":[{"name":"knowledge-mcp","source":"agent","transport":"url","target":"http://localhost:7077/mcp","connected":true,"toolCount":2,"tools":[],"oauth":false,"authRequired":false}]}"#,
        );
        assert!(matches!(
            message,
            Some(ServerMessage::Mcp { servers })
                if servers.len() == 1
                    && servers[0].name == "knowledge-mcp"
                    && servers[0].tool_count == 2
                    && !servers[0].auth_required
        ));
    }

    #[test]
    fn parses_background_agent_tasks() {
        let message = parse_server_message(
            r#"{"type":"agent_tasks","tasks":[{"slot":1,"agent":"reviewer","title":"检查认证模块","status":"running","activity":"Reading index.ts","elapsedMs":1200,"unread":false}]}"#,
        );
        assert!(matches!(
            message,
            Some(ServerMessage::AgentTasks { tasks })
                if tasks.len() == 1
                    && tasks[0].slot == 1
                    && tasks[0].title == "检查认证模块"
                    && tasks[0].elapsed_ms == 1200
        ));
    }

    #[test]
    fn serializes_numeric_agent_task_command() {
        let raw = serde_json::to_string(&ClientMessage::AgentTask { slot: 3 })
            .expect("serialize agent task command");
        assert_eq!(raw, r#"{"type":"agent_task","slot":3}"#);
    }

    #[test]
    fn serializes_agent_back_command() {
        let raw = serde_json::to_string(&ClientMessage::AgentBack).expect("serialize agent back");
        assert_eq!(raw, r#"{"type":"agent_back"}"#);
    }

    #[test]
    fn parses_agent_sub_session() {
        let message = parse_server_message(
            r#"{"type":"agent_session","slot":2,"agent":"reviewer","model":"openai/test","history":[{"role":"user","content":"check this"}]}"#,
        );
        assert!(matches!(
            message,
            Some(ServerMessage::AgentSession {
                slot: Some(2),
                agent,
                model: _,
                history,
            }) if agent == "reviewer" && history.len() == 1
        ));
    }
}
