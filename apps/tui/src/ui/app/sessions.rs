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
                    role: turn.role.clone(),
                    text: turn.content.clone(),
                    sent_content: Some(turn.content.clone()),
                    segments: restored_segments(
                        &turn.role,
                        &turn.content,
                        &turn.thinking,
                        &turn.tools,
                        ToolStatus::Done,
                    ),
                    pending_thinking: String::new(),
                    pending_text: String::new(),
                    duration_ms: turn.duration_ms,
                    queued: false,
                })
                .collect()
        };
        self.streaming = active_turn.map(|turn| ChatLine {
            role: "assistant".to_string(),
            text: turn.content.clone(),
            sent_content: None,
            segments: restored_segments(
                "assistant",
                &turn.content,
                &turn.thinking,
                &turn.tools,
                ToolStatus::Running,
            ),
            pending_thinking: String::new(),
            pending_text: String::new(),
            duration_ms: None,
            queued: false,
        });
        self.pending = false;
        self.streaming_flag = false;
        self.turn_start = None;
        self.tool_start = None;
        self.in_flight = None;
        self.send_queue.clear();
                self.markdown_cache.clear();
        self.history_scroll = 0;
        self.scroll_anchor_y = None;
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
                    segments: Vec::new(),
                    pending_thinking: String::new(),
                    pending_text: String::new(),
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
                segments: Vec::new(),
                pending_thinking: String::new(),
                pending_text: String::new(),
                duration_ms: None,
                queued: false,
            })
            .collect();
        self.streaming = None;
        self.pending = false;
        self.streaming_flag = false;
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

/// Reconstruct ordered segments for a restored turn. The server stores
/// reasoning, body text and tools in separate fields (no interleaving
/// information), so the body text is placed between the reasoning and the tool
/// calls — the shape agents actually run (reason first, then announce work in
/// text, then call tools). This keeps the reply from being dumped after every
/// tool call.
pub(crate) fn restored_segments(
    role: &str,
    content: &str,
    thinking: &str,
    tools: &[crate::protocol::AgentTurnTool],
    status: ToolStatus,
) -> Vec<TurnSegment> {
    let mut segments = Vec::new();
    if !thinking.trim().is_empty() {
        segments.push(TurnSegment::Thinking(thinking.to_string()));
    }
    if role == "assistant" && !content.trim().is_empty() {
        segments.push(TurnSegment::Text(content.to_string()));
    }
    for tool in tools {
        segments.push(TurnSegment::Tool(ToolCallDisplay {
            name: tool.name.clone(),
            label: format_tool_call(&tool.name, &tool.args),
            status,
        }));
    }
    segments
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restored_segments_place_text_before_tools() {
        let segments = restored_segments(
            "assistant",
            "Here is the reply",
            "Some reasoning",
            &[crate::protocol::AgentTurnTool {
                name: "read".into(),
                args: "{\"path\":\"README.md\"}".into(),
            }],
            ToolStatus::Done,
        );
        assert!(matches!(segments[0], TurnSegment::Thinking(_)));
        assert!(matches!(&segments[1], TurnSegment::Text(t) if t == "Here is the reply"));
        assert!(matches!(segments[2], TurnSegment::Tool(_)));
    }

    #[test]
    fn restored_user_turn_omits_text_segment() {
        let segments = restored_segments(
            "user",
            "hello",
            "",
            &[],
            ToolStatus::Done,
        );
        assert!(segments.is_empty(), "user turns carry no display segments");
    }
}
