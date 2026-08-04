use super::model::{format_plan_message, parse_plan, PendingSessionOpen};
use super::*;

impl App {
    pub(super) fn handle_agent_event(&mut self, event: AgentEvent) {
        match event {
            AgentEvent::Connection(state) => {
                if matches!(state, ConnectionState::Disconnected) {
                    self.interrupt_turn_on_disconnect();
                }
                if matches!(state, ConnectionState::Connected) {
                    if self.has_connected_once {
                        self.restore_history_after_reconnect();
                    }
                    self.has_connected_once = true;
                }
                self.connection = state;
            }
            AgentEvent::Agents {
                agents,
                active,
                model,
            } => {
                self.agents = agents;
                self.active_agent = active;
                if self.active_child.is_none() {
                    self.view_agent = self.active_agent.clone();
                }
                self.model = model;
                self.rebuild_commands();
            }
            AgentEvent::Skills(skills) => {
                self.skills = skills;
                self.rebuild_commands();
            }
            AgentEvent::Mcp(servers) => {
                self.mcp_servers = servers;
                self.rebuild_commands();
            }
            AgentEvent::Context(context) => self.context = context,
            AgentEvent::TurnStarted => {
                if self.cancel_turn {
                    return;
                }
                self.pending = false;
                self.streaming_flag = true;
                self.turn_start = Some(Instant::now());
                self.streaming_md.reset();
                self.streaming = Some(ChatLine {
                    role: "assistant".to_string(),
                    text: String::new(),
                    sent_content: None,
                    thinking: String::new(),
                    tools: Vec::new(),
                    duration_ms: None,
                    queued: false,
                });
            }
            AgentEvent::ThinkingDelta(text) => {
                if self.cancel_turn {
                    return;
                }
                if let Some(line) = &mut self.streaming {
                    line.thinking.push_str(&text);
                }
            }
            AgentEvent::Delta(text) => {
                if self.cancel_turn {
                    return;
                }
                if let Some(line) = &mut self.streaming {
                    line.text.push_str(&text);
                }
            }
            AgentEvent::ToolCall { name, args } => {
                if self.cancel_turn {
                    return;
                }
                if name == "update_plan" {
                    if let Some(plan) = parse_plan(&args) {
                        if plan.steps.iter().all(|step| step.status == "completed") {
                            // A finished plan becomes a normal message in the
                            // transcript (right after the user message) instead
                            // of staying pinned in the fixed panel.
                            self.insert_plan_message_after_user(plan);
                            self.plans.remove(&self.active_plan_key());
                        } else {
                            self.plans.insert(self.active_plan_key(), plan);
                        }
                        return;
                    }
                }
                let label = format_tool_call(&name, &args);
                if let Some(line) = &mut self.streaming {
                    line.tools.push(ToolCallDisplay { name, label });
                }
            }
            AgentEvent::TurnDone => self.finish_turn(),
            AgentEvent::Error(message) => self.finish_turn_with_error(message),
            AgentEvent::Resumed => {
                if let Some(session) = self.pending_resume.take() {
                    self.apply_session(session);
                }
                self.resuming = false;
                self.try_send_next();
            }
            AgentEvent::AgentTasks(tasks) => {
                self.agent_tasks = tasks;
                self.agent_tasks_updated_at = Instant::now();
                self.restore_active_child_progress();
                self.rebuild_commands();
            }
            AgentEvent::ScheduledTasks(tasks) => {
                self.scheduled_tasks = tasks;
                self.scheduled_tasks_updated_at = Instant::now();
                self.rebuild_commands();
            }
            AgentEvent::ScheduledTaskUpdate(task) => {
                if let Some(existing) = self
                    .scheduled_tasks
                    .iter_mut()
                    .find(|candidate| candidate.id == task.id)
                {
                    *existing = task.clone();
                } else {
                    self.scheduled_tasks.push(task.clone());
                }
                self.scheduled_tasks_updated_at = Instant::now();
                if task.unread && self.active_child.is_none() {
                    self.add_status(format!(
                        "🔔 Scheduled task \"{}\" has an update",
                        task.label
                    ));
                }
            }
            AgentEvent::ScheduledTaskHistory { id, runs } => {
                self.show_scheduled_task_history(&id, &runs);
            }
            AgentEvent::Notice(message) => {
                self.add_status(message);
            }
            AgentEvent::AgentSession {
                slot,
                agent,
                model,
                history,
                active_turn,
            } => {
                self.switch_agent_session(slot, agent, model, history, active_turn);
            }
        }
    }

    fn finish_turn(&mut self) {
        if self.cancel_turn {
            self.streaming = None;
            self.streaming_md.reset();
            self.pending = false;
            self.streaming_flag = false;
            self.turn_start = None;
            self.in_flight = None;
            self.cancel_turn = false;
            if self.open_pending_session() {
                return;
            }
            self.try_send_next();
            return;
        }

        self.commit_streaming_line();
        self.streaming_md.reset();
        self.pending = false;
        self.streaming_flag = false;
        self.turn_start = None;
        self.in_flight = None;
        self.persist_session();
        if self.open_pending_session() {
            return;
        }
        self.try_send_next();
    }

