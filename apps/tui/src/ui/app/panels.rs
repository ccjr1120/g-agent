use super::model::{
    agent_task_is_busy, copy_to_clipboard, format_mmss, truncate_to_width, PlanDisplay,
};
use super::*;
use crate::protocol::ScheduledTaskInfo;

impl App {
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
                let (icon, step_style) = match step.status.as_str() {
                    "completed" => ("✓", style::success()),
                    "in_progress" => ("●", style::brand_bold()),
                    _ => ("○", style::muted()),
                };
                let text = truncate_to_width(&step.text, width.saturating_sub(3) as usize);
                Line::from(vec![
                    Span::styled(format!(" {icon} "), step_style),
                    Span::styled(text, step_style),
                ])
            })
            .collect()
    }

    pub(super) fn agent_task_lines(&self, width: u16) -> Vec<Line<'static>> {
        self.agent_tasks
            .iter()
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
                vec![
                    Line::from(vec![
                        Span::styled(prefix, style::brand_bold()),
                        Span::raw(title),
                    ]),
                    Line::from(Span::styled(
                        format!(
                            "   {icon} {} · {} · {:02}:{:02}{activity}{unread}",
                            task.agent,
                            task.status,
                            seconds / 60,
                            seconds % 60,
                        ),
                        if task.status == "failed" {
                            style::error()
                        } else if task.status == "completed" {
                            style::success()
                        } else {
                            style::muted()
                        },
                    )),
                ]
            })
            .collect()
    }

    pub(super) fn visible_scheduled_tasks(&self) -> Vec<&ScheduledTaskInfo> {
        self.scheduled_tasks
            .iter()
            .filter(|task| task.last_status != "cancelled")
            .collect()
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

    pub(super) fn scheduled_task_lines(&self, width: u16) -> Vec<Line<'static>> {
        let now_ms = chrono::Utc::now().timestamp_millis();
        self.visible_scheduled_tasks()
            .iter()
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
                vec![
                    Line::from(vec![
                        Span::styled(prefix, style::brand_bold()),
                        Span::styled(label, style::brand_bold()),
                    ]),
                    Line::from(Span::styled(
                        format!("   {icon} {state} · {summary}{unread}{auth}"),
                        status_style,
                    )),
                ]
            })
            .collect()
    }

    pub(super) fn clamp_history_scroll(&mut self, width: u16, height: u16) {
        self.sync_streaming_markdown(width);
        let content = TranscriptContent {
            lines: &self.static_lines,
            streaming: self.streaming.as_ref(),
            waiting: self.waiting_for_reply(),
            banner: &self.banner,
            show_welcome: self.is_welcome_screen(),
            connecting: matches!(self.connection, ConnectionState::Connecting),
            active_agent: &self.view_agent,
            fallback: None,
            clock: self.started_at,
            turn_start: self.turn_start,
            width,
        };
        let max = max_history_scroll(
            &content,
            &mut self.markdown_cache,
            &self.streaming_md,
            height,
        );
        if self.history_scroll > max {
            self.history_scroll = max;
        }
    }

    pub(super) fn scroll_history(&mut self, delta: i16, transcript_area: Rect) {
        let width = transcript_area.width;
        let height = transcript_area.height;
        self.sync_streaming_markdown(width);
        let content = TranscriptContent {
            lines: &self.static_lines,
            streaming: self.streaming.as_ref(),
            waiting: self.waiting_for_reply(),
            banner: &self.banner,
            show_welcome: self.is_welcome_screen(),
            connecting: matches!(self.connection, ConnectionState::Connecting),
            active_agent: &self.view_agent,
            fallback: None,
            clock: self.started_at,
            turn_start: self.turn_start,
            width,
        };
        let max = max_history_scroll(
            &content,
            &mut self.markdown_cache,
            &self.streaming_md,
            height,
        );
        if max == 0 {
            self.history_scroll = 0;
            return;
        }
        self.history_scroll =
            ((self.history_scroll as i32 + delta as i32).clamp(0, max as i32)) as u16;
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
}
