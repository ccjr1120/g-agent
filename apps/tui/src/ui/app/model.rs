use unicode_width::UnicodeWidthChar;

use crate::ui::composer::SlashCommand;

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

#[derive(Debug, Clone)]
pub struct PlanStep {
    pub(super) text: String,
    pub(super) status: String,
}

#[derive(Debug, Clone)]
pub struct PlanDisplay {
    pub(super) steps: Vec<PlanStep>,
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
    use super::{agent_task_is_busy, format_plan_message, parse_plan, truncate_to_width};

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
}