    /// Finish the active turn and keep its error in the transcript at the
    /// point where it occurred. This must happen before starting a queued
    /// turn, otherwise the error would appear after later user messages.
    fn finish_turn_with_error(&mut self, message: String) {
        if self.cancel_turn {
            self.finish_turn();
            return;
        }

        let user_index = self.in_flight.as_ref().map(|(index, _, _)| *index);
        self.commit_streaming_line();

        let line = ChatLine {
            role: "error".to_string(),
            text: message,
            sent_content: None,
            thinking: String::new(),
            tools: Vec::new(),
            duration_ms: None,
            queued: false,
        };
        if let Some(user_index) = user_index {
            let mut insert_at = (user_index + 1).min(self.static_lines.len());
            while insert_at < self.static_lines.len() && self.static_lines[insert_at].role != "user"
            {
                insert_at += 1;
            }
            self.static_lines.insert(insert_at, line);
            self.shift_line_indices_after_insert(insert_at);
        } else {
            self.static_lines.push(line);
        }

        self.streaming_md.reset();
        self.pending = false;
        self.streaming_flag = false;
        self.turn_start = None;
        self.in_flight = None;
        self.persist_session();
        if self.open_pending_session() {
            return;
        }
        self.try_send_next();
    }

    fn open_pending_session(&mut self) -> bool {
        let Some(pending) = self.pending_session_open.take() else {
            return false;
        };
        match pending {
            PendingSessionOpen::Task(slot) => self.client.send(ClientMessage::AgentTask { slot }),
        }
        true
    }

    /// The connection dropped mid-turn: keep whatever streamed so far as a
    /// static line and clear turn state. Queued messages stay queued and are
    /// flushed after the session is restored on reconnect.
    fn interrupt_turn_on_disconnect(&mut self) {
        if !self.is_turn_busy() {
            return;
        }
        self.commit_streaming_line();
        self.streaming_md.reset();
        self.pending = false;
        self.streaming_flag = false;
        self.turn_start = None;
        self.in_flight = None;
        self.persist_session();
    }

    /// Freeze the in-progress assistant reply into `static_lines`, placing it
    /// immediately after its user message so queued prompts stay after the
    /// completed turn instead of trapping the reply at the bottom.
    pub(super) fn commit_streaming_line(&mut self) {
        let width = self.last_transcript_width;
        let user_index = self.in_flight.as_ref().map(|(index, _, _)| *index);
        let Some(mut line) = self.streaming.take() else {
            return;
        };
        if let Some(start) = self.turn_start {
            line.duration_ms = Some(start.elapsed().as_millis() as u64);
        }
        if !line.text.trim().is_empty() {
            self.streaming_md
                .flush(&line.text, assistant_markdown_width(width));
            self.markdown_cache
                .render_static(&line.text, assistant_markdown_width(width));
        }
        if line.text.trim().is_empty() && line.thinking.trim().is_empty() && line.tools.is_empty() {
            return;
        }
        match user_index {
            Some(index) => self.insert_assistant_after_user(index, line),
            None => self.static_lines.push(line),
        }
    }

    fn insert_assistant_after_user(&mut self, user_index: usize, line: ChatLine) {
        let insert_at = if user_index < self.static_lines.len() {
            user_index + 1
        } else {
            self.static_lines.len()
        };
        self.static_lines.insert(insert_at, line);
        self.shift_line_indices_after_insert(insert_at);
    }

    /// Turn a completed plan into a normal assistant message placed directly
    /// after the in-flight user message, so it scrolls with the transcript
    /// instead of staying in the fixed Plan panel.
    fn insert_plan_message_after_user(&mut self, plan: PlanDisplay) {
        let text = format_plan_message(&plan);
        let line = ChatLine {
            role: "assistant".to_string(),
            text,
            sent_content: None,
            thinking: String::new(),
            tools: Vec::new(),
            duration_ms: None,
            queued: false,
        };
        match self.in_flight.as_ref().map(|(index, _, _)| *index) {
            Some(index) => self.insert_assistant_after_user(index, line),
            None => self.static_lines.push(line),
        }
    }

    fn shift_line_indices_after_insert(&mut self, inserted: usize) {
        for index in self.send_queue.iter_mut() {
            if *index >= inserted {
                *index += 1;
            }
        }
        if let Some((index, _, _)) = &mut self.in_flight {
            if *index >= inserted {
                *index += 1;
            }
        }
    }

    /// After a reconnect the server starts with an empty conversation, so
    /// push the local transcript back via `resume` before sending anything.
    fn restore_history_after_reconnect(&mut self) {
        let history: Vec<ConversationTurn> = self
            .static_lines
            .iter()
            .filter(|line| !line.queued && matches!(line.role.as_str(), "user" | "assistant"))
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
            .collect();

        if history.is_empty() || self.active_agent.is_empty() {
            self.try_send_next();
            return;
        }

        self.resuming = true;
        self.add_status("Reconnected — session restored".into());
        self.client.send(ClientMessage::Resume {
            agent: self.active_agent.clone(),
            history,
        });
    }
}
