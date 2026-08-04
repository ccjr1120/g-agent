mod commands;
mod events;
mod input;
mod model;
mod panels;
mod sessions;
mod submit;

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
    widgets::{Block, Borders, Paragraph, Widget},
    Terminal,
};
use tokio::sync::mpsc;

pub(super) use ratatui::text::{Line, Span};

pub(super) use crate::agent::client::{
    format_tool_call, AgentClient, AgentEvent, ChatLine, ConnectionState, ContextUsage,
    ToolCallDisplay,
};
pub(super) use crate::protocol::{
    ActiveAgentTurn, AgentInfo, AgentTaskInfo, ClientMessage, ConversationTurn, McpServerInfo,
    ScheduledTaskInfo, SkillInfo,
};
pub(super) use crate::session::{
    build_session_preview, format_session_age, format_session_label, list_sessions, load_session,
    save_session, write_conversation_log, SavedSession, SavedSessionSummary, UndoEntry, UndoStack,
};
pub(super) use crate::ui::composer::{
    command_group_id, menu_height, Composer, ComposerWidget, InputHistory, MenuWidget, SlashCommand,
};
pub(super) use crate::ui::markdown::{MarkdownCache, StreamingMarkdown};
pub(super) use crate::ui::status::{StatusBar, STATUS_HEIGHT};
pub(super) use crate::ui::theme::style;
pub(super) use crate::ui::transcript::{
    assistant_markdown_width, build_transcript_lines, max_history_scroll, TranscriptContent,
    TranscriptWidget,
};
pub(super) use model::PlanDisplay;

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
    skills: Vec<SkillInfo>,
    agents: Vec<AgentInfo>,
    active_agent: String,
    view_agent: String,
    active_child: Option<u64>,
    main_lines: Vec<ChatLine>,
    model: String,
    context: ContextUsage,
    mcp_servers: Vec<McpServerInfo>,
    saved_sessions: Vec<SavedSessionSummary>,
    agent_tasks: Vec<AgentTaskInfo>,
    agent_tasks_updated_at: Instant,
    scheduled_tasks: Vec<ScheduledTaskInfo>,
    scheduled_tasks_updated_at: Instant,
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
    pending_session_open: Option<model::PendingSessionOpen>,
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
            scheduled_tasks: Vec::new(),
            scheduled_tasks_updated_at: Instant::now(),
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

        if !self.visible_scheduled_tasks().is_empty() {
            Paragraph::new(self.scheduled_task_lines(chunks[3].width.saturating_sub(2)))
                .block(
                    Block::default()
                        .title(" Scheduled Tasks ")
                        .borders(Borders::ALL)
                        .border_style(style::border()),
                )
                .render(chunks[3], buf);
        }

        if !self.agent_tasks.is_empty() {
            Paragraph::new(self.agent_task_lines(chunks[4].width.saturating_sub(2)))
                .block(
                    Block::default()
                        .title(" Sub Agents ")
                        .borders(Borders::ALL)
                        .border_style(style::border()),
                )
                .render(chunks[4], buf);
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
        MenuWidget::new(&self.composer, &menu_items).render(chunks[5], buf);
        StatusBar {
            connection: self.connection,
            model: &self.model,
            active_agent: &self.view_agent,
            context: self.context.clone(),
        }
        .render(chunks[6], buf);

        let composer_area = Block::default()
            .borders(Borders::TOP | Borders::BOTTOM)
            .border_style(style::border());
        let inner = composer_area.inner(chunks[7]);
        composer_area.render(chunks[7], buf);
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
            .inner(chunks[7]);
        self.composer.cursor_pos(inner, 2)
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
                    .map(|task| model::agent_task_is_busy(&task.status))
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
        let scheduled_height = if self.visible_scheduled_tasks().is_empty() {
            0
        } else {
            (self.visible_scheduled_tasks().len().min(3) as u16)
                .saturating_mul(2)
                .saturating_add(2)
        };
        Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Min(3),
                Constraint::Length(if self.history_scroll > 0 { 1 } else { 0 }),
                Constraint::Length(plan_height),
                Constraint::Length(scheduled_height),
                Constraint::Length(task_height),
                Constraint::Length(menu_height(&self.composer, &menu_items)),
                Constraint::Length(STATUS_HEIGHT),
                Constraint::Length(self.input_height(area.width)),
            ])
            .split(area)
            .to_vec()
    }
}
