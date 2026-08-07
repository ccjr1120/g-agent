use super::model::{
    agent_task_is_busy, copy_to_clipboard, format_mmss, truncate_to_width, PlanDisplay,
};
use super::*;
use crate::protocol::ScheduledTaskInfo;
use ratatui::style::Style;
use unicode_width::UnicodeWidthStr;

impl App {
    /// Render the pending `ask_user` question as a dedicated panel: the
    /// question (wrapped), its selectable options (highlighted), and a
    /// navigation hint. The panel is the interactive surface for answering —
    /// the transcript keeps the question as a historical record.
    pub(super) fn ask_panel_lines(&self, width: u16) -> Vec<Line<'static>> {
        let Some(ask) = self.active_ask() else {
            return Vec::new();
        };
        ask_panel_lines(ask, width)
    }

    /// Height of the Ask panel: wrapped question + options (or type hint) +
    /// navigation hint + 2 border rows, capped so it never dominates.
    pub(super) fn ask_panel_height(&self, width: u16) -> u16 {
        let Some(ask) = self.active_ask() else {
            return 0;
        };
        ask_panel_height(ask, width)
    }

    pub(super) fn active_plan_key(&self) -> u64 {
        self.active_child.unwrap_or(0)
    }

    pub(super) fn active_plan(&self) -> Option<&PlanDisplay> {
        self.plans.get(&self.active_plan_key())
    }

    pub(super) fn plan_lines(&self, plan: &PlanDisplay, width: u16) -> Vec<Line<'static>> {
        let visible = plan.steps.len().min(5);
        let active_index = plan
            .steps
            .iter()
            .position(|step| step.status == "in_progress")
            .unwrap_or_else(|| plan.steps.len().saturating_sub(1));
        let start = active_index
            .saturating_sub(2)
            .min(plan.steps.len().saturating_sub(visible));

        plan.steps
            .iter()
            .skip(start)
            .take(visible)
            .map(|step| {
                let text = truncate_to_width(&step.text, width.saturating_sub(3) as usize);
                Line::from(plan_step_spans(step, &text))
            })
            .collect()
    }

    pub(super) fn agent_task_lines(&self, width: u16, scroll: u16) -> Vec<Line<'static>> {
        self.visible_agent_tasks()
            .iter()
            .skip(scroll as usize)
            .take(3)
            .flat_map(|task| {
                let icon = match task.status.as_str() {
                    "completed" => "✓",
                    "failed" => "✗",
                    "cancelled" => "–",
                    "queued" => "◌",
                    "idle" => "○",
                    _ => "●",
                };
                let title = if task.title.trim().is_empty() {
                    "Waiting for first message".to_string()
                } else {
                    task.title.split_whitespace().collect::<Vec<_>>().join(" ")
                };
                let prefix = format!("/{} ", task.slot);
                let title =
                    truncate_to_width(&title, width.saturating_sub(prefix.len() as u16) as usize);
                let live_elapsed_ms =
                    task.elapsed_ms
                        .saturating_add(if agent_task_is_busy(&task.status) {
                            self.agent_tasks_updated_at.elapsed().as_millis() as u64
                        } else {
                            0
                        });
                let seconds = live_elapsed_ms / 1_000;
                let unread = if task.unread { " · unread" } else { "" };
                let activity = task
                    .activity
                    .as_deref()
                    .map(|value| format!(" · {value}"))
                    .unwrap_or_default();
                let status_style = if task.status == "failed" {
                    style::error()
                } else if task.status == "completed" {
                    style::success()
                } else {
                    style::muted()
                };
                let mut title_spans = vec![Span::styled(prefix, style::brand_bold())];
                title_spans.extend(render_inline_markdown(&title, Style::default()));
                let mut activity_spans = vec![Span::styled(
                    format!(
                        "   {icon} {} · {} · {:02}:{:02}",
                        task.agent,
                        task.status,
                        seconds / 60,
                        seconds % 60,
                    ),
                    status_style,
                )];
                activity_spans.extend(render_inline_markdown(&activity, status_style));
                activity_spans.push(Span::styled(unread, status_style));
                vec![Line::from(title_spans), Line::from(activity_spans)]
            })
            .collect()
    }

    pub(super) fn visible_scheduled_tasks(&self) -> Vec<&ScheduledTaskInfo> {
        self.scheduled_tasks
            .iter()
            .filter(|task| task.last_status != "cancelled")
            .collect()
    }

    /// Sub-agent sessions shown in the panel: everything except the one
    /// currently being viewed, which is hidden while it has the transcript.
    pub(super) fn visible_agent_tasks(&self) -> Vec<&crate::protocol::AgentTaskInfo> {
        match self.active_child {
            Some(active) => self
                .agent_tasks
                .iter()
                .filter(|task| task.slot != active)
                .collect(),
            None => self.agent_tasks.iter().collect(),
        }
    }

    /// Resolve a panel argument (1-based number or raw id) to (id, label).
    pub(super) fn resolve_scheduled_task(&self, arg: &str) -> Option<(String, String)> {
        if let Ok(index) = arg.parse::<usize>() {
            return self
                .visible_scheduled_tasks()
                .get(index.saturating_sub(1))
                .map(|task| (task.id.clone(), task.label.clone()));
        }
        self.visible_scheduled_tasks()
            .iter()
            .find(|task| task.id == arg)
            .map(|task| (task.id.clone(), task.label.clone()))
    }

    pub(super) fn show_scheduled_task_history(
        &mut self,
        id: &str,
        runs: &[crate::protocol::ScheduledTaskRun],
    ) {
        let label = self
            .scheduled_tasks
            .iter()
            .find(|task| task.id == id)
            .map(|task| task.label.clone())
            .unwrap_or_else(|| id.to_string());
        if runs.is_empty() {
            self.add_local(format!("Scheduled task \"{label}\" has no recorded runs"));
            return;
        }
        let lines = runs
            .iter()
            .map(|run| {
                let time = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(run.run_at)
                    .map(|value| value.format("%m-%d %H:%M").to_string())
                    .unwrap_or_default();
                format!("  - {time} · {} · {}", run.status, run.summary)
            })
            .collect::<Vec<_>>()
            .join("\n");
        self.add_local(format!("Run history for \"{label}\":\n{lines}"));
    }

    pub(super) fn scheduled_task_lines(&self, width: u16, scroll: u16) -> Vec<Line<'static>> {
        let now_ms = chrono::Utc::now().timestamp_millis();
        self.visible_scheduled_tasks()
            .iter()
            .skip(scroll as usize)
            .take(3)
            .flat_map(|task| {
                let icon = match task.last_status.as_str() {
                    "running" => "●",
                    "ok" => "✓",
                    "error" => "✗",
                    _ => "○",
                };
                let state = if task.running {
                    let elapsed = task
                        .last_run_at
                        .map(|at| (now_ms - at).max(0) as u64)
                        .unwrap_or(0);
                    format!("running · {}", format_mmss(elapsed))
                } else {
                    let remaining = (task.next_run_at - now_ms).max(0) as u64;
                    format!("{} · next {}", task.last_status, format_mmss(remaining))
                };
                let summary = task.last_summary.clone().unwrap_or_default();
                let summary = truncate_to_width(&summary, width.saturating_sub(18) as usize);
                let unread = if task.unread { " · 更新" } else { "" };
                let auth = if task.auth_required {
                    " · 需重新登录"
                } else {
                    ""
                };
                let prefix = "- ";
                let label = truncate_to_width(
                    &task.label,
                    width.saturating_sub(prefix.len() as u16 + 3) as usize,
                );
                let status_style = if task.auth_required {
                    style::warning()
                } else if task.last_status == "error" {
                    style::error()
                } else if task.unread {
                    style::warning()
                } else {
                    style::muted()
                };
                let mut summary_spans =
                    vec![Span::styled(format!("   {icon} {state} · "), status_style)];
                summary_spans.extend(render_inline_markdown(&summary, status_style));
                summary_spans.push(Span::styled(format!("{unread}{auth}"), status_style));
                vec![
                    Line::from(vec![
                        Span::styled(prefix, style::brand_bold()),
                        Span::styled(label, style::brand_bold()),
                    ]),
                    Line::from(summary_spans),
                ]
            })
            .collect()
    }

    pub(super) fn clamp_history_scroll(&mut self, width: u16, height: u16) {
        let content = TranscriptContent {
            lines: &self.static_lines,
            streaming: self.streaming.as_ref(),
            waiting: self.turn_active(),
            banner: &self.banner,
            show_welcome: self.is_welcome_screen(),
            connecting: matches!(self.connection, ConnectionState::Connecting),
            disconnected: matches!(self.connection, ConnectionState::Disconnected),
            active_agent: &self.view_agent,
            fallback: None,
            clock: self.started_at,
            turn_start: self.turn_start,
            tool_elapsed: self.tool_start,
            expand_thinking: self.expand_thinking,
            ask: self.pending_asks.get(self.active_ask),
            width,
        };
        let max = max_history_scroll(&content, &mut self.markdown_cache, height);
        if let Some(anchor) = self.scroll_anchor_y {
            // Keep the viewport top pinned while the user is reading history:
            // new content appended at the bottom grows the distance below but
            // must not shift (or yank to) the bottom.
            match anchored_offset(max, anchor) {
                Some(offset) => self.history_scroll = offset,
                None => {
                    self.history_scroll = 0;
                    self.scroll_anchor_y = None;
                }
            }
            return;
        }
        if self.history_scroll > max {
            self.history_scroll = max;
        }
    }

    pub(super) fn scroll_history(&mut self, delta: i16, transcript_area: Rect) {
        let width = transcript_area.width;
        let height = transcript_area.height;
        let content = TranscriptContent {
            lines: &self.static_lines,
            streaming: self.streaming.as_ref(),
            waiting: self.turn_active(),
            banner: &self.banner,
            show_welcome: self.is_welcome_screen(),
            connecting: matches!(self.connection, ConnectionState::Connecting),
            disconnected: matches!(self.connection, ConnectionState::Disconnected),
            active_agent: &self.view_agent,
            fallback: None,
            clock: self.started_at,
            turn_start: self.turn_start,
            tool_elapsed: self.tool_start,
            expand_thinking: self.expand_thinking,
            ask: self.pending_asks.get(self.active_ask),
            width,
        };
        let max = max_history_scroll(&content, &mut self.markdown_cache, height);
        if max == 0 {
            self.history_scroll = 0;
            self.scroll_anchor_y = None;
            return;
        }
        self.history_scroll =
            ((self.history_scroll as i32 + delta as i32).clamp(0, max as i32)) as u16;
        // Anchor the viewport top to the row just shown so content streaming in
        // below keeps this position instead of pushing the view.
        self.scroll_anchor_y = if self.history_scroll > 0 {
            Some(max.saturating_sub(self.history_scroll))
        } else {
            None
        };
    }

    pub(super) fn copy_last_reply(&mut self) {
        let text = self
            .streaming
            .as_ref()
            .map(|line| line.text.clone())
            .or_else(|| {
                self.static_lines
                    .iter()
                    .rev()
                    .find(|line| line.role == "assistant")
                    .map(|line| line.text.clone())
            });
        let Some(text) = text.filter(|value| !value.trim().is_empty()) else {
            self.add_status("Nothing to copy".into());
            return;
        };
        if copy_to_clipboard(&text) {
            self.add_status("Copied last reply".into());
        } else {
            self.add_error("Copy failed".into());
        }
    }

    /// Maximum scroll offset (in task rows) for the currently focused panel.
    pub(super) fn focused_panel_max_scroll(&self) -> u16 {
        match self.panel_focus {
            PanelFocus::Scheduled => self.visible_scheduled_tasks().len().saturating_sub(3) as u16,
            PanelFocus::Tasks => self.visible_agent_tasks().len().saturating_sub(3) as u16,
            PanelFocus::Transcript => 0,
        }
    }

    pub(super) fn scroll_focused_panel(&mut self, delta: i16) {
        let max = self.focused_panel_max_scroll();
        let target = match self.panel_focus {
            PanelFocus::Scheduled => &mut self.scheduled_scroll,
            PanelFocus::Tasks => &mut self.task_scroll,
            PanelFocus::Transcript => return,
        };
        *target = ((*target as i32 + delta as i32).clamp(0, max as i32)) as u16;
    }

    /// Move keyboard focus to the next visible panel, wrapping back to the
    /// transcript (and resetting panel scroll positions when returning).
    pub(super) fn cycle_panel_focus(&mut self) {
        let candidates = [
            (
                PanelFocus::Scheduled,
                !self.visible_scheduled_tasks().is_empty(),
            ),
            (PanelFocus::Tasks, !self.visible_agent_tasks().is_empty()),
        ];
        let start = match self.panel_focus {
            PanelFocus::Transcript => 0,
            focus => candidates
                .iter()
                .position(|(kind, _)| *kind == focus)
                .map(|index| index + 1)
                .unwrap_or(0),
        };
        for (kind, visible) in candidates.iter().cycle().skip(start) {
            if *visible {
                self.panel_focus = *kind;
                return;
            }
        }
        self.panel_focus = PanelFocus::Transcript;
    }

    /// When focus leaves the transcript, reset panel scroll positions so the
    /// next entry starts from the top.
    pub(super) fn reset_panel_scroll(&mut self) {
        self.panel_focus = PanelFocus::Transcript;
        self.scheduled_scroll = 0;
        self.task_scroll = 0;
    }
}

