use unicode_width::UnicodeWidthChar;

use crate::protocol::McpServerInfo;
use crate::ui::composer::SlashCommand;

pub(super) use crate::agent::client::{PlanDisplay, PlanStep};

#[derive(Debug, Clone)]
pub enum PendingSessionOpen {
    Task(u64),
}

/// Which region has keyboard focus. Panels are scrollable when focused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PanelFocus {
    #[default]
    Transcript,
    Scheduled,
    Tasks,
}

/// A blocking `ask_user` question awaiting a reply, with the discrete choices
/// the agent offered (empty when it asked an open question). `selected` tracks
/// the highlighted option so the user can pick with ↑/↓ + Enter instead of
/// typing, while still being able to type a custom answer.
#[derive(Debug, Clone)]
pub struct PendingAsk {
    /// Server-assigned id echoed back in `ask_user_reply` so several pending
    /// questions can be answered independently.
    pub id: String,
    pub question: String,
    pub options: Vec<String>,
    pub selected: usize,
}

impl PendingAsk {
    pub fn has_options(&self) -> bool {
        !self.options.is_empty()
    }

    pub fn move_selection(&mut self, delta: isize) {
        let len = self.options.len();
        if len == 0 {
            self.selected = 0;
            return;
        }
        self.selected =
            (self.selected as isize + delta).rem_euclid(len as isize) as usize;
    }
}

pub(super) fn copy_to_clipboard(text: &str) -> bool {
    arboard::Clipboard::new()
        .and_then(|mut clip| clip.set_text(text.to_owned()))
        .is_ok()
}

pub(super) fn should_remember_prompt(text: &str) -> bool {
    let trimmed = text.trim();
    !trimmed.is_empty() && !trimmed.starts_with('/') && trimmed != "exit"
}

pub(super) fn agent_task_is_running(status: &str) -> bool {
    matches!(
        status,
        "thinking" | "tool_running" | "responding" | "running"
    )
}

pub(super) fn agent_task_is_busy(status: &str) -> bool {
    matches!(status, "queued" | "starting") || agent_task_is_running(status)
}

pub(super) fn parse_plan(args: &str) -> Option<PlanDisplay> {
    let value = serde_json::from_str::<serde_json::Value>(args).ok()?;
    let steps = value
        .get("steps")?
        .as_array()?
        .iter()
        .filter_map(|item| {
            let text = item.get("step")?.as_str()?.trim();
            let status = item.get("status")?.as_str()?;
            if text.is_empty() || !matches!(status, "pending" | "in_progress" | "completed") {
                return None;
            }
            Some(PlanStep {
                text: text.to_string(),
                status: status.to_string(),
            })
        })
        .collect::<Vec<_>>();

    (!steps.is_empty()).then_some(PlanDisplay { steps })
}

/// Render a completed plan as plain transcript text (e.g. "Plan · 3/3").
pub(super) fn format_plan_message(plan: &PlanDisplay) -> String {
    let mut lines = vec![format!("Plan · {}/{}", plan.steps.len(), plan.steps.len())];
    for step in &plan.steps {
        lines.push(format!("  ✓ {}", step.text));
    }
    lines.join("\n")
}

/// Describe one MCP server for `/mcp <name>`: a header line with source,
/// transport and connection status, followed by the tools it exposes so the
/// user sees what a server can actually do after picking it.
pub(super) fn format_mcp_server_detail(server: &McpServerInfo) -> String {
    let status = if server.connected {
        format!("connected, {} tools", server.tool_count)
    } else if server.auth_required {
        "auth required".into()
    } else {
        format!(
            "not connected{}",
            server
                .error
                .as_deref()
                .map(|error| format!(": {error}"))
                .unwrap_or_default()
        )
    };
    let mut out = format!(
        "[{}] {} ({}) — {}\n",
        server.source, server.name, server.transport, status
    );
    if !server.connected || server.tools.is_empty() {
        return out;
    }
    for tool in &server.tools {
        let description = tool.description.split_whitespace().collect::<Vec<_>>().join(" ");
        if description.is_empty() {
            out.push_str(&format!("  · {}\n", tool.name));
        } else {
            out.push_str(&format!(
                "  · {} — {}\n",
                tool.name,
                truncate_to_width(&description, 80)
            ));
        }
    }
    out
}

pub(super) fn truncate_to_width(text: &str, max_width: usize) -> String {
    if max_width == 0 {
        return String::new();
    }
    let width = text
        .chars()
        .map(|ch| UnicodeWidthChar::width(ch).unwrap_or(0))
        .sum::<usize>();
    if width <= max_width {
        return text.to_string();
    }
    if max_width == 1 {
        return "…".into();
    }
    let target = max_width - 1;
    let mut used = 0;
    let mut output = String::new();
    for ch in text.chars() {
        let ch_width = UnicodeWidthChar::width(ch).unwrap_or(0);
        if used + ch_width > target {
            break;
        }
        output.push(ch);
        used += ch_width;
    }
    output.push('…');
    output
}

