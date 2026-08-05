use super::model::{agent_task_is_busy, agent_task_is_running};
use super::*;

impl App {
    pub(super) fn switch_agent_session(
        &mut self,
        slot: Option<u64>,
        agent: String,
        model: String,
        history: Vec<ConversationTurn>,
        active_turn: Option<ActiveAgentTurn>,
    ) {
        self.commit_streaming_line();
        if self.active_child.is_none() {
            self.main_lines = std::mem::take(&mut self.static_lines);
        } else {
            self.static_lines.clear();
        }

        self.active_child = slot;
        self.view_agent = agent;
        self.model = model;
        self.static_lines = if slot.is_none() {
            std::mem::take(&mut self.main_lines)
        } else {
            history
                .into_iter()
                .map(|turn| ChatLine {
                    role: turn.role,
                    text: turn.content.clone(),
                    sent_content: Some(turn.content),
                    thinking: turn.thinking,
                    tools: turn
                        .tools
                        .into_iter()
                        .map(|tool| ToolCallDisplay {
                            label: format_tool_call(&tool.name, &tool.args),
                            name: tool.name,
                            status: ToolStatus::Done,
                        })
                        .collect(),
                    duration_ms: turn.duration_ms,
                    queued: false,
                })
                .collect()
        };
        self.streaming = active_turn.map(|turn| ChatLine {
            role: "assistant".to_string(),
            text: turn.content,
            sent_content: None,
            thinking: turn.thinking,
            tools: turn
                .tools
                .into_iter()
                .map(|tool| ToolCallDisplay {
                    label: format_tool_call(&tool.name, &tool.args),
                    name: tool.name,
                    status: ToolStatus::Running,
                })
                .collect(),
            duration_ms: None,
            queued: false,
        });
        self.pending = false;
        self.streaming_flag = false;
        self.turn_start = None;
        self.tool_start = None;
        self.in_flight = None;
        self.send_queue.clear();
        self.streaming_md.reset();
        self.markdown_cache.clear();
        self.history_scroll = 0;
        self.reset_panel_scroll();
        self.restore_active_child_progress();
        self.rebuild_commands();
    }

    /// Rebuild the transient progress display when returning to a child that
    /// kept running in the background. The server remains the source of truth
    /// for task state; streamed text itself is restored from session history
    /// once the turn completes.
    pub(super) fn restore_active_child_progress(&mut self) {
        let Some(slot) = self.active_child else {
            return;
        };
        let Some(task) = self.agent_tasks.iter().find(|task| task.slot == slot) else {
            return;
        };
        let status = task.status.clone();
        let elapsed =
            Duration::from_millis(task.elapsed_ms).saturating_add(if agent_task_is_busy(&status) {
                self.agent_tasks_updated_at.elapsed()
            } else {
                Duration::ZERO
            });

        match status.as_str() {
            "queued" | "starting" => {
                self.pending = true;
                self.turn_start = Instant::now().checked_sub(elapsed);
            }
            status if agent_task_is_running(status) => {
                self.pending = false;
                self.streaming_flag = true;
                // Reconstruct the original turn start from the server snapshot
                // so switching away and back does not reset the visible timer.
                self.turn_start = Instant::now().checked_sub(elapsed);
                self.streaming.get_or_insert_with(|| ChatLine {
                    role: "assistant".to_string(),
                    text: String::new(),
                    sent_content: None,
                    thinking: String::new(),
                    tools: Vec::new(),
                    duration_ms: None,
                    queued: false,
                });
            }
            _ => {}
        }
    }

    pub(super) fn apply_session(&mut self, session: SavedSession) {
        self.session_id = Some(session.id);
        self.session_started_at = session.started_at;
        self.static_lines = session
            .history
            .into_iter()
            .map(|turn| ChatLine {
                role: turn.role,
                text: turn.content.clone(),
                sent_content: Some(turn.content),
                thinking: String::new(),
                tools: Vec::new(),
                duration_ms: None,
                queued: false,
            })
            .collect();
        self.streaming = None;
        self.pending = false;
        self.streaming_flag = false;
        self.streaming_md.reset();
        self.markdown_cache.clear();
    }

    pub(super) fn persist_session(&mut self) {
        if self.active_child.is_some() {
            return;
        }
        if self.static_lines.is_empty() || self.active_agent.is_empty() {
            return;
        }
        let history = self
            .static_lines
            .iter()
            .filter(|line| matches!(line.role.as_str(), "user" | "assistant"))
            .map(|line| ConversationTurn {
                role: line.role.clone(),
                content: line
                    .sent_content
                    .clone()
                    .unwrap_or_else(|| line.text.clone()),
                thinking: String::new(),
                tools: Vec::new(),
                duration_ms: line.duration_ms,
            })
            .filter(|turn| !turn.content.trim().is_empty())
            .collect::<Vec<_>>();
        if history.is_empty() {
            return;
        }
        if self.session_id.is_none() {
            self.session_id = Some(uuid::Uuid::new_v4().to_string());
            self.session_started_at = chrono::Utc::now().timestamp();
        }
        let session = SavedSession {
            id: self.session_id.clone().unwrap_or_default(),
            agent: self.active_agent.clone(),
            model: self.model.clone(),
            started_at: self.session_started_at,
            updated_at: chrono::Utc::now().timestamp(),
            preview: build_session_preview(&history),
            turn_count: history.len() as u64,
            history,
        };
        let _ = save_session(&session);
        self.saved_sessions = list_sessions().unwrap_or_default();
        self.rebuild_commands();
    }
}
