use std::collections::{HashMap, VecDeque};
use std::io::stdout;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use crossterm::{
    cursor::{MoveTo, SetCursorStyle, Show},
    event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseEventKind},
    execute,
};
use ratatui::{
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout, Rect},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Widget},
    Terminal,
};
use tokio::sync::mpsc;
use unicode_width::UnicodeWidthChar;

use crate::agent::client::{
    format_tool_call, AgentClient, AgentEvent, ChatLine, ConnectionState, ContextUsage,
    ToolCallDisplay,
};
use crate::protocol::{AgentTaskInfo, ClientMessage, ConversationTurn};
use crate::session::{
    build_session_preview, format_session_age, format_session_label, list_sessions, load_session,
    save_session, write_conversation_log, SavedSession, SavedSessionSummary, UndoEntry, UndoStack,
};
use crate::ui::composer::{
    command_group_id, menu_height, Composer, ComposerWidget, InputHistory, MenuWidget, SlashCommand,
};
use crate::ui::markdown::{MarkdownCache, StreamingMarkdown};
use crate::ui::status::{StatusBar, STATUS_HEIGHT};
use crate::ui::theme::style;
use crate::ui::transcript::{
    assistant_markdown_width, build_transcript_lines, max_history_scroll, TranscriptContent,
    TranscriptWidget,
};

enum PendingSessionOpen {
    Agent(String),
    Task(u64),
}

#[derive(Debug, Clone)]
struct PlanStep {
    text: String,
    status: String,
}

#[derive(Debug, Clone)]
struct PlanDisplay {
    steps: Vec<PlanStep>,
}

pub struct App {
    banner: Vec<String>,
    client: Arc<AgentClient>,
    events: mpsc::UnboundedReceiver<AgentEvent>,

    connection: ConnectionState,
    static_lines: Vec<ChatLine>,
    streaming: Option<ChatLine>,
    pending: bool,
    streaming_flag: bool,
    turn_start: Option<Instant>,
    skills: Vec<crate::protocol::SkillInfo>,
    agents: Vec<crate::protocol::AgentInfo>,
    active_agent: String,
    view_agent: String,
    active_child: Option<u64>,
    main_lines: Vec<ChatLine>,
    model: String,
    context: ContextUsage,
    mcp_servers: Vec<crate::protocol::McpServerInfo>,
    saved_sessions: Vec<SavedSessionSummary>,
    agent_tasks: Vec<AgentTaskInfo>,
    agent_tasks_updated_at: Instant,
    plans: HashMap<u64, PlanDisplay>,

    composer: Composer,
    /// Prompt recall for ↑/↓ — global across agent switches and `/new`.
    input_history: InputHistory,
    commands: Vec<SlashCommand>,
    command_groups: Vec<(String, Vec<SlashCommand>)>,
    menu_groups_raw: Vec<(String, Vec<SlashCommand>)>,

    history_scroll: u16,
    should_quit: bool,
    session_id: Option<String>,
    session_started_at: i64,
    undo: UndoStack,
    send_queue: VecDeque<usize>,
    in_flight: Option<(usize, String, String)>,
    cancel_turn: bool,
    pending_resume: Option<SavedSession>,
    pending_session_open: Option<PendingSessionOpen>,
    resuming: bool,
    has_connected_once: bool,
    started_at: Instant,
    markdown_cache: MarkdownCache,
    streaming_md: StreamingMarkdown,
    last_transcript_width: u16,
}

impl App {
    pub fn new(server_url: String, banner: Vec<String>) -> Self {
        let (client, events) = AgentClient::connect(server_url);
        let client = Arc::new(client);

        Self {
            banner,
            client,
            events,
            connection: ConnectionState::Connecting,
            static_lines: Vec::new(),
            streaming: None,
            pending: false,
            streaming_flag: false,
            turn_start: None,
            skills: Vec::new(),
            agents: Vec::new(),
            active_agent: String::new(),
            view_agent: String::new(),
            active_child: None,
            main_lines: Vec::new(),
            model: String::new(),
            context: ContextUsage::default(),
            mcp_servers: Vec::new(),
            saved_sessions: Vec::new(),
            agent_tasks: Vec::new(),
            agent_tasks_updated_at: Instant::now(),
            plans: HashMap::new(),
            composer: Composer::new(),
            input_history: InputHistory::new(),
            commands: Vec::new(),
            command_groups: Vec::new(),
            menu_groups_raw: Vec::new(),
            history_scroll: 0,
            should_quit: false,
            session_id: None,
            session_started_at: chrono::Utc::now().timestamp(),
            undo: UndoStack::new(),
            send_queue: VecDeque::new(),
            in_flight: None,
            cancel_turn: false,
            pending_resume: None,
            pending_session_open: None,
            resuming: false,
            has_connected_once: false,
            started_at: Instant::now(),
            markdown_cache: MarkdownCache::new(),
            streaming_md: StreamingMarkdown::new(),
            last_transcript_width: 80,
        }
    }