/// The offset-from-bottom that keeps the viewport top pinned at `anchor` for
/// the current total scroll range `max`. `None` when content shrank past the
/// anchor — then the transcript should follow the bottom again.
fn anchored_offset(max: u16, anchor: u16) -> Option<u16> {
    let offset = max.saturating_sub(anchor.min(max));
    (offset > 0).then_some(offset)
}

/// Render the pending `ask_user` question as a dedicated panel: the
/// question (wrapped), its selectable options (highlighted), and a
/// navigation hint. The panel is the interactive surface for answering —
/// the transcript keeps the question as a historical record.
fn ask_panel_lines(ask: &PendingAsk, width: u16) -> Vec<Line<'static>> {
    let inner = width.saturating_sub(2) as usize;
    let mut lines = Vec::new();
    for chunk in wrap_text_rows(&ask.question, inner) {
        lines.push(Line::from(vec![
            Span::styled("? ", style::ask()),
            Span::styled(chunk.to_string(), style::ask()),
        ]));
    }
    if ask.options.is_empty() {
        lines.push(Line::from(Span::styled(
            "Type your answer and press Enter (Esc to skip)",
            style::ask_hint(),
        )));
    } else {
        for (index, option) in ask.options.iter().enumerate() {
            let selected = index == ask.selected;
            let style = if selected { style::ask() } else { style::ask_hint() };
            let marker = if selected { "❯ " } else { "  " };
            lines.push(Line::from(vec![
                Span::styled(marker.to_string(), style),
                Span::styled(
                    truncate_to_width(option, inner.saturating_sub(2) as usize),
                    style,
                ),
            ]));
        }
        lines.push(Line::from(Span::styled(
            "←/→ question · ↑/↓ select · Enter answer · Esc skip",
            style::ask_hint(),
        )));
    }
    lines
}

