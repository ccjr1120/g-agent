use super::model::{should_remember_prompt, PendingSessionOpen};
use super::*;

/// Reply sent to the agent when the user skips a blocking `ask_user` question
/// with Esc, so the agent proceeds instead of the whole turn being aborted.
const SKIP_ASK_REPLY: &str = "skip";

impl App {
    pub(super) fn submit(&mut self, display: String, full: String) {
        // While an ask_user question awaits a reply, the composer answers
        // that question instead of starting a new chat turn.
        if !self.pending_asks.is_empty() {
            self.submit_ask_reply(display, full);
            return;
        }

        // Only remember real chat prompts. Slash commands like `/resume …` would
        // reopen the command menu and make ↑ history feel broken.
        let remembered = if full.trim().is_empty() {
            display.as_str()
        } else {
            full.as_str()
        };
        if should_remember_prompt(remembered) {
            self.input_history.push(remembered);
        } else {
            self.input_history.reset_browse();
        }

        let text = display.as_str();
        if text == "exit" {
            if let Some(slot) = self.active_child {
                self.client.send(ClientMessage::AgentTaskClose { slot });
                // The slot becomes free and may be reused by the next sub-agent,
                // so a fresh completion notification must fire for it again.
                self.notified_task_slots.remove(&slot);
                self.add_status(
                    "Closed current agent session — back to the main session".into(),
                );
                return;
            }
            self.should_quit = true;
            return;
        }
        if text == "/quit" || text == "/exit" {
            self.should_quit = true;
            return;
        }
        if text == "/help" {
            self.add_local(self.format_help());
            return;
        }
        if text == "/reload" {
            self.client.send(ClientMessage::Reload);
            self.add_status("Reloading config, agents and skills…".into());
            return;
        }
        if text == "/new" {
            self.client.send(ClientMessage::Reset);
            self.reset_local_conversation();
            return;
        }
        if text == "/skills" {
            self.enter_command_picker("skills");
            return;
        }
        if text == "/mcp" {
            self.client.send(ClientMessage::Mcp);
            self.enter_command_picker("mcp");
            return;
        }
        if let Some(name) = text.strip_prefix("/mcp auth ") {
            let server_name = name.trim();
            if server_name.is_empty() {
                self.add_local("Usage: /mcp auth <server-name>".into());
                return;
            }
            self.client.send(ClientMessage::McpAuth {
                name: server_name.to_string(),
            });
            self.add_local(format!(
                "Starting OAuth for MCP server \"{}\"... Complete sign-in in your browser.",
                server_name
            ));
            return;
        }
        if let Some(name) = text.strip_prefix("/mcp ") {
            let server_name = name.trim();
            if let Some(server) = self
                .mcp_servers
                .iter()
                .find(|server| server.name == server_name)
            {
                self.add_local(model::format_mcp_server_detail(server));
            } else {
                self.add_local(format!("MCP server not found: {server_name}"));
            }
            return;
        }
        if let Some(arguments) = text.strip_prefix("/agent ") {
            let mut parts = arguments.trim().splitn(2, char::is_whitespace);
            let name = parts.next().unwrap_or_default();
            let message = parts
                .next()
                .map(str::trim)
                .filter(|value| !value.is_empty());
            if name.is_empty() {
                self.enter_command_picker("agent");
                return;
            }
            if message.is_none() {
                self.complete_into_composer(&format!("/agent {name} "));
                return;
            }
            self.client.send(ClientMessage::Agent {
                name: Some(name.trim().to_string()),
                message: message.map(str::to_string),
            });
            self.add_status(format!("Started {name} in the background"));
            return;
        }
        if let Some(name) = text.strip_prefix("/skill ") {
            self.client.send(ClientMessage::Skill {
                name: name.trim().to_string(),
            });
            return;
        }
        if text == "/log" {
            let pairs = self
                .static_lines
                .iter()
                .map(|line| (line.role.clone(), line.text.clone()))
                .collect::<Vec<_>>();
            match write_conversation_log(&pairs) {
                Ok(path) => self.add_local(format!("Log saved to: {}", path.display())),
                Err(err) => self.add_error(err.to_string()),
            }
            return;
        }
        if text == "/resume all" {
            self.add_local(
                self.saved_sessions
                    .iter()
                    .map(format_session_label)
                    .collect::<Vec<_>>()
                    .join("\n"),
            );
            return;
        }
        if text == "/resume" {
            self.enter_command_picker("resume");
            return;
        }
        if let Some(id) = text.strip_prefix("/resume ") {
            if let Ok(Some(session)) = load_session(id.trim()) {
                self.pending_resume = Some(session.clone());
                self.resuming = true;
                self.client.send(ClientMessage::Resume {
                    agent: session.agent,
                    history: session.history,
                });
            } else {
                self.add_local(format!("Session not found: {}", id.trim()));
            }
            return;
        }
        if text == "/tasks" {
            self.client.send(ClientMessage::AgentTasks);
            return;
        }
        if text == "/scheduled" {
            self.client.send(ClientMessage::ScheduledTasks);
            return;
        }
        if let Some(arg) = text.strip_prefix("/scheduled cancel ") {
            let arg = arg.trim();
            if arg.is_empty() {
                self.add_local("Usage: /scheduled cancel <number|id>".into());
                return;
            }
            match self.resolve_scheduled_task(arg) {
                Some((id, label)) => {
                    self.client.send(ClientMessage::ScheduledTaskCancel { id });
                    self.add_local(format!("Cancelling scheduled task \"{label}\""));
                }
                None => self.add_local(format!("Scheduled task not found: {arg}")),
            }
            return;
        }
        if let Some(arg) = text.strip_prefix("/scheduled run ") {
            let arg = arg.trim();
            if arg.is_empty() {
                self.add_local("Usage: /scheduled run <number|id>".into());
                return;
            }
            match self.resolve_scheduled_task(arg) {
                Some((id, label)) => {
                    self.client.send(ClientMessage::ScheduledTaskRun { id });
                    self.add_local(format!("Running scheduled task \"{label}\" now"));
                }
                None => self.add_local(format!("Scheduled task not found: {arg}")),
            }
            return;
        }
        if let Some(arg) = text.strip_prefix("/scheduled history ") {
            let arg = arg.trim();
            if arg.is_empty() {
                self.add_local("Usage: /scheduled history <number|id>".into());
                return;
            }
            match self.resolve_scheduled_task(arg) {
                Some((id, label)) => {
                    self.client.send(ClientMessage::ScheduledTaskHistory { id });
                    self.add_local(format!("Fetching history for \"{label}\"…"));
                }
                None => self.add_local(format!("Scheduled task not found: {arg}")),
            }
            return;
        }
        if text == "/back" || text == "/0" {
            self.client.send(ClientMessage::AgentBack);
            return;
        }
        if let Some(slot) = text
            .strip_prefix('/')
            .and_then(|value| value.parse::<u64>().ok())
        {
            if self.active_child.is_none() && self.is_turn_busy() {
                self.pending_session_open = Some(PendingSessionOpen::Task(slot));
                self.add_local(
                    "Main agent is still responding; the sub-session will open automatically when it finishes.".into(),
                );
                return;
            }
            self.client.send(ClientMessage::AgentTask { slot });
            return;
        }
        if let Some(skill) = text.strip_prefix('/') {
            if self.skills.iter().any(|item| item.name == skill) {
                self.client.send(ClientMessage::Skill {
                    name: skill.to_string(),
                });
                return;
            }
        }

        let user_index = self.static_lines.len();
        self.static_lines.push(Self::user_line(
            display.clone(),
            Some(full.clone()),
            self.is_turn_busy(),
        ));
        if self.is_turn_busy() {
            self.send_queue.push_back(user_index);
            self.history_scroll = 0;
            self.scroll_anchor_y = None;
            return;
        }
        self.start_chat_turn(user_index, display, full);
    }