    pub async fn run(mut self) -> Result<()> {
        let mut terminal = Terminal::new(CrosstermBackend::new(stdout()))?;
        terminal.clear()?;
        self.saved_sessions = list_sessions().unwrap_or_default();
        self.rebuild_commands();

        loop {
            if self.should_quit {
                break;
            }

            while let Ok(event) = self.events.try_recv() {
                self.handle_agent_event(event);
            }

            if self.composer.restore_pending.is_some() {
                self.composer.consume_restore();
            }

            let size = terminal.size()?;
            let area = Rect::new(0, 0, size.width, size.height);
            let transcript_area = self.transcript_area(area);
            let width = transcript_area.width;
            self.last_transcript_width = width;
            self.sync_streaming_markdown(width);
            let show_welcome = self.is_welcome_screen();
            let content = TranscriptContent {
                lines: &self.static_lines,
                streaming: self.streaming.as_ref(),
                waiting: self.waiting_for_reply(),
                banner: &self.banner,
                show_welcome,
                connecting: matches!(self.connection, ConnectionState::Connecting),
                active_agent: &self.view_agent,
                fallback: None,
                clock: self.started_at,
                turn_start: self.turn_start,
                width,
            };
            let transcript_lines =
                build_transcript_lines(&content, &mut self.markdown_cache, &self.streaming_md);

            terminal.draw(|frame| {
                self.render(frame.area(), frame.buffer_mut(), transcript_lines);
            })?;
            self.clamp_history_scroll(width, transcript_area.height);
            if let Some((x, y)) = self.cursor_screen_pos(area) {
                execute!(stdout(), MoveTo(x, y), Show, SetCursorStyle::BlinkingBar)?;
            }

            if event::poll(Duration::from_millis(50))? {
                self.handle_input(event::read()?, area);
            }
        }

        Ok(())
    }

    fn render(
        &self,
        area: Rect,
        buf: &mut ratatui::buffer::Buffer,
        transcript_lines: Vec<Line<'static>>,
    ) {
        let chunks = self.layout_chunks(area);

        TranscriptWidget {
            lines: transcript_lines,
            scroll: self.history_scroll,
        }
        .render(chunks[0], buf);

        if self.history_scroll > 0 {
            Paragraph::new(format!(
                "History · {} rows below · scroll down to follow",
                self.history_scroll
            ))
            .style(style::warning())
            .render(chunks[1], buf);
        }

        if !self.agent_tasks.is_empty() {
            Paragraph::new(self.agent_task_lines(chunks[3].width.saturating_sub(2)))
                .block(
                    Block::default()
                        .title(" Sub Agents ")
                        .borders(Borders::ALL)
                        .border_style(style::border()),
                )
                .render(chunks[3], buf);
        }

        if let Some(plan) = self.active_plan() {
            let completed = plan
                .steps
                .iter()
                .filter(|step| step.status == "completed")
                .count();
            Paragraph::new(self.plan_lines(plan, chunks[2].width.saturating_sub(2)))
                .block(
                    Block::default()
                        .title(format!(" Plan {completed}/{} ", plan.steps.len()))
                        .borders(Borders::ALL)
                        .border_style(style::border()),
                )
                .render(chunks[2], buf);
        }

        let menu_items = self.current_menu_items();
        MenuWidget::new(&self.composer, &menu_items).render(chunks[4], buf);
        StatusBar {
            connection: self.connection,
            model: &self.model,
            active_agent: &self.view_agent,
            context: self.context.clone(),
        }
        .render(chunks[5], buf);

        let composer_area = Block::default()
            .borders(Borders::TOP | Borders::BOTTOM)
            .border_style(style::border());
        let inner = composer_area.inner(chunks[6]);
        composer_area.render(chunks[6], buf);
        ComposerWidget::new(
            &self.composer,
            !matches!(self.connection, ConnectionState::Connected),
        )
        .render(inner, buf);
    }