pub(super) fn format_mmss(ms: u64) -> String {
    let seconds = ms / 1_000;
    format!("{:02}:{:02}", seconds / 60, seconds % 60)
}

/// Argument candidates for commands like `/agent <name>`: filter by the
/// partial argument the user has typed so far (matched against the last
/// whitespace-separated token of the candidate value).
pub(super) fn filter_argument_items(
    candidates: impl Iterator<Item = SlashCommand>,
    partial: &str,
) -> Vec<SlashCommand> {
    let needle = partial.trim().to_lowercase();
    candidates
        .filter(|item| {
            if needle.is_empty() {
                return true;
            }
            item.value
                .rsplit(' ')
                .next()
                .is_some_and(|arg| arg.to_lowercase().contains(&needle))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        agent_task_is_busy, format_mcp_server_detail, format_plan_message, parse_plan, PendingAsk,
        truncate_to_width,
    };
    use crate::protocol::{McpServerInfo, McpToolInfo};

    fn server(name: &str, connected: bool, tools: Vec<McpToolInfo>) -> McpServerInfo {
        McpServerInfo {
            name: name.to_string(),
            source: "global".into(),
            transport: "url".into(),
            target: "http://localhost:7077/mcp".into(),
            connected,
            error: None,
            tool_count: tools.len() as u64,
            tools,
            oauth: false,
            auth_required: false,
        }
    }

    #[test]
    fn mcp_detail_lists_the_servers_tools() {
        let detail = format_mcp_server_detail(&server(
            "knowledge-mcp",
            true,
            vec![
                McpToolInfo {
                    name: "search_code".into(),
                    description: "Search the code knowledge base".into(),
                },
                McpToolInfo {
                    name: "list_projects".into(),
                    description: String::new(),
                },
            ],
        ));
        assert!(detail.contains("connected, 2 tools"));
        assert!(detail.contains("· search_code — Search the code knowledge base"));
        assert!(detail.contains("· list_projects"), "tools without a description still appear");
    }

    #[test]
    fn mcp_detail_does_not_list_tools_when_disconnected() {
        let detail = format_mcp_server_detail(&server("offline-mcp", false, vec![McpToolInfo {
            name: "do_thing".into(),
            description: "never reachable".into(),
        }]));
        assert!(detail.contains("not connected"));
        assert!(!detail.contains("do_thing"), "disconnected servers expose no tools");
    }

    #[test]
    fn truncates_wide_agent_titles_with_ellipsis() {
        assert_eq!(
            truncate_to_width("调查大家对 vibe coding 的看法", 12),
            "调查大家对 …"
        );
        assert_eq!(truncate_to_width("short", 12), "short");
    }

    #[test]
    fn background_progress_states_keep_the_transcript_waiting() {
        for status in [
            "queued",
            "starting",
            "thinking",
            "tool_running",
            "responding",
            "running",
        ] {
            assert!(agent_task_is_busy(status), "{status}");
        }
        for status in ["idle", "completed", "failed", "cancelled"] {
            assert!(!agent_task_is_busy(status), "{status}");
        }
    }

    #[test]
    fn parses_structured_plan_for_the_dedicated_panel() {
        let plan = parse_plan(
            r#"{"explanation":"Starting","steps":[{"step":"Inspect UI","status":"completed"},{"step":"Build panel","status":"in_progress"},{"step":"Test","status":"pending"}]}"#,
        )
        .expect("valid plan");

        assert_eq!(plan.steps.len(), 3);
        assert_eq!(plan.steps[1].text, "Build panel");
        assert_eq!(plan.steps[1].status, "in_progress");
    }

    #[test]
    fn formats_completed_plan_as_transcript_message() {
        let plan = parse_plan(
            r#"{"steps":[{"step":"Inspect UI","status":"completed"},{"step":"Build panel","status":"completed"}]}"#,
        )
        .expect("valid completed plan");
        assert_eq!(
            format_plan_message(&plan),
            "Plan · 2/2\n  ✓ Inspect UI\n  ✓ Build panel"
        );
    }

    #[test]
    fn ask_selection_wraps_around_and_ignores_movement_without_options() {
        let mut ask = PendingAsk {
            id: "a1".into(),
            question: "Which DB?".into(),
            options: vec!["postgres".into(), "sqlite".into(), "mysql".into()],
            selected: 0,
        };
        assert!(ask.has_options());
        ask.move_selection(1);
        assert_eq!(ask.selected, 1);
        ask.move_selection(-2);
        assert_eq!(ask.selected, 2, "selection wraps backwards");
        ask.move_selection(1);
        assert_eq!(ask.selected, 0, "selection wraps forward");

        let mut open = PendingAsk {
            id: "a2".into(),
            question: "Anything else?".into(),
            options: Vec::new(),
            selected: 0,
        };
        assert!(!open.has_options());
        open.move_selection(5);
        assert_eq!(open.selected, 0, "no options means no selection to move");
    }
}
