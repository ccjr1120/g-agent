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
    style::{Color, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Widget},
    Terminal,
};
use tokio::sync::mpsc;

use crate::agent::client::{
    format_tool_call, AgentClient, AgentEvent, AgentFallback, ChatLine, ConnectionState,
    ContextUsage, ToolCallDisplay,
};
use crate::protocol::{ClientMessage, ConversationTurn};
use crate::session::{
    build_session_preview, format_session_label, list_sessions, load_session, save_session,
    SavedSession, SavedSessionSummary, UndoEntry, UndoStack, write_conversation_log,
};
use crate::ui::composer::{Composer, SlashCommand};
use crate::ui::markdown::{MarkdownCache, StreamingMarkdown};
use crate::ui::transcript::{
    build_transcript_lines, max_history_scroll, TranscriptContent, TranscriptWidget,
};

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
    error: Option<String>,
    skills: Vec<crate::protocol::SkillInfo>,
    agents: Vec<crate::protocol::AgentInfo>,
    active_agent: String,
    model: String,
    context: ContextUsage,
    fallback: Option<AgentFallback>,
    mcp_servers: Vec<crate::protocol::McpServerInfo>,
    saved_sessions: Vec<SavedSessionSummary>,

    composer: Composer,
    commands: Vec<SlashCommand>,
    command_groups: Vec<(String, Vec<SlashCommand>)>,
    menu_groups_raw: Vec<(String, Vec<SlashCommand>)>,

    history_scroll: u16,
    should_quit: bool,
    session_id: Option<String>,
    session_started_at: i64,
    undo: UndoStack,
    pending_resume: Option<SavedSession>,
    resuming: bool,
    notice: Option<String>,
    started_at: Instant,
    markdown_cache: MarkdownCache,
    streaming_md: StreamingMarkdown,
    last_transcript_width: u16,
}

impl App {
    pub async fn new(server_url: String, banner: Vec<String>) -> Self {
        let (client, events) = AgentClient::connect(server_url.clone())
            .await
            .expect("connect websocket");
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
            error: None,
            skills: Vec::new(),
            agents: Vec::new(),
            active_agent: String::new(),
            model: String::new(),
            context: ContextUsage::default(),
            fallback: None,
            mcp_servers: Vec::new(),
            saved_sessions: Vec::new(),
            composer: Composer::new(),
            commands: Vec::new(),
            command_groups: Vec::new(),
            menu_groups_raw: Vec::new(),
            history_scroll: 0,
            should_quit: false,
            session_id: None,
            session_started_at: chrono::Utc::now().timestamp(),
            undo: UndoStack::new(),
            pending_resume: None,
            resuming: false,
            notice: None,
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
                show_banner: show_welcome && !self.banner.is_empty(),
                connecting: matches!(self.connection, ConnectionState::Connecting),
                active_agent: &self.active_agent,
                fallback: self
                    .fallback
                    .as_ref()
                    .map(|value| (value.requested.as_str(), value.active.as_str())),
                clock: self.started_at,
                turn_start: self.turn_start,
                width,
            };
            let transcript_lines = build_transcript_lines(
                &content,
                &mut self.markdown_cache,
                &self.streaming_md,
            );

