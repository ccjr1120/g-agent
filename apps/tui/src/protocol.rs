use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const DEFAULT_SERVER_PORT: u16 = 3847;
pub const DEFAULT_SERVER_URL: &str = "ws://127.0.0.1:3847";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationTurn {
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub thinking: String,
    #[serde(default)]
    pub tools: Vec<AgentTurnTool>,
    #[serde(default)]
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnTool {
    pub name: String,
    pub args: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveAgentTurn {
    pub content: String,
    pub thinking: String,
    pub tools: Vec<AgentTurnTool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ClientMessage {
    Chat {
        message: String,
    },
    Cancel,
    Reset,
    #[serde(rename = "ask_user_reply")]
    AskUserReply {
        id: String,
        reply: String,
    },
    Agent {
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
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
    #[serde(rename = "agent_task_close")]
    AgentTaskClose {
        slot: u64,
    },
    Resume {
        agent: String,
        history: Vec<ConversationTurn>,
    },
    #[serde(rename = "scheduled_tasks")]
    ScheduledTasks,
    #[serde(rename = "scheduled_task_cancel")]
    ScheduledTaskCancel {
        id: String,
    },
    #[serde(rename = "scheduled_task_run")]
    ScheduledTaskRun {
        id: String,
    },
    #[serde(rename = "scheduled_task_history")]
    ScheduledTaskHistory {
        id: String,
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
    #[serde(rename = "ask_user")]
    AskUser {
        id: String,
        question: String,
        #[serde(default)]
        options: Vec<String>,
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
    #[serde(rename = "scheduled_tasks")]
    ScheduledTasks {
        tasks: Vec<ScheduledTaskInfo>,
    },
    #[serde(rename = "scheduled_task_update")]
    ScheduledTaskUpdate {
        task: ScheduledTaskInfo,
    },
    #[serde(rename = "scheduled_task_history")]
    ScheduledTaskHistory {
        id: String,
        runs: Vec<ScheduledTaskRun>,
    },
    #[serde(rename = "notice")]
    Notice {
        message: String,
    },
    #[serde(rename = "agent_session")]
    AgentSession {
        #[serde(default)]
        slot: Option<u64>,
        agent: String,
        model: String,
        history: Vec<ConversationTurn>,
        #[serde(default, rename = "activeTurn")]
        active_turn: Option<ActiveAgentTurn>,
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
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskInfo {
    pub id: String,
    pub label: String,
    pub prompt: String,
    pub interval_seconds: u64,
    pub next_run_at: i64,
    pub running: bool,
    #[serde(default)]
    pub last_run_at: Option<i64>,
    pub last_status: String,
    #[serde(default)]
    pub last_summary: Option<String>,
    pub unread: bool,
    #[serde(default)]
    pub auth_required: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskRun {
    pub run_at: i64,
    pub status: String,
    pub summary: String,
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
    fn serializes_agent_with_initial_message() {
        let raw = serde_json::to_string(&ClientMessage::Agent {
            name: Some("think-agent".into()),
            message: Some("analyze the cache".into()),
        })
        .unwrap();
        assert_eq!(
            raw,
            r#"{"type":"agent","name":"think-agent","message":"analyze the cache"}"#
        );
    }

    #[test]
    fn serializes_agent_back_command() {
        let raw = serde_json::to_string(&ClientMessage::AgentBack).expect("serialize agent back");
        assert_eq!(raw, r#"{"type":"agent_back"}"#);
    }

    #[test]
    fn serializes_agent_task_close_command() {
        let raw = serde_json::to_string(&ClientMessage::AgentTaskClose { slot: 2 })
            .expect("serialize agent task close command");
        assert_eq!(raw, r#"{"type":"agent_task_close","slot":2}"#);
    }

    #[test]
    fn parses_agent_sub_session() {
        let message = parse_server_message(
            r#"{"type":"agent_session","slot":2,"agent":"reviewer","model":"openai/test","history":[{"role":"user","content":"check this"}],"activeTurn":{"content":"working","thinking":"inspect","tools":[{"name":"read","args":"{\"path\":\"README.md\"}"}]}}"#,
        );
        assert!(matches!(
            message,
            Some(ServerMessage::AgentSession {
                slot: Some(2),
                agent,
                model: _,
                history,
                active_turn: Some(active_turn),
            }) if agent == "reviewer"
                && history.len() == 1
                && active_turn.content == "working"
                && active_turn.tools[0].name == "read"
        ));
    }

    #[test]
    fn parses_scheduled_tasks_catalog() {
        let message = parse_server_message(
            r#"{"type":"scheduled_tasks","tasks":[{"id":"st01","label":"需求列表","prompt":"fetch requirements","intervalSeconds":600,"nextRunAt":1720000000000,"running":false,"lastStatus":"ok","lastSummary":"新增 2 条需求","unread":true}]}"#,
        );
        assert!(matches!(
            message,
            Some(ServerMessage::ScheduledTasks { tasks })
                if tasks.len() == 1
                    && tasks[0].label == "需求列表"
                    && tasks[0].interval_seconds == 600
                    && tasks[0].last_status == "ok"
                    && tasks[0].unread
        ));
    }

    #[test]
    fn parses_scheduled_task_update() {
        let message = parse_server_message(
            r#"{"type":"scheduled_task_update","task":{"id":"st01","label":"需求列表","prompt":"fetch","intervalSeconds":600,"nextRunAt":1720000000000,"running":false,"lastRunAt":1720000000000,"lastStatus":"ok","lastSummary":"新增 2 条需求","unread":true}}"#,
        );
        assert!(matches!(
            message,
            Some(ServerMessage::ScheduledTaskUpdate { task })
                if task.id == "st01" && task.unread && task.last_run_at == Some(1720000000000)
        ));
    }

    #[test]
    fn serializes_scheduled_task_cancel_command() {
        let raw = serde_json::to_string(&ClientMessage::ScheduledTaskCancel { id: "st01".into() })
            .expect("serialize scheduled task cancel command");
        assert_eq!(raw, r#"{"type":"scheduled_task_cancel","id":"st01"}"#);
    }

    #[test]
    fn serializes_scheduled_task_run_and_history_commands() {
        assert_eq!(
            serde_json::to_string(&ClientMessage::ScheduledTaskRun { id: "st01".into() }).unwrap(),
            r#"{"type":"scheduled_task_run","id":"st01"}"#
        );
        assert_eq!(
            serde_json::to_string(&ClientMessage::ScheduledTaskHistory { id: "st01".into() })
                .unwrap(),
            r#"{"type":"scheduled_task_history","id":"st01"}"#
        );
    }

    #[test]
    fn parses_scheduled_task_history_and_notice() {
        let history = parse_server_message(
            r#"{"type":"scheduled_task_history","id":"st01","runs":[{"runAt":1720000000000,"status":"ok","summary":"no changes"}]}"#,
        );
        assert!(matches!(
            history,
            Some(ServerMessage::ScheduledTaskHistory { id, runs })
                if id == "st01" && runs.len() == 1 && runs[0].status == "ok"
        ));

        let notice =
            parse_server_message(r#"{"type":"notice","message":"Context window reached"}"#);
        assert!(matches!(
            notice,
            Some(ServerMessage::Notice { message }) if message == "Context window reached"
        ));
    }

    #[test]
    fn parses_auth_required_scheduled_task() {
        let message = parse_server_message(
            r#"{"type":"scheduled_tasks","tasks":[{"id":"st01","label":"需求列表","prompt":"fetch","intervalSeconds":600,"nextRunAt":1720000000000,"running":false,"lastStatus":"error","lastSummary":"需要重新登录","unread":true,"authRequired":true}]}"#,
        );
        assert!(matches!(
            message,
            Some(ServerMessage::ScheduledTasks { tasks })
                if tasks[0].auth_required && tasks[0].last_status == "error"
        ));
    }

    #[test]
    fn parses_ask_user_question_from_server() {
        let message = parse_server_message(
            r#"{"type":"ask_user","id":"a1","question":"Which tech stack should I use?"}"#,
        );
        assert!(matches!(
            message,
            Some(ServerMessage::AskUser {
                id,
                question,
                options
            }) if id == "a1" && question == "Which tech stack should I use?" && options.is_empty()
        ));
    }

    #[test]
    fn parses_ask_user_options_from_server() {
        let message = parse_server_message(
            r#"{"type":"ask_user","id":"a2","question":"Which DB?","options":["postgres","sqlite"]}"#,
        );
        assert!(matches!(
            message,
            Some(ServerMessage::AskUser {
                id,
                question,
                options
            }) if id == "a2" && question == "Which DB?" && options == vec!["postgres", "sqlite"]
        ));
    }

    #[test]
    fn serializes_ask_user_reply_command() {
        let raw = serde_json::to_string(&ClientMessage::AskUserReply {
            id: "a1".into(),
            reply: "Rust".into(),
        })
        .expect("serialize ask user reply");
        assert_eq!(raw, r#"{"type":"ask_user_reply","id":"a1","reply":"Rust"}"#);
    }
}