    fn input_height(&self, width: u16) -> u16 {
        self.composer
            .textarea
            .desired_height(width.saturating_sub(2))
            .max(1)
            + 2
    }

    fn cursor_screen_pos(&self, area: Rect) -> Option<(u16, u16)> {
        if !matches!(self.connection, ConnectionState::Connected) {
            return None;
        }
        let chunks = self.layout_chunks(area);
        let inner = Block::default()
            .borders(Borders::TOP | Borders::BOTTOM)
            .inner(chunks[6]);
        self.composer.cursor_pos(inner, 2)
    }

    fn handle_agent_event(&mut self, event: AgentEvent) {
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
                        self.plans.insert(self.active_plan_key(), plan);
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
            AgentEvent::AgentSession {
                slot,
                agent,
                model,
                history,
            } => {
                self.switch_agent_session(slot, agent, model, history);
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
            PendingSessionOpen::Agent(name) => {
                self.client.send(ClientMessage::Agent { name: Some(name) });
            }
            PendingSessionOpen::Task(slot) => {
                self.client.send(ClientMessage::AgentTask { slot });
            }
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
    fn commit_streaming_line(&mut self) {
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

    fn handle_input(&mut self, event: Event, area: Rect) {
        let transcript_area = self.transcript_area(area);
        match event {
            Event::Key(key) if key.kind == KeyEventKind::Press => {
                self.handle_key(key, transcript_area);
            }
            Event::Mouse(mouse) => match mouse.kind {
                MouseEventKind::ScrollUp => self.scroll_history(3, transcript_area),
                MouseEventKind::ScrollDown => self.scroll_history(-3, transcript_area),
                _ => {}
            },
            Event::Paste(text) => {
                self.input_history.reset_browse();
                self.composer.insert_paste(&text);
            }
            _ => {}
        }
    }

    /// Handle a key while the command menu is open. Returns true when the
    /// key was consumed; ↑/↓ with no candidates fall through so they keep
    /// recalling prompts / scrolling the transcript.
    fn handle_menu_key(&mut self, key: KeyEvent) -> bool {
        let menu_items = self.current_menu_items();
        let has_items = !menu_items.is_empty();

        match key.code {
            KeyCode::Up if has_items => {
                self.composer.move_menu(-1, menu_items.len());
                true
            }
            KeyCode::Down if has_items => {
                self.composer.move_menu(1, menu_items.len());
                true
            }
            KeyCode::Tab if has_items => {
                let index = self.composer.menu_index.min(menu_items.len() - 1);
                if let Some(item) = menu_items.get(index).cloned() {
                    if !self.try_open_command_group(&item) {
                        self.complete_into_composer(&item.value);
                    }
                }
                true
            }
            KeyCode::Enter if has_items => {
                let index = self.composer.menu_index.min(menu_items.len() - 1);
                if let Some(item) = menu_items.get(index).cloned() {
                    if self.try_open_command_group(&item) {
                        return true;
                    }
                    if item.value.ends_with(' ') {
                        // The command expects an argument — complete it so the
                        // candidate list opens instead of running it bare.
                        self.complete_into_composer(&item.value);
                        return true;
                    }
                    self.composer.clear();
                    self.submit(item.value.clone(), item.value);
                }
                true
            }
            // Don't submit the filter text as a chat message when no skills match.
            KeyCode::Enter if self.composer.open_group.is_some() => true,
            KeyCode::Esc => {
                if self.composer.open_group.is_some() {
                    self.composer.open_group = None;
                    self.composer.menu_index = 0;
                    // Return to the root command menu.
                    self.composer.textarea.set_text("/".into());
                    self.composer.textarea.move_end();
                    self.composer.on_text_changed();
                } else {
                    self.composer.clear();
                }
                true
            }
            _ => false,
        }
    }

    fn handle_key(&mut self, key: KeyEvent, transcript_area: Rect) {
        if matches!(key.code, KeyCode::Char('0'))
            && key
                .modifiers
                .intersects(KeyModifiers::SUPER | KeyModifiers::ALT)
        {
            if self.active_child.is_some() {
                self.client.send(ClientMessage::AgentBack);
            }
            return;
        }

        // History browse owns ↑/↓/Enter so slash-looking recalls (e.g. `/resume …`)
        // never trap keys in the command menu.
        if self.input_history.is_browsing() {
            match key.code {
                KeyCode::Up | KeyCode::Down => {
                    self.handle_input_history_key(key.code, transcript_area);
                    return;
                }
                KeyCode::Enter if !key.modifiers.contains(KeyModifiers::SHIFT) => {
                    self.submit_composer();
                    return;
                }
                _ => {}
            }
        } else if matches!(key.code, KeyCode::Up | KeyCode::Down) && !self.composer.menu_open {
            self.handle_input_history_key(key.code, transcript_area);
            return;
        }

        if self.composer.menu_open && self.handle_menu_key(key) {
            return;
        }

        match key.code {
            KeyCode::Esc if !self.composer.menu_open => {
                if self.revert_last_send() {
                    return;
                }
                if let Some(entry) = self.undo.pop() {
                    match entry {
                        UndoEntry::Local { line_index } => {
                            if line_index < self.static_lines.len() {
                                self.static_lines.remove(line_index);
                            }
                            self.composer.set_restore(String::new());
                        }
                        UndoEntry::Chat { user_index, text } => {
                            if user_index < self.static_lines.len() {
                                let restore = self.static_lines[user_index]
                                    .sent_content
                                    .clone()
                                    .unwrap_or_else(|| text.clone());
                                self.static_lines.remove(user_index);
                                self.composer.set_restore(restore);
                            } else {
                                self.composer.set_restore(text);
                            }
                        }
                    }
                }
            }
            KeyCode::Enter if key.modifiers.contains(KeyModifiers::SHIFT) => {
                self.leave_input_history_browse();
                self.composer.textarea.insert_str("\n");
                self.composer.on_text_changed();
            }
            KeyCode::Enter => {
                self.submit_composer();
            }
            KeyCode::Backspace => {
                self.leave_input_history_browse();
                self.composer.delete_backward();
            }
            KeyCode::Delete if key.modifiers.contains(KeyModifiers::SUPER) => {
                self.leave_input_history_browse();
                self.composer.delete_current_line();
            }
            KeyCode::Delete => {
                self.leave_input_history_browse();
                self.composer.delete_forward();
            }
            KeyCode::Left => self.composer.textarea.move_left(),
            KeyCode::Right => self.composer.textarea.move_right(),
            KeyCode::Home => self.composer.textarea.move_home(),
            KeyCode::End => self.composer.textarea.move_end(),
            KeyCode::PageUp => {
                self.scroll_history(10, transcript_area);
            }
            KeyCode::PageDown => {
                self.scroll_history(-10, transcript_area);
            }
            KeyCode::Char(ch) if key.modifiers.contains(KeyModifiers::CONTROL) && ch == 'y' => {
                self.copy_last_reply();
            }
            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::SUPER) => {
                self.copy_last_reply();
            }
            KeyCode::Char(ch)
                if !key
                    .modifiers
                    .intersects(KeyModifiers::CONTROL | KeyModifiers::SUPER) =>
            {
                self.leave_input_history_browse();
                self.composer.textarea.insert_str(&ch.to_string());
                self.composer.on_text_changed();
            }
            _ => {}
        }
    }

    fn submit_composer(&mut self) {
        let display = self.composer.textarea.text().trim().to_string();
        if display.is_empty() {
            return;
        }
        let full = self.composer.expand_message(&display);
        self.composer.clear();
        self.submit(display, full);
    }

    fn handle_input_history_key(&mut self, code: KeyCode, transcript_area: Rect) {
        match code {
            KeyCode::Up => {
                let current = self.composer.textarea.text().to_string();
                if let Some(text) = self.input_history.up(&current) {
                    self.apply_input_history_text(text);
                } else if !self.input_history.is_browsing() {
                    self.scroll_history(1, transcript_area);
                }
            }
            KeyCode::Down => {
                if let Some(text) = self.input_history.down() {
                    self.apply_input_history_text(text);
                    // Restoring the live draft should reopen the slash menu if needed.
                    if !self.input_history.is_browsing() {
                        self.composer.on_text_changed();
                    }
                } else if !self.input_history.is_browsing() {
                    self.scroll_history(-1, transcript_area);
                }
            }
            _ => {}
        }
    }

    fn leave_input_history_browse(&mut self) {
        self.input_history.reset_browse();
    }

    /// If the selected item is a group header (e.g. "/skills" or "/agent"), open the
    /// group as a filterable picker instead of running it. Returns true when
    /// it was one.
    fn try_open_command_group(&mut self, item: &SlashCommand) -> bool {
        if self.composer.open_group.is_none() {
            let group = command_group_id(&item.value);
            if self
                .command_groups
                .iter()
                .any(|(name, _)| command_group_id(name) == group)
            {
                if group == "mcp" {
                    self.client.send(ClientMessage::Mcp);
                }
                self.enter_command_picker(group);
                return true;
            }
        }
        false
    }

    fn enter_command_picker(&mut self, group: &str) {
        self.composer.open_group = Some(group.into());
        self.composer.menu_index = 0;
        self.composer.textarea.set_text(String::new());
        self.composer.menu_open = true;
    }

    fn complete_into_composer(&mut self, value: &str) {
        self.composer.textarea.set_text(value.to_string());
        self.composer.textarea.move_end();
        self.composer.on_text_changed();
    }

    fn apply_input_history_text(&mut self, text: String) {
        self.composer.textarea.set_text(text);
        self.composer.textarea.move_end();
        // Keep the slash menu closed while browsing history so ↑/↓ don't get
        // trapped by `/resume …` / `/agent …` candidate lists.
        self.composer.menu_open = false;
        self.composer.menu_index = 0;
        self.composer.open_group = None;
    }

    fn submit(&mut self, display: String, full: String) {
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
        if text == "exit" || text == "/quit" || text == "/exit" {
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
            let details = self
                .mcp_servers
                .iter()
                .find(|server| server.name == server_name)
                .map(|server| {
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
                    format!(
                        "[{}] {} ({}) — {}",
                        server.source, server.name, server.transport, status
                    )
                });
            self.add_local(
                details.unwrap_or_else(|| format!("MCP server not found: {server_name}")),
            );
            return;
        }
        if text == "/agent" {
            self.add_local(
                self.agents
                    .iter()
                    .filter(|agent| agent.name != "default")
                    .map(|agent| format!("/agent {} — {}", agent.name, agent.description))
                    .collect::<Vec<_>>()
                    .join("\n"),
            );
            return;
        }
        if let Some(name) = text.strip_prefix("/agent ") {
            if self.active_child.is_none() && self.is_turn_busy() {
                self.pending_session_open =
                    Some(PendingSessionOpen::Agent(name.trim().to_string()));
                self.add_local(
                    "Main agent is still responding; the sub-session will open automatically when it finishes.".into(),
                );
                return;
            }
            self.client.send(ClientMessage::Agent {
                name: Some(name.trim().to_string()),
            });
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
            return;
        }
        self.start_chat_turn(user_index, display, full);
    }

    fn user_line(text: String, sent_content: Option<String>, queued: bool) -> ChatLine {
        ChatLine {
            role: "user".to_string(),
            text,
            sent_content,
            thinking: String::new(),
            tools: Vec::new(),
            duration_ms: None,
            queued,
        }
    }

    fn is_turn_busy(&self) -> bool {
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
        self.client.send(ClientMessage::Chat { message: full });
    }

    fn try_send_next(&mut self) {
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

    fn revert_last_send(&mut self) -> bool {
        if let Some(user_index) = self.send_queue.pop_back() {
            if user_index < self.static_lines.len() && self.static_lines[user_index].queued {
                let text = self.static_lines[user_index].text.clone();
                self.static_lines.remove(user_index);
                self.shift_line_indices_after_remove(user_index);
                self.composer.set_restore(text);
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
            self.streaming_md.reset();
            self.turn_start = None;
            self.client.send(ClientMessage::Cancel);
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

    fn add_local(&mut self, text: String) {
        let line_index = self.static_lines.len();
        self.static_lines.push(ChatLine {
            role: "local".to_string(),
            text,
            sent_content: None,
            thinking: String::new(),
            tools: Vec::new(),
            duration_ms: None,
            queued: false,
        });
        self.undo.push(UndoEntry::Local { line_index });
    }

    fn add_status(&mut self, text: String) {
        self.static_lines.push(ChatLine {
            role: "status".to_string(),
            text,
            sent_content: None,
            thinking: String::new(),
            tools: Vec::new(),
            duration_ms: None,
            queued: false,
        });
        self.history_scroll = 0;
    }

    fn add_error(&mut self, text: String) {
        self.static_lines.push(ChatLine {
            role: "error".to_string(),
            text,
            sent_content: None,
            thinking: String::new(),
            tools: Vec::new(),
            duration_ms: None,
            queued: false,
        });
        self.history_scroll = 0;
    }

    fn reset_local_conversation(&mut self) {
        self.static_lines.clear();
        self.streaming = None;
        self.pending = false;
        self.streaming_flag = false;
        self.turn_start = None;
        self.context = ContextUsage::default();
        self.session_id = None;
        self.history_scroll = 0;
        self.markdown_cache.clear();
        self.streaming_md.reset();
        self.undo.clear();
        self.send_queue.clear();
        self.in_flight = None;
        self.cancel_turn = false;
        self.pending_session_open = None;
        self.agent_tasks.clear();
        self.plans.clear();
        self.active_child = None;
        self.main_lines.clear();
        self.view_agent = self.active_agent.clone();
        self.rebuild_commands();
    }

    fn switch_agent_session(
        &mut self,
        slot: Option<u64>,
        agent: String,
        model: String,
        history: Vec<ConversationTurn>,
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
                    thinking: String::new(),
                    tools: Vec::new(),
                    duration_ms: None,
                    queued: false,
                })
                .collect()
        };
        self.streaming = None;
        self.pending = false;
        self.streaming_flag = false;
        self.turn_start = None;
        self.in_flight = None;
        self.send_queue.clear();
        self.streaming_md.reset();
        self.markdown_cache.clear();
        self.history_scroll = 0;
        self.restore_active_child_progress();
        self.rebuild_commands();
    }

    /// Rebuild the transient progress display when returning to a child that
    /// kept running in the background. The server remains the source of truth
    /// for task state; streamed text itself is restored from session history
    /// once the turn completes.
    fn restore_active_child_progress(&mut self) {
        let Some(slot) = self.active_child else {
            return;
        };
        let Some(task) = self.agent_tasks.iter().find(|task| task.slot == slot) else {
            return;
        };
        let status = task.status.clone();
        let elapsed = Duration::from_millis(task.elapsed_ms).saturating_add(
            agent_task_is_busy(&status)
                .then(|| self.agent_tasks_updated_at.elapsed())
                .unwrap_or_default(),
        );

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

    fn apply_session(&mut self, session: SavedSession) {
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

    fn persist_session(&mut self) {
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

    fn rebuild_commands(&mut self) {
        self.commands = vec![
            SlashCommand {
                value: "/skills".into(),
                description: "Select and run a skill".into(),
            },
            SlashCommand {
                value: "/agent".into(),
                description: "List agents for a new sub-session".into(),
            },
            SlashCommand {
                value: "/back".into(),
                description: "Return to the main session (⌘0 / Alt+0 / /0)".into(),
            },
            SlashCommand {
                value: "/resume".into(),
                description: "Select and resume a saved session".into(),
            },
            SlashCommand {
                value: "/mcp".into(),
                description: "Select an MCP server".into(),
            },
            SlashCommand {
                value: "/tasks".into(),
                description: "Show background agent tasks".into(),
            },
            SlashCommand {
                value: "/new".into(),
                description: "Start a new conversation".into(),
            },
            SlashCommand {
                value: "/reload".into(),
                description: "Hot-reload config, agents and skills".into(),
            },
            SlashCommand {
                value: "/log".into(),
                description: "Export the full conversation log".into(),
            },
            SlashCommand {
                value: "/help".into(),
                description: "Show commands and keyboard shortcuts".into(),
            },
            SlashCommand {
                value: "/quit".into(),
                description: "Exit g-agent".into(),
            },
        ];

        self.commands
            .extend(self.agent_tasks.iter().map(|task| SlashCommand {
                value: format!("/{}", task.slot),
                description: task.title.split_whitespace().collect::<Vec<_>>().join(" "),
            }));

        let skill_commands = self
            .skills
            .iter()
            .map(|skill| SlashCommand {
                value: format!("/{}", skill.name),
                description: skill.description.clone(),
            })
            .collect::<Vec<_>>();

        let agent_commands = self
            .agents
            .iter()
            .filter(|agent| agent.name != "default")
            .map(|agent| SlashCommand {
                value: format!("/agent {}", agent.name),
                description: format!("new sub-session · {}", agent.description),
            })
            .collect::<Vec<_>>();
        self.commands.extend(agent_commands.iter().cloned());

        let resume_commands = self
            .saved_sessions
            .iter()
            .filter(|session| session.agent == self.active_agent)
            .map(|session| SlashCommand {
                value: format!("/resume {}", session.id),
                description: format!(
                    "{} · {} · {} msgs",
                    session.preview,
                    format_session_age(session.updated_at),
                    session.turn_count
                ),
            })
            .collect::<Vec<_>>();

        let mcp_commands = self
            .mcp_servers
            .iter()
            .map(|server| {
                let needs_auth = server.auth_required;
                SlashCommand {
                    value: if needs_auth {
                        format!("/mcp auth {}", server.name)
                    } else {
                        format!("/mcp {}", server.name)
                    },
                    description: if server.connected {
                        format!("connected · {} tools", server.tool_count)
                    } else if server.auth_required {
                        "auth required".into()
                    } else {
                        server
                            .error
                            .clone()
                            .unwrap_or_else(|| "not connected".into())
                    },
                }
            })
            .collect::<Vec<_>>();

        self.menu_groups_raw = vec![
            ("skills".to_string(), skill_commands.clone()),
            ("resume".to_string(), resume_commands.clone()),
            ("mcp".to_string(), mcp_commands.clone()),
        ];
        self.command_groups = vec![
            ("skills".to_string(), skill_commands),
            ("resume".to_string(), resume_commands),
            ("mcp".to_string(), mcp_commands),
        ];
    }

    fn current_menu_items(&self) -> Vec<SlashCommand> {
        if !self.composer.menu_open {
            return Vec::new();
        }

        let groups = self
            .menu_groups_raw
            .iter()
            .map(|(name, items)| (name.as_str(), items.as_slice()))
            .collect::<Vec<_>>();

        // Skill (or other group) picker: filter children by whatever is typed.
        if self.composer.open_group.is_some() {
            return self
                .composer
                .menu_items(&self.commands, &groups)
                .into_iter()
                .cloned()
                .collect();
        }

        let text = self.composer.textarea.text().to_string();

        if let Some(partial) = text.strip_prefix("/agent ") {
            return filter_argument_items(
                self.agents
                    .iter()
                    .filter(|agent| agent.name != "default")
                    .map(|agent| SlashCommand {
                        value: format!("/agent {}", agent.name),
                        description: agent.description.clone(),
                    }),
                partial,
            );
        }
        if let Some(partial) = text.strip_prefix("/mcp auth ") {
            return filter_argument_items(
                self.mcp_servers.iter().map(|server| SlashCommand {
                    value: format!("/mcp auth {}", server.name),
                    description: if server.connected {
                        "connected".into()
                    } else if server.auth_required {
                        "auth required".into()
                    } else {
                        "not connected".into()
                    },
                }),
                partial,
            );
        }
        if let Some(partial) = text.strip_prefix("/resume ") {
            return filter_argument_items(
                self.saved_sessions
                    .iter()
                    .filter(|session| session.agent == self.active_agent)
                    .map(|session| SlashCommand {
                        value: format!("/resume {}", session.id),
                        description: format!(
                            "{} · {} · {} msgs",
                            session.preview,
                            format_session_age(session.updated_at),
                            session.turn_count
                        ),
                    }),
                partial,
            );
        }
        if text.contains(' ') {
            return Vec::new();
        }

        self.composer
            .menu_items(&self.commands, &groups)
            .into_iter()
            .cloned()
            .collect()
    }

    fn format_help(&self) -> String {
        let mut out = String::from("Commands:\n");
        for command in &self.commands {
            out.push_str(&format!(
                "  {:<12} {}\n",
                command.value.trim_end(),
                command.description
            ));
        }
        out.push_str(&format!(
            "  /<skill>     Run a skill directly ({} loaded)\n",
            self.skills.len()
        ));
        out.push_str(concat!(
            "\nKeys:\n",
            "  Enter send · Shift+Enter newline · Tab complete command\n",
            "  ↑/↓ recall previous prompts (shared across agents) · menu when open\n",
            "  PageUp/PageDown scroll conversation\n",
            "  Cmd+0 or Alt+0 return to the main agent\n",
            "  Esc undo last send / clear input / cancel a running turn\n",
            "  Ctrl+Y or Cmd+C copy last reply\n",
        ));
        out
    }

    fn is_welcome_screen(&self) -> bool {
        self.static_lines.is_empty() && self.streaming.is_none() && !self.waiting_for_reply()
    }

    fn waiting_for_reply(&self) -> bool {
        let server_reports_running = self
            .active_child
            .and_then(|slot| {
                self.agent_tasks
                    .iter()
                    .find(|task| task.slot == slot)
                    .map(|task| agent_task_is_busy(&task.status))
            })
            .unwrap_or(false);

        (self.pending || self.streaming_flag || server_reports_running)
            && self.streaming.as_ref().is_none_or(|line| {
                line.text.trim().is_empty()
                    && line.thinking.trim().is_empty()
                    && line.tools.is_empty()
            })
    }

    fn sync_streaming_markdown(&mut self, width: u16) {
        if let Some(line) = self.streaming.as_ref() {
            if line.role == "assistant" {
                self.streaming_md
                    .sync(&line.text, assistant_markdown_width(width));
            }
        }
    }

    fn transcript_area(&self, area: Rect) -> Rect {
        self.layout_chunks(area)[0]
    }

    fn layout_chunks(&self, area: Rect) -> Vec<Rect> {
        let menu_items = self.current_menu_items();
        let plan_height = self
            .active_plan()
            .map(|plan| plan.steps.len().min(5) as u16 + 2)
            .unwrap_or(0);
        let task_height = if self.agent_tasks.is_empty() {
            0
        } else {
            (self.agent_tasks.len().min(3) as u16)
                .saturating_mul(2)
                .saturating_add(2)
        };
        Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Min(3),
                Constraint::Length(if self.history_scroll > 0 { 1 } else { 0 }),
                Constraint::Length(plan_height),
                Constraint::Length(task_height),
                Constraint::Length(menu_height(&self.composer, &menu_items)),
                Constraint::Length(STATUS_HEIGHT),
                Constraint::Length(self.input_height(area.width)),
            ])
            .split(area)
            .to_vec()
    }

    fn active_plan_key(&self) -> u64 {
        self.active_child.unwrap_or(0)
    }

    fn active_plan(&self) -> Option<&PlanDisplay> {
        self.plans.get(&self.active_plan_key())
    }

    fn plan_lines(&self, plan: &PlanDisplay, width: u16) -> Vec<Line<'static>> {
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

    fn agent_task_lines(&self, width: u16) -> Vec<Line<'static>> {
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
                let live_elapsed_ms = task.elapsed_ms.saturating_add(
                    agent_task_is_busy(&task.status)
                        .then(|| self.agent_tasks_updated_at.elapsed().as_millis() as u64)
                        .unwrap_or_default(),
                );
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

    fn clamp_history_scroll(&mut self, width: u16, height: u16) {
        self.sync_streaming_markdown(width);
        let show_welcome = self.is_welcome_screen();
        let content = TranscriptContent {
            lines: &self.static_lines,
            streaming: self.streaming.as_ref(),
            waiting: self.waiting_for_reply(),
            banner: &self.banner,
            show_welcome,
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

    fn scroll_history(&mut self, delta: i16, transcript_area: Rect) {
        let width = transcript_area.width;
        let height = transcript_area.height;
        self.sync_streaming_markdown(width);
        let show_welcome = self.is_welcome_screen();
        let content = TranscriptContent {
            lines: &self.static_lines,
            streaming: self.streaming.as_ref(),
            waiting: self.waiting_for_reply(),
            banner: &self.banner,
            show_welcome,
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

    fn copy_last_reply(&mut self) {
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

fn copy_to_clipboard(text: &str) -> bool {
    arboard::Clipboard::new()
        .and_then(|mut clip| clip.set_text(text.to_owned()))
        .is_ok()
}

fn should_remember_prompt(text: &str) -> bool {
    let trimmed = text.trim();
    !trimmed.is_empty() && !trimmed.starts_with('/') && trimmed != "exit"
}

fn agent_task_is_running(status: &str) -> bool {
    matches!(
        status,
        "thinking" | "tool_running" | "responding" | "running"
    )
}

fn agent_task_is_busy(status: &str) -> bool {
    matches!(status, "queued" | "starting") || agent_task_is_running(status)
}

fn parse_plan(args: &str) -> Option<PlanDisplay> {
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

fn truncate_to_width(text: &str, max_width: usize) -> String {
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

/// Argument candidates for commands like `/agent <name>`: filter by the
/// partial argument the user has typed so far (matched against the last
/// whitespace-separated token of the candidate value).
fn filter_argument_items(
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
    use super::{agent_task_is_busy, parse_plan, truncate_to_width};

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
}