/// Height of the Ask panel: wrapped question + options (or type hint) +
/// navigation hint + 2 border rows, capped so it never dominates.
fn ask_panel_height(ask: &PendingAsk, width: u16) -> u16 {
    let inner = width.saturating_sub(2) as usize;
    let question_rows = wrap_text_rows(&ask.question, inner).len();
    let option_rows = if ask.options.is_empty() { 1 } else { ask.options.len() };
    (question_rows + option_rows + 1).min(8) as u16 + 2
}

/// Split `text` into rows that each fit within `max_width` cells, breaking at
/// character boundaries (used for the Ask panel so a long question wraps
/// instead of overflowing the bordered box).
fn wrap_text_rows(text: &str, max_width: usize) -> Vec<String> {
    if max_width == 0 {
        return vec![String::new()];
    }
    let mut rows = Vec::new();
    let mut current = String::new();
    let mut used = 0usize;
    for ch in text.chars() {
        let piece = if ch == '\t' { "    " } else { &ch.to_string() };
        let piece_width = piece.width();
        if used + piece_width > max_width && used > 0 {
            rows.push(std::mem::take(&mut current));
            used = 0;
        }
        current.push_str(piece);
        used += piece_width;
    }
    if !current.is_empty() || rows.is_empty() {
        rows.push(current);
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::super::model::PendingAsk;
    use super::{anchored_offset, ask_panel_height, ask_panel_lines, wrap_text_rows};
    use super::super::Line;

    #[test]
    fn wrap_text_rows_folds_long_questions_without_losing_chars() {
        let text = "Which database engine should we use for the knowledge base?";
        let rows = wrap_text_rows(text, 20);
        assert!(rows.len() > 1, "long text should wrap into several rows");
        assert_eq!(
            rows.iter().map(|row| row.chars().count()).max().unwrap() <= 20,
            true
        );
        assert_eq!(rows.join(""), text, "wrapping must not drop or add characters");
    }

    #[test]
    fn wrap_text_handles_zero_width_as_single_row() {
        assert_eq!(wrap_text_rows("anything", 0), vec!["".to_string()]);
        assert_eq!(wrap_text_rows("", 10), vec!["".to_string()]);
    }

    fn ask(id: &str, question: &str, options: Vec<&str>, selected: usize) -> PendingAsk {
        PendingAsk {
            id: id.into(),
            question: question.into(),
            options: options.into_iter().map(str::to_string).collect(),
            selected,
        }
    }

    fn render_text(lines: &[Line<'static>]) -> String {
        lines
            .iter()
            .flat_map(|line| line.spans.iter())
            .map(|span| span.content.as_ref())
            .collect()
    }

    #[test]
    fn ask_panel_highlights_the_selected_option() {
        let lines = ask_panel_lines(&ask("q1", "Which DB?", vec!["postgres", "sqlite"], 1), 60);
        let text = render_text(&lines);
        assert!(text.contains("Which DB?"));
        assert!(text.contains("❯ sqlite"), "selected option is highlighted");
        assert!(text.contains("postgres"));
        let selected_pos = text.find('❯').unwrap();
        assert!(selected_pos > text.find("Which DB?").unwrap());
    }

    #[test]
    fn ask_panel_without_options_asks_the_user_to_type() {
        let lines = ask_panel_lines(&ask("q1", "Tell me more", vec![], 0), 60);
        assert!(render_text(&lines).contains("Type your answer"));
    }

    #[test]
    fn ask_panel_height_scales_with_option_count() {
        let open = ask("q1", "Explain", vec![], 0);
        let with_two = ask("q1", "Explain", vec!["a", "b"], 0);
        assert!(
            ask_panel_height(&with_two, 60) > ask_panel_height(&open, 60),
            "options make the panel taller than a plain open question"
        );
    }

    #[test]
    fn new_content_grows_the_offset_below_without_moving_the_view() {
        // Viewport pinned 10 rows from the bottom of a 100-row range.
        let anchor = 90;
        assert_eq!(anchored_offset(100, anchor), Some(10));
        // Streaming adds 30 rows: the pinned top keeps showing the same
        // content; only the "rows below" count grows.
        assert_eq!(anchored_offset(130, anchor), Some(40));
        assert_eq!(anchored_offset(160, anchor), Some(70));
    }

    #[test]
    fn pinned_at_the_top_stays_at_the_top() {
        // User scrolled to the very top: viewport top is row 0.
        assert_eq!(anchored_offset(100, 0), Some(100));
        assert_eq!(anchored_offset(200, 0), Some(200));
    }

    #[test]
    fn content_shrinking_past_the_anchor_returns_to_following() {
        // Content got shorter than the pinned position — drop the pin.
        assert_eq!(anchored_offset(50, 90), None);
    }
}