            terminal.draw(|frame| {
                self.render(frame.area(), frame.buffer_mut(), transcript_lines, show_welcome);
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
        show_welcome: bool,
    ) {
        let chunks = self.layout_chunks(area);

        TranscriptWidget {
            lines: transcript_lines,
            scroll: self.history_scroll,
            show_welcome,
        }
        .render(chunks[0], buf);

        if let Some(notice) = &self.notice {
            Paragraph::new(notice.clone())
                .style(Style::default().fg(Color::Green))
                .render(chunks[1], buf);
        }
        if self.history_scroll > 0 {
            Paragraph::new(format!(
                "History · {} rows below · scroll down to follow",
                self.history_scroll
            ))
            .style(Style::default().fg(Color::Yellow))
            .render(chunks[2], buf);
        }
        if let Some(error) = &self.error {
            Paragraph::new(error.clone())
                .style(Style::default().fg(Color::Red))
                .render(chunks[3], buf);
        }

        let menu_items = self.current_menu_items();
        let composer_area = Block::default()
            .borders(Borders::TOP)
            .border_style(Style::default().fg(Color::DarkGray));
        let inner = composer_area.inner(chunks[4]);
        composer_area.render(chunks[4], buf);
        crate::ui::composer::ComposerWidget::new(
            &self.composer,
            !matches!(self.connection, ConnectionState::Connected),
            &menu_items,
        )
        .render(inner, buf);

        self.render_status(chunks[5], buf);
    }

    fn render_status(&self, area: Rect, buf: &mut ratatui::buffer::Buffer) {
        let (icon, label) = match self.connection {
            ConnectionState::Connecting => ("●", "Connecting"),
            ConnectionState::Connected => ("●", "Connected"),
            ConnectionState::Disconnected => ("○", "Disconnected"),
        };
        let model = display_model(&self.model);
        let context = if self.context.max_tokens > 0 {
            format!(
                "{}% {}k/{}k",
                self.context.percent,
                self.context.used_tokens / 1000,
                self.context.max_tokens / 1000
            )
        } else {
            format!("{}k/inf", self.context.used_tokens / 1000)
        };
        let line = Line::from(vec![
            Span::styled(icon, Style::default().fg(Color::Cyan)),
            Span::raw(" "),
            Span::styled(label, Style::default().fg(Color::DarkGray)),
            Span::raw("   Model "),
            Span::styled(model, Style::default().fg(Color::Cyan)),
            Span::raw("   Agent "),
            Span::styled(
                if self.active_agent.is_empty() {
                    "—".to_string()
                } else {
                    self.active_agent.clone()
                },
                Style::default().fg(Color::Cyan),
            ),
            Span::raw("   Context "),
            Span::styled(context, Style::default().fg(Color::Cyan)),
        ]);
        Paragraph::new(line).render(area, buf);
    }

    fn composer_height(&self, width: u16) -> u16 {
        let input = self.composer.textarea.desired_height(width.saturating_sub(2)).max(1);
        let menu = if self.composer.menu_open {
            self.current_menu_items().len().min(6) as u16 + 1
        } else {
            0
        };
        input + menu + 2
    }

    fn cursor_screen_pos(&self, area: Rect) -> Option<(u16, u16)> {
        if !matches!(self.connection, ConnectionState::Connected) {
            return None;
        }
        let chunks = self.layout_chunks(area);
        let inner = Block::default().borders(Borders::TOP).inner(chunks[4]);
        self.composer.cursor_pos(inner, 2)
    }

    fn handle_agent_event(&mut self, event: AgentEvent) {
        match event {
            AgentEvent::Connection(state) => self.connection = state,
            AgentEvent::Agents { agents, active, model } => {
                if !self.active_agent.is_empty() && self.active_agent != active && !self.resuming {
                    self.reset_local_conversation();
                }
                self.agents = agents;
                self.active_agent = active;
                self.model = model;
                self.rebuild_commands();
            }
            AgentEvent::AgentFallback(fallback) => self.fallback = Some(fallback),
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
                self.pending = false;
                self.streaming_flag = true;
                self.turn_start = Some(Instant::now());
                self.streaming_md.reset();
                self.streaming = Some(ChatLine {
                    role: "assistant".to_string(),
                    text: String::new(),
                    tools: Vec::new(),
                    duration_ms: None,
                });
            }
            AgentEvent::Delta(text) => {
                if let Some(line) = &mut self.streaming {
                    line.text.push_str(&text);
                }
            }
            AgentEvent::ToolCall { name, args } => {
                let label = format_tool_call(&name, &args);
                if let Some(line) = &mut self.streaming {
                    line.tools.push(ToolCallDisplay { name, label });
                }
            }
            AgentEvent::TurnDone => self.finish_turn(),
            AgentEvent::Error(message) => {
                self.error = Some(message);
                self.finish_turn();
            }
            AgentEvent::Resumed => {
                if let Some(session) = self.pending_resume.take() {
                    self.apply_session(session);
                }
                self.resuming = false;
            }
        }
    }