    fn user_line(text: String, sent_content: Option<String>, queued: bool) -> ChatLine {
        ChatLine {
            role: "user".to_string(),
            text,
            sent_content,
            segments: Vec::new(),
            pending_thinking: String::new(),
            pending_text: String::new(),
            duration_ms: None,
            queued,
        }
    }

    /// Answer a blocking `ask_user` question. The reply is sent to the server
    /// as `ask_user_reply` (not a chat turn) and rendered as a `Reply` segment
    /// right after the question inside the live turn, so the exchange reads
    /// question → answer → continue in the transcript.
    fn submit_ask_reply(&mut self, display: String, full: String) {
        let Some(id) = self.pending_asks.get(self.active_ask).map(|ask| ask.id.clone()) else {
            return;
        };
        if let Some(line) = &mut self.streaming {
            line.segments.push(TurnSegment::Reply(display.clone()));
        } else {
            self.static_lines.push(Self::user_line(
                display.clone(),
                Some(full.clone()),
                false,
            ));
        }
        self.client
            .send(ClientMessage::AskUserReply { id: id.clone(), reply: full });
        self.input_history.reset_browse();
        self.history_scroll = 0;
        self.scroll_anchor_y = None;
        self.remove_pending_ask(&id);
    }

    /// Skip the active `ask_user` question (Esc): tell the agent to proceed
    /// with its best assumption instead of aborting the whole turn. The skip is
    /// shown as the question's answer so the exchange reads in order.
    pub(super) fn skip_pending_ask(&mut self) {
        let Some(id) = self.pending_asks.get(self.active_ask).map(|ask| ask.id.clone()) else {
            return;
        };
        self.composer.clear();
        self.input_history.reset_browse();
        if let Some(line) = &mut self.streaming {
            line.segments.push(TurnSegment::Reply("(skipped)".into()));
        }
        self.client.send(ClientMessage::AskUserReply {
            id: id.clone(),
            reply: SKIP_ASK_REPLY.into(),
        });
        self.remove_pending_ask(&id);
    }

