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
                self.tool_start = None;
                self.streaming = Some(ChatLine {
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
            AgentEvent::ThinkingDelta(text) => {
                if self.cancel_turn {
                    return;
                }
                self.tool_start = None;
                if let Some(line) = &mut self.streaming {
                    // Text that preceded this reasoning keeps its position.
                    flush_pending_text(line);
                    line.pending_thinking.push_str(&text);
                }
            }
            AgentEvent::Delta(text) => {
                if self.cancel_turn {
                    return;
                }
                self.tool_start = None;
                if let Some(line) = &mut self.streaming {
                    flush_pending_thinking(line);
                    line.text.push_str(&text);
                    line.pending_text.push_str(&text);
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
                    flush_pending_text(line);
                    flush_pending_thinking(line);
                    line.segments.push(TurnSegment::Tool(ToolCallDisplay {
                        name,
                        label,
                        status: ToolStatus::Running,
                    }));
                }
                self.tool_start = Some(Instant::now());
            }
            AgentEvent::ToolResult { name, output } => {
                if self.cancel_turn {
                    return;
                }
                self.mark_tool_result(&name, &output);
            }
            AgentEvent::AskUser(question) => {
                if self.cancel_turn {
                    return;
                }
                self.begin_ask(&question);
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
                self.notify_finished_tasks(&tasks);
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

    /// Enter "answer the agent" mode for a blocking `ask_user` question. The
    /// question is placed in the transcript as a distinct ask message right
    /// after the in-flight turn so the user sees what the agent is asking;
    /// the composer then submits an `ask_user_reply` instead of a chat turn.
    fn begin_ask(&mut self, question: &str) {
        if self.pending_ask.is_some() {
            return;
        }
        self.pending_ask = Some(question.to_string());
        let line = ChatLine {
            role: "ask".to_string(),
            text: question.to_string(),
            sent_content: None,
            segments: Vec::new(),
            pending_thinking: String::new(),
            pending_text: String::new(),
            duration_ms: None,
            queued: false,
        };
        self.static_lines.push(line);
    }

    fn finish_turn(&mut self) {
        if self.cancel_turn {
            self.streaming = None;
            self.pending = false;
            self.streaming_flag = false;
            self.turn_start = None;
            self.tool_start = None;
            self.in_flight = None;
            self.cancel_turn = false;
            self.pending_ask = None;
            if self.open_pending_session() {
                return;
            }
            self.try_send_next();
            return;
        }

        self.commit_streaming_line();
        self.pending = false;
        self.streaming_flag = false;
        self.turn_start = None;
        self.tool_start = None;
        self.in_flight = None;
        self.pending_ask = None;
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
            segments: Vec::new(),
            pending_thinking: String::new(),
            pending_text: String::new(),
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

        self.pending = false;
        self.streaming_flag = false;
        self.turn_start = None;
        self.tool_start = None;
        self.in_flight = None;
        self.pending_ask = None;
        self.persist_session();
        if self.open_pending_session() {
            return;
        }
        self.try_send_next();
    }

    /// Mark the matching tool call as done/failed and stop the running-timer
    /// once every tool in the current round has finished.
    fn mark_tool_result(&mut self, name: &str, output: &str) {
        let Some(line) = self.streaming.as_mut() else {
            return;
        };
        mark_tool_in_line(line, name, output);
        if line.segments.iter().all(|segment| match segment {
            TurnSegment::Tool(tool) => tool.status != ToolStatus::Running,
            TurnSegment::Thinking(_) | TurnSegment::Text(_) | TurnSegment::Plan(_) => true,
        }) {
            self.tool_start = None;
        }
    }

    /// Notify once when a background agent transitions from busy to a terminal
    /// state, so the user hears about finishes that happened while they were
    /// reading or typing in the main session.
    fn notify_finished_tasks(&mut self, tasks: &[AgentTaskInfo]) {
        for task in tasks {
            let Some(previous) = self
                .agent_tasks
                .iter()
                .find(|candidate| candidate.slot == task.slot)
            else {
                continue;
            };
            if !model::agent_task_is_busy(&previous.status) {
                continue;
            }
            if !matches!(task.status.as_str(), "completed" | "failed" | "cancelled") {
                continue;
            }
            if self.active_child == Some(task.slot) {
                continue;
            }
            if !self.notified_task_slots.insert(task.slot) {
                continue;
            }
            let title = task.title.split_whitespace().collect::<Vec<_>>().join(" ");
            let title = if title.is_empty() {
                String::new()
            } else {
                format!(" — {title}")
            };
            match task.status.as_str() {
                "failed" => self.add_error(format!(
                    "✗ Agent /{} ({}) failed{title}",
                    task.slot, task.agent
                )),
                "cancelled" => self.add_status(format!(
                    "– Agent /{} ({}) cancelled{title}",
                    task.slot, task.agent
                )),
                _ => self.add_status(format!(
                    "✓ Agent /{} ({}) finished{title}",
                    task.slot, task.agent
                )),
            }
        }
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
                self.pending = false;
        self.streaming_flag = false;
        self.turn_start = None;
        self.tool_start = None;
        self.in_flight = None;
        self.pending_ask = None;
        self.persist_session();
    }

    /// Freeze the in-progress assistant reply into `static_lines`, placing it
    /// immediately after its user message so queued prompts stay after the
    /// completed turn instead of trapping the reply at the bottom.
    pub(super) fn commit_streaming_line(&mut self) {
        let user_index = self.in_flight.as_ref().map(|(index, _, _)| *index);
        let Some(mut line) = self.streaming.take() else {
            return;
        };
        flush_pending_text(&mut line);
        flush_pending_thinking(&mut line);
        if let Some(start) = self.turn_start {
            line.duration_ms = Some(start.elapsed().as_millis() as u64);
        }
        if line.text.trim().is_empty() && line.segments.is_empty() {
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
    /// instead of staying in the fixed Plan panel. The plan is kept as a
    /// structured segment so the transcript can style it like the panel.
    fn insert_plan_message_after_user(&mut self, plan: PlanDisplay) {
        let text = format_plan_message(&plan);
        let line = ChatLine {
            role: "assistant".to_string(),
            text,
            sent_content: None,
            segments: vec![TurnSegment::Plan(plan)],
            pending_thinking: String::new(),
            pending_text: String::new(),
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

/// Match a tool result to the first still-running call with the same name.
///
/// The server emits results in the provider's tool-call order, and tool calls
/// are appended in that same order, so a FIFO match keeps ✓/✗ attached to the
/// right line even when the same tool runs several times in one round
/// (parallel calls). Matching the *last* running call instead would swap the
/// status between same-name tool lines.
fn mark_tool_in_line(line: &mut ChatLine, name: &str, output: &str) {
    let status = if output.trim_start().starts_with("Error:") {
        ToolStatus::Failed
    } else {
        ToolStatus::Done
    };
    if let Some(TurnSegment::Tool(tool)) = line.segments.iter_mut().find(|segment| {
        matches!(segment, TurnSegment::Tool(tool) if tool.name == name && tool.status == ToolStatus::Running)
    }) {
        tool.status = status;
    }
}

/// Flush streamed reasoning into an ordered segment so long blocks stay
/// collapsible and keep their position before the tool call / text they
/// precede.
fn flush_pending_thinking(line: &mut ChatLine) {
    if !line.pending_thinking.trim().is_empty() {
        line.segments
            .push(TurnSegment::Thinking(std::mem::take(&mut line.pending_thinking)));
    }
}

/// Flush streamed text into an ordered segment so markdown blocks are not
/// split by reasoning or tool calls that interrupt them.
fn flush_pending_text(line: &mut ChatLine) {
    if !line.pending_text.trim().is_empty() {
        line.segments
            .push(TurnSegment::Text(std::mem::take(&mut line.pending_text)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line_with(tools: &[(&str, ToolStatus)]) -> ChatLine {
        ChatLine {
            role: "assistant".to_string(),
            text: String::new(),
            sent_content: None,
            segments: tools
                .iter()
                .map(|(name, status)| {
                    TurnSegment::Tool(ToolCallDisplay {
                        name: name.to_string(),
                        label: name.to_string(),
                        status: *status,
                    })
                })
                .collect(),
            pending_thinking: String::new(),
            pending_text: String::new(),
            duration_ms: None,
            queued: false,
        }
    }

    fn tool_status(line: &ChatLine, index: usize) -> ToolStatus {
        match &line.segments[index] {
            TurnSegment::Tool(tool) => tool.status,
            TurnSegment::Thinking(_) | TurnSegment::Text(_) | TurnSegment::Plan(_) => {
                panic!("expected a tool segment")
            }
        }
    }

    #[test]
    fn parallel_same_name_tools_pair_with_results_in_call_order() {
        let mut line = line_with(&[
            ("bash", ToolStatus::Running),
            ("bash", ToolStatus::Running),
            ("read", ToolStatus::Running),
        ]);

        // First result belongs to the first bash call (call order), so it must
        // mark that line, not the second bash line.
        mark_tool_in_line(&mut line, "bash", "output one");
        assert_eq!(tool_status(&line, 0), ToolStatus::Done);
        assert_eq!(tool_status(&line, 1), ToolStatus::Running);

        mark_tool_in_line(&mut line, "read", "output");
        assert_eq!(tool_status(&line, 2), ToolStatus::Done);

        mark_tool_in_line(&mut line, "bash", "Error: boom");
        assert_eq!(tool_status(&line, 1), ToolStatus::Failed);
    }

    #[test]
    fn results_across_rounds_reach_the_right_running_call() {
        let mut line = line_with(&[
            ("read", ToolStatus::Done),
            ("read", ToolStatus::Done),
            ("bash", ToolStatus::Running),
        ]);

        // A later round reuses the same tool name; only the running call from
        // the current round should be marked.
        mark_tool_in_line(&mut line, "bash", "done");
        assert_eq!(tool_status(&line, 2), ToolStatus::Done);
        assert_eq!(tool_status(&line, 0), ToolStatus::Done);
        assert_eq!(tool_status(&line, 1), ToolStatus::Done);
    }

    #[test]
    fn unknown_result_is_ignored() {
        let mut line = line_with(&[("bash", ToolStatus::Running)]);
        mark_tool_in_line(&mut line, "read", "output");
        assert_eq!(tool_status(&line, 0), ToolStatus::Running);
    }

    #[test]
    fn thinking_flushes_in_front_of_the_tool_that_follows() {
        let mut line = ChatLine {
            role: "assistant".to_string(),
            text: String::new(),
            sent_content: None,
            segments: Vec::new(),
            pending_thinking: "first reasoning".to_string(),
            pending_text: String::new(),
            duration_ms: None,
            queued: false,
        };
        flush_pending_thinking(&mut line);
        line.segments.push(TurnSegment::Tool(ToolCallDisplay {
            name: "bash".into(),
            label: "ls".into(),
            status: ToolStatus::Running,
        }));
        line.pending_thinking = "second reasoning".to_string();
        flush_pending_thinking(&mut line);

        assert_eq!(line.segments.len(), 3);
        assert!(matches!(&line.segments[0], TurnSegment::Thinking(t) if t == "first reasoning"));
        assert!(matches!(&line.segments[1], TurnSegment::Tool(_)));
        assert!(matches!(&line.segments[2], TurnSegment::Thinking(t) if t == "second reasoning"));
    }
}