    fn finish_turn(&mut self) {
        let width = self.last_transcript_width;
        if let Some(mut line) = self.streaming.take() {
            if let Some(start) = self.turn_start {
                line.duration_ms = Some(start.elapsed().as_millis() as u64);
            }
            if !line.text.trim().is_empty() {
                self.streaming_md.flush(&line.text, width);
                self.markdown_cache.render_static(&line.text, width);
            }
            if !line.text.trim().is_empty() || !line.tools.is_empty() {
                self.static_lines.push(line);
            }
        }
        self.streaming_md.reset();
        self.pending = false;
        self.streaming_flag = false;
        self.turn_start = None;
        self.persist_session();
    }

    fn handle_input(&mut self, event: Event, area: Rect) {
        let transcript_area = self.transcript_area(area);
        match event {
            Event::Key(key) if key.kind == KeyEventKind::Press => self.handle_key(key, transcript_area),
            Event::Mouse(mouse) => {
                if mouse.kind == MouseEventKind::ScrollUp {
                    self.scroll_history(1, transcript_area);
                } else if mouse.kind == MouseEventKind::ScrollDown {
                    self.scroll_history(-1, transcript_area);
                }
            }
            _ => {}
        }
    }

    fn handle_key(&mut self, key: KeyEvent, transcript_area: Rect) {
        if self.composer.menu_open && !self.composer.textarea.is_empty() {
            match key.code {
                KeyCode::Up => {
                    let count = self.current_menu_items().len();
                    self.composer.move_menu(-1, count);
                    return;
                }
                KeyCode::Down => {
                    let count = self.current_menu_items().len();
                    self.composer.move_menu(1, count);
                    return;
                }
                KeyCode::Enter => {
                    if let Some(item) = self.current_menu_items().get(self.composer.menu_index).cloned() {
                        if self.composer.open_group.is_none()
                            && self.command_groups.iter().any(|(name, _)| name == &item.value.trim_start_matches('/'))
                        {
                            self.composer.open_group = Some(item.value.trim_start_matches('/').to_string());
                            self.composer.menu_index = 0;
                            return;
                        }
                        self.composer.clear();
                        self.submit(item.value);
                    }
                    return;
                }
                KeyCode::Esc => {
                    if self.composer.open_group.is_some() {
                        self.composer.open_group = None;
                        self.composer.menu_index = 0;
                    } else {
                        self.composer.clear();
                    }
                    return;
                }
                _ => {}
            }
        }

        match key.code {
            KeyCode::Esc if !self.composer.menu_open => {
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
                                self.static_lines.remove(user_index);
                            }
                            self.composer.set_restore(text);
                        }
                    }
                }
            }
            KeyCode::Enter if key.modifiers.contains(KeyModifiers::SHIFT) => {
                self.composer.textarea.insert_str("\n");
                self.composer.on_text_changed();
            }
            KeyCode::Enter => {
                let text = self.composer.textarea.text().trim().to_string();
                if text.is_empty() {
                    return;
                }
                self.composer.clear();
                self.submit(text);
            }
            KeyCode::Backspace => {
                self.composer.textarea.delete_backward();
                self.composer.on_text_changed();
            }
            KeyCode::Delete => {
                self.composer.textarea.delete_forward();
                self.composer.on_text_changed();
            }
            KeyCode::Left => self.composer.textarea.move_left(),
            KeyCode::Right => self.composer.textarea.move_right(),
            KeyCode::Home => self.composer.textarea.move_home(),
            KeyCode::End => self.composer.textarea.move_end(),
            KeyCode::Up if !self.composer.menu_open => {
                self.scroll_history(1, transcript_area);
            }
            KeyCode::Down if !self.composer.menu_open => {
                self.scroll_history(-1, transcript_area);
            }
            KeyCode::Char(ch) if key.modifiers.contains(KeyModifiers::CONTROL) && ch == 'y' => {
                self.copy_last_reply();
            }
            KeyCode::Char(ch) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.composer.textarea.insert_str(&ch.to_string());
                self.composer.on_text_changed();
            }
            _ => {}
        }
    }

    fn submit(&mut self, text: String) {
        if text == "exit" {
            self.should_quit = true;
            return;
        }
        if text == "/new" {
            self.client.send(ClientMessage::Reset);
            self.reset_local_conversation();
            return;
        }
        if text == "/skills" {
            self.add_local(self.format_skills());
            return;
        }
        if text == "/mcp" {
            self.client.send(ClientMessage::Mcp);
            self.add_local(self.format_mcp());
            return;
        }
        if text == "/agent" {
            self.add_local(self.format_agents());
            return;
        }
        if let Some(name) = text.strip_prefix("/agent ") {
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
            let pairs = self.static_lines.iter().map(|line| (line.role.clone(), line.text.clone())).collect::<Vec<_>>();
            match write_conversation_log(&pairs) {
                Ok(path) => self.add_local(format!("Log saved to: {}", path.display())),
                Err(err) => self.error = Some(err.to_string()),
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
            let sessions: Vec<_> = self
                .saved_sessions
                    .iter()
                    .filter(|session| session.agent == self.active_agent)
                    .map(format_session_label)
                    .collect();
            self.add_local(if sessions.is_empty() {
                format!("No saved sessions for agent \"{}\".", self.active_agent)
            } else {
                sessions.join("\n")
            });
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
        if let Some(skill) = text.strip_prefix('/') {
            if self.skills.iter().any(|item| item.name == skill) {
                self.client.send(ClientMessage::Skill {
                    name: skill.to_string(),
                });
                return;
            }
        }

        let user_index = self.static_lines.len();
        self.static_lines.push(ChatLine {
            role: "user".to_string(),
            text: text.clone(),
            tools: Vec::new(),
            duration_ms: None,
        });
        self.undo.push(UndoEntry::Chat { user_index, text: text.clone() });
        self.pending = true;
        self.history_scroll = 0;
        self.client.send(ClientMessage::Chat { message: text });
    }

    fn add_local(&mut self, text: String) {
        let line_index = self.static_lines.len();
        self.static_lines.push(ChatLine {
            role: "assistant".to_string(),
            text,
            tools: Vec::new(),
            duration_ms: None,
        });
        self.undo.push(UndoEntry::Local { line_index });
    }

    fn reset_local_conversation(&mut self) {
        self.static_lines.clear();
        self.streaming = None;
        self.pending = false;
        self.streaming_flag = false;
        self.turn_start = None;
        self.error = None;
        self.context = ContextUsage::default();
        self.fallback = None;
        self.session_id = None;
        self.history_scroll = 0;
        self.markdown_cache.clear();
        self.streaming_md.reset();
        self.undo.clear();
    }

    fn apply_session(&mut self, session: SavedSession) {
        self.session_id = Some(session.id);
        self.session_started_at = session.started_at;
        self.static_lines = session
            .history
            .into_iter()
            .map(|turn| ChatLine {
                role: turn.role,
                text: turn.content,
                tools: Vec::new(),
                duration_ms: None,
            })
            .collect();
        self.streaming = None;
        self.pending = false;
        self.streaming_flag = false;
        self.streaming_md.reset();
        self.markdown_cache.clear();
        self.error = None;
    }

    fn persist_session(&mut self) {
        if self.static_lines.is_empty() || self.active_agent.is_empty() {
            return;
        }
        let history = self
            .static_lines
            .iter()
            .map(|line| ConversationTurn {
                role: line.role.clone(),
                content: line.text.clone(),
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
            SlashCommand { value: "/skills".into(), description: "Browse skills".into() },
            SlashCommand { value: "/mcp".into(), description: "Browse MCP servers".into() },
            SlashCommand { value: "/agent".into(), description: "Browse agents".into() },
            SlashCommand { value: "/resume".into(), description: "Browse saved sessions".into() },
            SlashCommand { value: "/new".into(), description: "Start a new conversation".into() },
            SlashCommand { value: "/log".into(), description: "Export the full conversation log".into() },
        ];

        let skill_commands = self
            .skills
            .iter()
            .map(|skill| SlashCommand {
                value: format!("/{}", skill.name),
                description: skill.description.clone(),
            })
            .collect::<Vec<_>>();

        self.menu_groups_raw = vec![("/skills".to_string(), skill_commands.clone())];
        self.command_groups = vec![("/skills".to_string(), skill_commands)];
    }

    fn current_menu_items(&self) -> Vec<SlashCommand> {
        let groups = self
            .menu_groups_raw
            .iter()
            .map(|(name, items)| (name.as_str(), items.as_slice()))
            .collect::<Vec<_>>();
        self.composer
            .menu_items(&self.commands, &groups)
            .into_iter()
            .cloned()
            .collect()
    }

    fn format_skills(&self) -> String {
        if self.skills.is_empty() {
            return "No skills loaded.".into();
        }
        self.skills
            .iter()
            .map(|skill| format!("• [{}] {} — {}", skill.source.clone().unwrap_or_else(|| "unknown".into()), skill.name, skill.description))
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn format_agents(&self) -> String {
        if self.agents.is_empty() {
            return "No agents loaded.".into();
        }
        self.agents
            .iter()
            .map(|agent| {
                format!(
                    "{}{} — {}",
                    if agent.active { "* " } else { "  " },
                    agent.name,
                    agent.description
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn format_mcp(&self) -> String {
        if self.mcp_servers.is_empty() {
            return "No MCP servers configured.".into();
        }
        self.mcp_servers
            .iter()
            .map(|server| {
                format!(
                    "• [{}] {} ({}) — {}",
                    server.source,
                    server.name,
                    server.transport,
                    if server.connected {
                        format!("connected, {} tools", server.tool_count)
                    } else {
                        format!("failed{}", server.error.as_deref().map(|err| format!(": {err}")).unwrap_or_default())
                    }
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn is_welcome_screen(&self) -> bool {
        self.static_lines.is_empty() && self.streaming.is_none() && !self.waiting_for_reply()
    }

    fn waiting_for_reply(&self) -> bool {
        (self.pending || self.streaming_flag)
            && self.streaming.as_ref().is_none_or(|line| {
                line.text.trim().is_empty() && line.tools.is_empty()
            })
    }

    fn sync_streaming_markdown(&mut self, width: u16) {
        if let Some(line) = self.streaming.as_ref() {
            if line.role == "assistant" {
                self.streaming_md.sync(&line.text, width);
            }
        }
    }

    fn transcript_area(&self, area: Rect) -> Rect {
        self.layout_chunks(area)[0]
    }

    fn layout_chunks(&self, area: Rect) -> Vec<Rect> {
        Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Min(3),
                Constraint::Length(if self.notice.is_some() { 1 } else { 0 }),
                Constraint::Length(if self.history_scroll > 0 { 1 } else { 0 }),
                Constraint::Length(if self.error.is_some() { 1 } else { 0 }),
                Constraint::Length(self.composer_height(area.width)),
                Constraint::Length(1),
            ])
            .split(area)
            .to_vec()
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
            show_banner: show_welcome && !self.banner.is_empty(),
            connecting: matches!(self.connection, ConnectionState::Connecting),
            active_agent: &self.active_agent,
            fallback: self
                .fallback
                .as_ref()
                .map(|value| (value.requested.as_str(), value.active.as_str())),
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
            show_banner: show_welcome && !self.banner.is_empty(),
            connecting: matches!(self.connection, ConnectionState::Connecting),
            active_agent: &self.active_agent,
            fallback: self
                .fallback
                .as_ref()
                .map(|value| (value.requested.as_str(), value.active.as_str())),
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
            self.notice = Some("Nothing to copy".into());
            return;
        };
        if copy_to_clipboard(&text) {
            self.notice = Some("Copied last reply".into());
        } else {
            self.notice = Some("Copy failed — select text with mouse instead".into());
        }
    }
}

fn display_model(model: &str) -> String {
    model
        .rsplit('/')
        .next()
        .unwrap_or(model)
        .to_string()
}

fn copy_to_clipboard(text: &str) -> bool {
    if cfg!(target_os = "macos") {
        std::process::Command::new("pbcopy")
            .stdin(std::process::Stdio::piped())
            .spawn()
            .and_then(|mut child| {
                use std::io::Write;
                if let Some(stdin) = child.stdin.as_mut() {
                    stdin.write_all(text.as_bytes())?;
                }
                child.wait()?;
                Ok(())
            })
            .is_ok()
    } else {
        false
    }
}