    /// Submit the currently highlighted `ask_user` option (Enter with an empty
    /// composer). Sends the option text as the reply.
    pub(super) fn select_ask_option(&mut self) {
        let Some(ask) = self.pending_asks.get(self.active_ask).cloned() else {
            return;
        };
        let Some(option) = ask.options.get(ask.selected).cloned() else {
            return;
        };
        self.submit_ask_reply(option.clone(), option);
    }

    pub(super) fn is_turn_busy(&self) -> bool {
        self.in_flight.is_some() || self.pending || self.streaming_flag
    }

    fn start_chat_turn(&mut self, user_index: usize, display: String, full: String) {
        if user_index < self.static_lines.len() {
            self.static_lines[user_index].queued = false;
        }
        self.in_flight = Some((user_index, display.clone(), full.clone()));
        self.undo.push(UndoEntry::Chat {
            user_index,
            text: display,
        });
        self.pending = true;
        self.history_scroll = 0;
        self.scroll_anchor_y = None;
        self.client.send(ClientMessage::Chat { message: full });
    }

    pub(super) fn try_send_next(&mut self) {
        if self.is_turn_busy() || self.cancel_turn {
            return;
        }
        let Some(user_index) = self.send_queue.pop_front() else {
            return;
        };
        if user_index >= self.static_lines.len() || !self.static_lines[user_index].queued {
            self.try_send_next();
            return;
        }
        let text = self.static_lines[user_index].text.clone();
        let full = self.static_lines[user_index]
            .sent_content
            .clone()
            .unwrap_or_else(|| text.clone());
        self.start_chat_turn(user_index, text, full);
    }

    pub(super) fn revert_last_send(&mut self) -> bool {
        if let Some(user_index) = self.send_queue.pop_back() {
            if user_index < self.static_lines.len() && self.static_lines[user_index].queued {
                let text = self.static_lines[user_index].text.clone();
                self.static_lines.remove(user_index);
                self.shift_line_indices_after_remove(user_index);
                self.composer.set_restore(text);
                self.add_status("Removed queued message — restored to editor".into());
                return true;
            }
            return false;
        }

        if self.in_flight.is_some() && self.is_turn_busy() {
            let Some((user_index, display, full)) = self.in_flight.take() else {
                return false;
            };
            let _ = full;
            if user_index < self.static_lines.len() {
                let restore = self.static_lines[user_index]
                    .sent_content
                    .clone()
                    .unwrap_or(display.clone());
                self.static_lines.remove(user_index);
                self.shift_line_indices_after_remove(user_index);
                self.composer.set_restore(restore);
            } else {
                self.composer.set_restore(display);
            }
            self.undo.pop();
            self.cancel_turn = true;
            self.pending = false;
            self.streaming_flag = false;
            self.streaming = None;
                        self.turn_start = None;
            self.tool_start = None;
            self.client.send(ClientMessage::Cancel);
            self.add_status("Turn cancelled — your prompt was restored to the editor".into());
            return true;
        }

        false
    }

    fn shift_line_indices_after_remove(&mut self, removed: usize) {
        for index in self.send_queue.iter_mut() {
            if *index > removed {
                *index -= 1;
            }
        }
        if let Some((index, _, _)) = &mut self.in_flight {
            if *index > removed {
                *index -= 1;
            }
        }
    }

    pub(super) fn add_local(&mut self, text: String) {
        let line_index = self.static_lines.len();
        self.static_lines.push(ChatLine {
            role: "local".to_string(),
            text,
            sent_content: None,
            segments: Vec::new(),
            pending_thinking: String::new(),
            pending_text: String::new(),
            duration_ms: None,
            queued: false,
        });
        self.undo.push(UndoEntry::Local { line_index });
    }

    pub(super) fn add_status(&mut self, text: String) {
        self.static_lines.push(ChatLine {
            role: "status".to_string(),
            text,
            sent_content: None,
            segments: Vec::new(),
            pending_thinking: String::new(),
            pending_text: String::new(),
            duration_ms: None,
            queued: false,
        });
    }

    pub(super) fn add_error(&mut self, text: String) {
        self.static_lines.push(ChatLine {
            role: "error".to_string(),
            text,
            sent_content: None,
            segments: Vec::new(),
            pending_thinking: String::new(),
            pending_text: String::new(),
            duration_ms: None,
            queued: false,
        });
    }

    fn reset_local_conversation(&mut self) {
        self.static_lines.clear();
        self.streaming = None;
        self.pending = false;
        self.streaming_flag = false;
        self.turn_start = None;
        self.tool_start = None;
        self.context = ContextUsage::default();
        self.session_id = None;
        self.history_scroll = 0;
        self.scroll_anchor_y = None;
        self.markdown_cache.clear();
                self.undo.clear();
        self.send_queue.clear();
        self.in_flight = None;
        self.cancel_turn = false;
        self.clear_pending_asks();
        self.pending_session_open = None;
        self.agent_tasks.clear();
        self.scheduled_tasks.clear();
        self.plans.clear();
        self.active_child = None;
        self.main_lines.clear();
        self.view_agent = self.active_agent.clone();
        self.expand_thinking = false;
        self.notified_task_slots.clear();
        self.reset_panel_scroll();
        self.rebuild_commands();
    }
}
