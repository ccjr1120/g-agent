use std::time::Instant;

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::text::{Line, Span};
use ratatui::widgets::{Paragraph, Widget, Wrap};
use unicode_width::UnicodeWidthStr;

use crate::agent::client::{
    AskDisplay, ChatLine, PlanDisplay, PlanStep, ToolCallDisplay, ToolStatus, TurnSegment,
};
use crate::ui::app::PendingAsk;
use crate::ui::markdown::{render_inline_markdown, LinkRegion, MarkdownCache};
use crate::ui::spinner::spinner_line;
use crate::ui::theme::style;

const USER_PREFIX: &str = "> ";
const USER_CONTINUATION: &str = "  ";
const ASSISTANT_BULLET: &str = "●";
const ASSISTANT_PREFIX: &str = "● ";
const ASSISTANT_CONTINUATION: &str = "  ";
const THINKING_CONTINUATION: &str = "  ";
/// Left gutter for transcript content (terminal columns; user-facing "2px").
const TRANSCRIPT_LEFT_PADDING: u16 = 1;
/// Blank lines above the startup banner for breathing room from the terminal top.
const BANNER_TOP_PADDING_LINES: usize = 2;
/// Thinking blocks longer than this are collapsed until the user toggles them.
const THINKING_COLLAPSE_LINES: usize = 8;
const THINKING_COLLAPSE_SHOWN: usize = 4;
/// Tool calls beyond the most recent few are collapsed (like thinking) until
/// the user toggles expansion with Ctrl+T.
const TOOL_COLLAPSE_VISIBLE: usize = 2;

fn content_width(viewport_width: u16) -> u16 {
    viewport_width
        .saturating_sub(TRANSCRIPT_LEFT_PADDING)
        .max(1)
}

fn center_line_with_offset(text: &str, viewport_width: u16, left_offset: u16) -> String {
    let line_width = text.width();
    let viewport = viewport_width.max(1) as usize;
    if line_width >= viewport {
        return text.to_string();
    }
    let pad = (viewport - line_width) / 2;
    let pad = pad.saturating_sub(left_offset as usize);
    format!("{}{}", " ".repeat(pad), text)
}

fn assistant_leading_spans() -> Vec<Span<'static>> {
    vec![
        Span::styled(ASSISTANT_BULLET.to_string(), style::assistant_bullet()),
        Span::raw(" "),
    ]
}

pub struct TranscriptContent<'a> {
    pub lines: &'a [ChatLine],
    pub streaming: Option<&'a ChatLine>,
    pub waiting: bool,
    pub banner: &'a [String],
    pub show_welcome: bool,
    pub connecting: bool,
    pub disconnected: bool,
    pub active_agent: &'a str,
    pub fallback: Option<(&'a str, &'a str)>,
    pub clock: Instant,
    pub turn_start: Option<Instant>,
    /// When set, the most recent tool call is still running and its elapsed
    /// time should tick on the last tool line.
    pub tool_elapsed: Option<Instant>,
    /// Show full thinking blocks instead of collapsing long ones.
    pub expand_thinking: bool,
    /// The in-flight `ask_user` question awaiting a reply. Its discrete options
    /// render under the question in the transcript so the user can pick one
    /// with ↑/↓ + Enter; `None` when no question is pending.
    pub ask: Option<&'a PendingAsk>,
    pub width: u16,
}

pub fn build_transcript_lines(
    content: &TranscriptContent<'_>,
    markdown: &mut MarkdownCache,
) -> (Vec<Line<'static>>, Vec<LinkRegion>) {
    let mut rendered: Vec<Line<'static>> = Vec::new();
    let mut links: Vec<LinkRegion> = Vec::new();
    let width = content_width(content.width.max(1));

    if content.disconnected {
        rendered.push(Line::from(Span::styled(
            "! Connection lost — reconnecting…",
            style::warning(),
        )));
    }

    if !content.banner.is_empty() {
        for _ in 0..BANNER_TOP_PADDING_LINES {
            rendered.push(Line::from(""));
        }
        let banner_width = content.width.max(1);
        for line in content.banner {
            rendered.push(Line::from(Span::styled(
                center_line_with_offset(line, banner_width, TRANSCRIPT_LEFT_PADDING),
                style::banner(),
            )));
        }
        rendered.push(Line::from(""));
    }

    if content.show_welcome {
        if content.connecting {
            rendered.push(spinner_line("Connecting…", content.clock, None, false));
        } else {
            rendered.push(Line::from(vec![Span::styled(
                if content.active_agent.is_empty() {
                    "Choose an agent with /agent <name>. Use / for commands.".to_string()
                } else {
                    format!(
                        "Agent: {}. Enter to send, /back to return, / for commands.",
                        content.active_agent
                    )
                },
                style::welcome(),
            )]));
            if let Some((requested, active)) = content.fallback {
                rendered.push(Line::from(Span::styled(
                    format!(
                        "Configured agent \"{requested}\" not found, using built-in \"{active}\"."
                    ),
                    style::warning(),
                )));
            }
        }
        rendered.push(Line::from(""));
    }

    // Keep queued follow-ups after the live turn so order stays
    // user → reply → queued, not user → queued → reply.
    for line in content.lines.iter().filter(|line| !line.queued) {
        push_chat_line(
            &mut rendered,
            &mut links,
            line,
            width,
            markdown,
            content.expand_thinking,
            content.ask,
        );
    }

    if content.waiting {
        if let Some(line) = content.streaming {
            push_streaming_line(
                &mut rendered,
                &mut links,
                line,
                width,
                markdown,
                content.tool_elapsed,
                content.expand_thinking,
                content.ask,
            );
        }
        // Keep a loading indicator visible for the whole turn — while the
        // model reasons, runs tools, or pauses between bursts of streamed
        // output. A turn is only "done" when `waiting` clears, so the screen
        // should never look frozen with no animation while it is still active.
        let tool_running = content.streaming.is_some_and(|line| {
            line.segments.iter().any(|segment| {
                matches!(segment, TurnSegment::Tool(tool) if tool.status == ToolStatus::Running)
            })
        });
        let has_content = content.streaming.is_some_and(|line| {
            !line.segments.is_empty() || !line.pending_thinking.trim().is_empty()
        });
        let label = if tool_running || has_content {
            "Working…"
        } else {
            "Thinking…"
        };
        rendered.push(spinner_line(label, content.clock, content.turn_start, false));
    } else if let Some(line) = content.streaming {
        push_streaming_line(
            &mut rendered,
            &mut links,
            line,
            width,
            markdown,
            content.tool_elapsed,
            content.expand_thinking,
            content.ask,
        );
    }

    for line in content.lines.iter().filter(|line| line.queued) {
        push_chat_line(
            &mut rendered,
            &mut links,
            line,
            width,
            markdown,
            content.expand_thinking,
            content.ask,
        );
    }

    (rendered, links)
}

#[allow(clippy::too_many_arguments)]
fn push_streaming_line(
    lines: &mut Vec<Line<'static>>,
    links: &mut Vec<LinkRegion>,
    line: &ChatLine,
    width: u16,
    markdown: &mut MarkdownCache,
    tool_elapsed: Option<Instant>,
    expand_thinking: bool,
    ask: Option<&PendingAsk>,
) {
    if line.role == "user" {
        push_chat_line(lines, links, line, width, markdown, expand_thinking, None);
        return;
    }

    let last_tool = line
        .segments
        .iter()
        .rposition(|segment| matches!(segment, TurnSegment::Tool(_)));
    let tool_hidden = collapsed_tool_count(&line.segments, expand_thinking);
    let mut tools_seen = 0usize;
    let mut tool_hint_rendered = false;
    let mut text_rendered = false;
    let mut bullet_emitted = false;
    let mut prev: Option<BlockKind> = None;
    for (index, segment) in line.segments.iter().enumerate() {
        match segment {
            TurnSegment::Tool(tool) => {
                tools_seen += 1;
                if let Some(hidden) = tool_hidden {
                    if tools_seen <= hidden {
                        continue;
                    }
                }
                prev = push_block_gap(lines, prev, BlockKind::Tool);
                let collapse_hint = if !tool_hint_rendered {
                    tool_hidden.map(|hidden| {
                        let noun = if hidden == 1 { "call" } else { "calls" };
                        format!("+{hidden} more {noun} · Ctrl+T")
                    })
                } else {
                    None
                };
                tool_hint_rendered = true;
                let elapsed = if Some(index) == last_tool {
                    tool_elapsed.map(|start| start.elapsed())
                } else {
                    None
                };
                lines.push(tool_line(tool, elapsed, collapse_hint));
            }
            TurnSegment::Thinking(text) => {
                if text.trim().is_empty() {
                    continue;
                }
                prev = push_block_gap(lines, prev, BlockKind::Thinking);
                push_thinking_text(lines, text, expand_thinking);
            }
            TurnSegment::Text(text) => {
                if text.trim().is_empty() {
                    continue;
                }
                prev = push_block_gap(lines, prev, BlockKind::Text);
                push_assistant_body(lines, links, text, width, markdown, !bullet_emitted);
                bullet_emitted = true;
                text_rendered = true;
            }
            TurnSegment::Plan(plan) => {
                prev = push_block_gap(lines, prev, BlockKind::Plan);
                push_plan_block(lines, plan);
                text_rendered = true;
            }
            TurnSegment::Ask(ask_display) => {
                prev = push_block_gap(lines, prev, BlockKind::Ask);
                push_ask_message(lines, ask_display, ask);
            }
            TurnSegment::Reply(text) => {
                prev = push_block_gap(lines, prev, BlockKind::Reply);
                lines.push(Line::from(vec![
                    Span::styled(USER_PREFIX, style::user_message()),
                    Span::styled(text.clone(), style::user_message()),
                ]));
            }
        }
    }
    if !line.pending_thinking.trim().is_empty() {
        prev = push_block_gap(lines, prev, BlockKind::Thinking);
        push_thinking_text(lines, &line.pending_thinking, expand_thinking);
    }
    if !line.pending_text.trim().is_empty() {
        prev = push_block_gap(lines, prev, BlockKind::Text);
        push_assistant_body(lines, links, &line.pending_text, width, markdown, !bullet_emitted);
        bullet_emitted = true;
        text_rendered = true;
    }
    // Guard for streaming lines restored before the timeline existed (and for
    // lines that only carried plain text): render the accumulated text last.
    if !text_rendered && !line.text.trim().is_empty() {
        push_block_gap(lines, prev, BlockKind::Text);
        push_assistant_body(lines, links, &line.text, width, markdown, !bullet_emitted);
    }
    if !line.segments.is_empty()
        || !line.pending_thinking.trim().is_empty()
        || !line.pending_text.trim().is_empty()
        || !line.text.trim().is_empty()
    {
        lines.push(Line::from(""));
    }
}

pub fn max_history_scroll(
    content: &TranscriptContent<'_>,
    markdown: &mut MarkdownCache,
    height: u16,
) -> u16 {
    if height == 0 {
        return 0;
    }
    let (lines, _) = build_transcript_lines(content, markdown);
    let total = line_count(&lines, content_width(content.width.max(1)));
    total.saturating_sub(height)
}

fn line_count(lines: &[Line<'_>], width: u16) -> u16 {
    lines.iter().map(|line| line_row_count(line, width)).sum()
}

fn line_row_count(line: &Line<'_>, width: u16) -> u16 {
    let text: String = line
        .spans
        .iter()
        .map(|span| span.content.as_ref())
        .collect();
    if text.is_empty() {
        1
    } else {
        wrap_text_rows(&text, width.max(1) as usize) as u16
    }
}

fn wrap_text_rows(text: &str, width: usize) -> usize {
    let mut rows = 1usize;
    let mut used = 0usize;
    for ch in text.chars() {
        let piece = if ch == '\t' { "    " } else { &ch.to_string() };
        let piece_width = piece.width();
        if used + piece_width > width && used > 0 {
            rows += 1;
            used = piece_width;
        } else {
            used += piece_width;
        }
    }
    rows.max(1)
}

/// Convert history offset (0 = follow live bottom) to ratatui paragraph scroll.
pub fn paragraph_scroll_y(total_lines: u16, viewport_height: u16, history_offset: u16) -> u16 {
    let max_history = total_lines.saturating_sub(viewport_height);
    max_history.saturating_sub(history_offset.min(max_history))
}

pub struct TranscriptWidget {
    pub lines: Vec<Line<'static>>,
    pub scroll: u16,
}

impl Widget for TranscriptWidget {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let rendered = self.lines;
        let content_area = Rect {
            x: area.x.saturating_add(TRANSCRIPT_LEFT_PADDING),
            y: area.y,
            width: content_width(area.width),
            height: area.height,
        };
        let width = content_area.width.max(1);

        let total_lines = line_count(&rendered, width);
        let scroll_y = paragraph_scroll_y(total_lines, content_area.height, self.scroll);

        let paragraph = Paragraph::new(rendered)
            .wrap(Wrap { trim: false })
            .scroll((scroll_y, 0));
        paragraph.render(content_area, buf);
    }
}

fn push_chat_line(
    lines: &mut Vec<Line<'static>>,
    links: &mut Vec<LinkRegion>,
    line: &ChatLine,
    width: u16,
    markdown: &mut MarkdownCache,
    expand_thinking: bool,
    ask: Option<&PendingAsk>,
) {
    match line.role.as_str() {
        "user" => push_user_text(lines, &line.text, line.queued),
        "error" => {
            for chunk in line.text.lines() {
                lines.push(Line::from(Span::styled(
                    format!("! {chunk}"),
                    style::error(),
                )));
            }
        }
        // System feedback (e.g. "/reload", copy confirmations) and command
        // results (/log, /resume all) are not assistant replies — keep them
        // visually distinct from the assistant's own voice.
        "status" | "local" => {
            for chunk in line.text.lines() {
                lines.push(Line::from(vec![
                    Span::styled("ℹ ", style::system()),
                    Span::styled(chunk.to_string(), style::system()),
                ]));
            }
        }
        // A blocking ask_user question (fallback path when no live turn). Live
        // questions render as `Ask` segments of the turn; this keeps the "? "
        // brand styling for the rare static case.
        "ask" => {
            for chunk in line.text.lines() {
                lines.push(Line::from(vec![
                    Span::styled("? ", style::ask()),
                    Span::styled(chunk.to_string(), style::ask()),
                ]));
            }
        }
        _ => {
            let tool_hidden = collapsed_tool_count(&line.segments, expand_thinking);
            let mut tools_seen = 0usize;
            let mut tool_hint_rendered = false;
            let mut bullet_emitted = false;
            let mut prev: Option<BlockKind> = None;
            for segment in &line.segments {
                match segment {
                    TurnSegment::Tool(tool) => {
                        tools_seen += 1;
                        if let Some(hidden) = tool_hidden {
                            if tools_seen <= hidden {
                                continue;
                            }
                        }
                        prev = push_block_gap(lines, prev, BlockKind::Tool);
                        let collapse_hint = if !tool_hint_rendered {
                            tool_hidden.map(|hidden| {
                                let noun = if hidden == 1 { "call" } else { "calls" };
                                format!("+{hidden} more {noun} · Ctrl+T")
                            })
                        } else {
                            None
                        };
                        tool_hint_rendered = true;
                        lines.push(tool_line(tool, None, collapse_hint));
                    }
                    TurnSegment::Thinking(text) => {
                        if text.trim().is_empty() {
                            continue;
                        }
                        prev = push_block_gap(lines, prev, BlockKind::Thinking);
                        push_thinking_text(lines, text, expand_thinking);
                    }
                    TurnSegment::Text(text) => {
                        if text.trim().is_empty() {
                            continue;
                        }
                        prev = push_block_gap(lines, prev, BlockKind::Text);
                        push_assistant_body(lines, links, text, width, markdown, !bullet_emitted);
                        bullet_emitted = true;
                    }
                    TurnSegment::Plan(plan) => {
                        prev = push_block_gap(lines, prev, BlockKind::Plan);
                        push_plan_block(lines, plan);
                    }
                    TurnSegment::Ask(ask_display) => {
                        prev = push_block_gap(lines, prev, BlockKind::Ask);
                        push_ask_message(lines, ask_display, ask);
                    }
                    TurnSegment::Reply(text) => {
                        prev = push_block_gap(lines, prev, BlockKind::Reply);
                        lines.push(Line::from(vec![
                            Span::styled(USER_PREFIX, style::user_message()),
                            Span::styled(text.clone(), style::user_message()),
                        ]));
                    }
                }
            }
            // Guard for lines restored before the timeline existed: their text
            // lives only in `text`, not in a Text segment.
            let text_in_segments = line.segments.iter().any(|segment| {
                matches!(segment, TurnSegment::Text(_) | TurnSegment::Plan(_))
            });
            if !text_in_segments && !line.text.trim().is_empty() {
                push_block_gap(lines, prev, BlockKind::Text);
                push_assistant_body(lines, links, &line.text, width, markdown, !bullet_emitted);
            }
        }
    }

    if let Some(duration) = line.duration_ms {
        lines.push(Line::from(Span::styled(
            format!("· {:.1}s", duration as f64 / 1000.0),
            style::muted(),
        )));
    }

    lines.push(Line::from(""));
}

/// Render a thinking block. Long blocks are collapsed to a few lines with the
/// "more" hint appended to the last shown line (never on its own line) unless
/// the user has toggled expansion.
fn push_thinking_text(lines: &mut Vec<Line<'static>>, text: &str, expand: bool) {
    if text.trim().is_empty() {
        return;
    }
    let style = style::thinking();
    let chunks: Vec<&str> = text.lines().collect();
    let hidden = chunks.len().saturating_sub(THINKING_COLLAPSE_LINES);
    if hidden > 0 && !expand {
        let shown = THINKING_COLLAPSE_SHOWN.min(chunks.len());
        for (index, chunk) in chunks.iter().take(shown).enumerate() {
            let mut spans = vec![
                Span::styled(THINKING_CONTINUATION, style),
                Span::styled(chunk.to_string(), style),
            ];
            if index + 1 == shown {
                let noun = if hidden == 1 { "line" } else { "lines" };
                spans.push(Span::styled(
                    format!(" ··· {hidden} more {noun} · Ctrl+T"),
                    style::muted(),
                ));
            }
            lines.push(Line::from(spans));
        }
        return;
    }
    for chunk in chunks {
        lines.push(Line::from(vec![
            Span::styled(THINKING_CONTINUATION, style),
            Span::styled(chunk.to_string(), style),
        ]));
    }
}

fn push_user_text(lines: &mut Vec<Line<'static>>, text: &str, queued: bool) {
    if text.is_empty() {
        return;
    }
    for (index, chunk) in text.lines().enumerate() {
        let prefix = if index == 0 {
            if queued {
                "⏳ "
            } else {
                USER_PREFIX
            }
        } else {
            USER_CONTINUATION
        };
        let style = if queued {
            style::user_message_queued()
        } else {
            style::user_message()
        };
        lines.push(Line::from(user_line_spans(chunk, prefix, style)));
    }
}

fn user_line_spans(
    chunk: &str,
    prefix: &str,
    base_style: ratatui::style::Style,
) -> Vec<Span<'static>> {
    vec![
        Span::styled(prefix.to_string(), base_style),
        Span::styled(chunk.to_string(), base_style),
    ]
}

/// Render an `ask_user` question with its discrete options directly under it,
/// so the user can pick one where the question lives. While the question is
/// pending the currently selected option is highlighted (`❯`); committed
/// questions keep their options as a plain historical record.
fn push_ask_message(lines: &mut Vec<Line<'static>>, ask_display: &AskDisplay, ask: Option<&PendingAsk>) {
    for chunk in ask_display.question.lines() {
        lines.push(Line::from(vec![
            Span::styled("? ", style::ask()),
            Span::styled(chunk.to_string(), style::ask()),
        ]));
    }
    if ask_display.options.is_empty() {
        return;
    }
    let pending = ask.filter(|pending| pending.id == ask_display.id);
    for (index, option) in ask_display.options.iter().enumerate() {
        let is_selected = pending.is_some_and(|pending| index == pending.selected);
        let style = if is_selected { style::ask() } else { style::ask_hint() };
        let prefix = if is_selected { "❯ " } else { "  " };
        lines.push(Line::from(vec![
            Span::styled(prefix.to_string(), style),
            Span::styled(option.clone(), style),
        ]));
    }
}

fn push_assistant_plain(lines: &mut Vec<Line<'static>>, text: &str, bullet: bool) {
    if text.trim().is_empty() {
        return;
    }
    for (index, chunk) in text.lines().enumerate() {
        if index == 0 {
            let mut spans = if bullet {
                assistant_leading_spans()
            } else {
                vec![Span::raw(ASSISTANT_CONTINUATION)]
            };
            spans.push(Span::raw(chunk.to_string()));
            lines.push(Line::from(spans));
        } else {
            lines.push(Line::from(vec![
                Span::raw(ASSISTANT_CONTINUATION),
                Span::raw(chunk.to_string()),
            ]));
        }
    }
}

/// Prefix a rendered markdown body: the first line carries the assistant
/// bullet when this is the reply's first body block; every other line (and
/// any later body block of the same reply) uses the plain continuation indent
/// so one assistant reply shows a single `●`.
fn prefix_assistant_lines(body: &[Line<'static>], bullet: bool) -> Vec<Line<'static>> {
    body.iter()
        .enumerate()
        .map(|(index, line)| {
            let mut spans = if index == 0 && bullet {
                assistant_leading_spans()
            } else {
                vec![Span::raw(ASSISTANT_CONTINUATION)]
            };
            spans.extend(line.spans.iter().cloned());
            Line::from(spans)
        })
        .collect()
}

fn assistant_body_width(viewport_width: u16) -> u16 {
    content_width(viewport_width)
        .saturating_sub(ASSISTANT_PREFIX.width() as u16)
        .max(1)
}

fn push_assistant_body(
    lines: &mut Vec<Line<'static>>,
    links: &mut Vec<LinkRegion>,
    text: &str,
    width: u16,
    markdown: &mut MarkdownCache,
    bullet: bool,
) {
    if text.trim().is_empty() {
        return;
    }
    let body_width = assistant_body_width(width);
    let (rendered, rendered_links) = markdown.render_static_with_links(text, body_width);
    if rendered.is_empty() {
        push_assistant_plain(lines, text, bullet);
        return;
    }
    let base = lines.len() as u16;
    lines.extend(prefix_assistant_lines(rendered, bullet));
    for region in rendered_links {
        links.push(offset_link_region(region, base, 2));
    }
}

/// Shift a link region from "markdown block" space into the transcript lines
/// vec: offset the line index by `base_line` and columns by `col_offset`
/// (the assistant "● " / "  " prefix).
fn offset_link_region(region: &LinkRegion, base_line: u16, col_offset: u16) -> LinkRegion {
    LinkRegion {
        line: base_line.saturating_add(region.line),
        col_start: region.col_start.saturating_add(col_offset),
        col_end: region.col_end.saturating_add(col_offset),
        url: region.url.clone(),
    }
}

/// A clickable link on the terminal screen (0-based row/columns).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScreenLinkRegion {
    pub row: u16,
    pub col_start: u16,
    pub col_end: u16,
    pub url: String,
}

/// Map link regions (indexed into the rendered transcript lines) to absolute
/// screen coordinates, accounting for the transcript's left padding, the
/// paragraph's vertical scroll, and clipping to the visible viewport.
pub fn link_regions_to_screen(
    lines: &[Line<'static>],
    regions: &[LinkRegion],
    content_area: Rect,
    scroll: u16,
) -> Vec<ScreenLinkRegion> {
    if regions.is_empty() {
        return Vec::new();
    }
    let total = line_count(lines, content_area.width.max(1));
    let scroll_y = paragraph_scroll_y(total, content_area.height, scroll);
    let mut out = Vec::new();
    for region in regions {
        let Some(row) = content_area
            .y
            .checked_add(region.line)
            .and_then(|y| y.checked_sub(scroll_y))
        else {
            continue;
        };
        if row >= content_area.bottom() {
            continue;
        }
        out.push(ScreenLinkRegion {
            row,
            col_start: content_area.x.saturating_add(region.col_start),
            col_end: content_area.x.saturating_add(region.col_end),
            url: region.url.clone(),
        });
    }
    out
}

/// The transcript widget's content rect (left padding applied, markdown width).
pub fn transcript_content_area(area: Rect) -> Rect {
    Rect {
        x: area.x.saturating_add(TRANSCRIPT_LEFT_PADDING),
        y: area.y,
        width: content_width(area.width),
        height: area.height,
    }
}

fn tool_line(
    tool: &ToolCallDisplay,
    elapsed: Option<std::time::Duration>,
    collapse_hint: Option<String>,
) -> Line<'static> {
    let mut spans = vec![Span::styled(
        format!("▸ {}", tool.label),
        style::tool_call(),
    )];
    if elapsed.is_some() && tool.status == ToolStatus::Running {
        let seconds = elapsed.unwrap_or_default().as_secs();
        spans.push(Span::styled(
            format!(" · {:02}:{:02}", seconds / 60, seconds % 60),
            style::tool_running(),
        ));
    }
    match tool.status {
        ToolStatus::Done => {
            spans.push(Span::styled(" ✓", style::success()));
        }
        ToolStatus::Failed => {
            spans.push(Span::styled(" ✗", style::error()));
        }
        ToolStatus::Running => {}
    }
    if let Some(hint) = collapse_hint {
        spans.push(Span::styled(format!("  {hint}"), style::muted()));
    }
    Line::from(spans)
}

/// Build the styled spans for one plan step (status icon + inline markdown).
/// Shared with the Plan panel so the transcript's completed plan matches the
/// panel exactly.
pub fn plan_step_spans(step: &PlanStep, text: &str) -> Vec<Span<'static>> {
    let (icon, step_style) = match step.status.as_str() {
        "completed" => ("✓", style::success()),
        "in_progress" => ("●", style::brand_bold()),
        _ => ("○", style::muted()),
    };
    let mut spans = vec![Span::styled(format!(" {icon} "), step_style)];
    spans.extend(render_inline_markdown(text, step_style));
    spans
}

/// How many of the oldest tool calls should be hidden (matching the thinking
/// collapse) until the user expands with Ctrl+T. `None` when nothing is hidden.
fn collapsed_tool_count(segments: &[TurnSegment], expand: bool) -> Option<usize> {
    if expand {
        return None;
    }
    let total = segments
        .iter()
        .filter(|segment| matches!(segment, TurnSegment::Tool(_)))
        .count();
    let hidden = total.saturating_sub(TOOL_COLLAPSE_VISIBLE);
    (hidden > 0).then_some(hidden)
}

/// The kind of transcript block, used to space different kinds apart while
/// keeping consecutive items of the same kind grouped (e.g. tool calls).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BlockKind {
    Tool,
    Thinking,
    Text,
    Plan,
    Ask,
    Reply,
}

/// Insert a blank line between blocks unless they are consecutive items of the
/// same *non-text* kind. Consecutive body texts are always separated (a model
/// that pauses to think between two paragraphs should still show a gap), while
/// tool calls and thinking lines stay grouped until a different kind arrives.
fn push_block_gap(
    lines: &mut Vec<Line<'static>>,
    prev: Option<BlockKind>,
    next: BlockKind,
) -> Option<BlockKind> {
    match prev {
        // Different kinds always get breathing room.
        Some(prev) if prev != next => lines.push(Line::from("")),
        // Two body texts never merge into one block.
        Some(BlockKind::Text) if next == BlockKind::Text => lines.push(Line::from("")),
        _ => {}
    }
    Some(next)
}

/// Render a completed plan as a transcript message in the style of the Plan
/// panel: a title line, a blank spacer, then the step lines.
fn push_plan_block(lines: &mut Vec<Line<'static>>, plan: &PlanDisplay) {
    let completed = plan
        .steps
        .iter()
        .filter(|step| step.status == "completed")
        .count();
    lines.push(Line::from(Span::styled(
        format!(" Plan {completed}/{} ", plan.steps.len()),
        style::muted(),
    )));
    lines.push(Line::from(""));
    for step in &plan.steps {
        lines.push(Line::from(plan_step_spans(step, &step.text)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::client::ChatLine;
    use crate::ui::markdown::MarkdownCache;
    use std::time::Instant;

    fn sample_line(role: &str, text: &str, queued: bool) -> ChatLine {
        ChatLine {
            role: role.to_string(),
            text: text.to_string(),
            sent_content: None,
            segments: Vec::new(),
            pending_thinking: String::new(),
            pending_text: String::new(),
            duration_ms: None,
            queued,
        }
    }

    #[test]
    fn paragraph_scroll_follows_bottom_when_offset_zero() {
        assert_eq!(paragraph_scroll_y(100, 20, 0), 80);
    }

    #[test]
    fn paragraph_scroll_reaches_top_at_max_history() {
        assert_eq!(paragraph_scroll_y(100, 20, 80), 0);
    }

    #[test]
    fn content_width_reserves_left_padding() {
        assert_eq!(content_width(80), 79);
        assert_eq!(content_width(1), 1);
    }

    #[test]
    fn assistant_links_are_tracked_with_prefix_offset() {
        let assistant = sample_line("assistant", "see [docs](https://example.com/docs)", false);
        let content = TranscriptContent {
            lines: &[assistant],
            streaming: None,
            waiting: false,
            banner: &[],
            show_welcome: false,
            connecting: false,
            active_agent: "default",
            fallback: None,
            clock: Instant::now(),
            turn_start: None,
            disconnected: false,
            tool_elapsed: None,
            expand_thinking: false,
            ask: None,
            width: 120,
        };
        let mut markdown = MarkdownCache::new();
        let (rendered, links) =
            build_transcript_lines(&content, &mut markdown);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].url, "https://example.com/docs");
        let text: String = rendered[links[0].line as usize]
            .spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect();
        let byte_idx = text.find("docs").unwrap();
        let offset = text[..byte_idx].width() as u16;
        assert_eq!(links[0].col_start, offset);
        assert_eq!(links[0].col_end, offset + "docs".len() as u16);
    }

    #[test]
    fn link_regions_map_to_screen_with_scroll() {
        let lines = vec![
            Line::from(""),
            Line::from("first reply"),
            Line::from("see [docs](https://example.com) here"),
            Line::from("tail"),
        ];
        let regions = vec![LinkRegion {
            line: 2,
            col_start: 4,
            col_end: 8,
            url: "https://example.com".into(),
        }];
        // 4 content rows in a 2-row viewport, scrolled up by 1 → link row 2 − 1.
        let content_area = Rect::new(1, 0, 100, 2);
        let screen = link_regions_to_screen(&lines, &regions, content_area, 1);
        assert_eq!(screen.len(), 1);
        assert_eq!(screen[0].row, 1);
        assert_eq!(screen[0].col_start, 5);
        assert_eq!(screen[0].col_end, 9);
        // A region scrolled out of view (above the viewport) is dropped.
        let scrolled = link_regions_to_screen(&lines, &regions, Rect::new(1, 0, 100, 1), 0);
        assert!(scrolled.is_empty());
    }

    #[test]
    fn queued_messages_render_after_streaming_reply() {
        let lines = vec![
            sample_line("user", "first", false),
            sample_line("user", "queued-second", true),
        ];
        let streaming = sample_line("assistant", "reply-to-first", false);
        let content = TranscriptContent {
            lines: &lines,
            streaming: Some(&streaming),
            waiting: false,
            banner: &[],
            show_welcome: false,
            connecting: false,
            active_agent: "default",
            fallback: None,
            clock: Instant::now(),
            turn_start: None,
            disconnected: false,
            tool_elapsed: None,
            expand_thinking: false,
            ask: None,
            width: 80,
        };
        let mut markdown = MarkdownCache::new();
        let (rendered, _) = build_transcript_lines(&content, &mut markdown);
        let joined: String = rendered
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");

        let first = joined.find("first").expect("first user prompt");
        let reply = joined.find("reply-to-first").expect("streaming reply");
        let queued = joined.find("queued-second").expect("queued follow-up");
        assert!(first < reply, "user should precede its reply");
        assert!(
            reply < queued,
            "queued follow-up should come after the live reply"
        );
    }

    #[test]
    fn error_renders_in_transcript_order_before_queued_message() {
        let lines = vec![
            sample_line("user", "first", false),
            sample_line("error", "The operation timed out.", false),
            sample_line("user", "queued-second", true),
        ];
        let content = TranscriptContent {
            lines: &lines,
            streaming: None,
            waiting: false,
            banner: &[],
            show_welcome: false,
            connecting: false,
            active_agent: "default",
            fallback: None,
            clock: Instant::now(),
            turn_start: None,
            disconnected: false,
            tool_elapsed: None,
            expand_thinking: false,
            ask: None,
            width: 80,
        };
        let mut markdown = MarkdownCache::new();
        let (rendered, _) =
            build_transcript_lines(&content, &mut markdown);
        let joined = rendered
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");

        let first = joined.find("first").expect("first prompt");
        let error = joined.find("The operation timed out.").expect("turn error");
        let queued = joined.find("queued-second").expect("queued prompt");
        assert!(first < error);
        assert!(error < queued);
    }

    #[test]
    fn local_feedback_renders_in_message_order() {
        let lines = vec![
            sample_line("user", "before-command", false),
            sample_line("local", "sub-session opened", false),
            sample_line("user", "after-command", false),
        ];
        let content = TranscriptContent {
            lines: &lines,
            streaming: None,
            waiting: false,
            banner: &[],
            show_welcome: false,
            connecting: false,
            active_agent: "default",
            fallback: None,
            clock: Instant::now(),
            turn_start: None,
            disconnected: false,
            tool_elapsed: None,
            expand_thinking: false,
            ask: None,
            width: 80,
        };
        let mut markdown = MarkdownCache::new();
        let (rendered, _) =
            build_transcript_lines(&content, &mut markdown);
        let joined = rendered
            .iter()
            .flat_map(|line| line.spans.iter())
            .map(|span| span.content.as_ref())
            .collect::<String>();

        let before = joined.find("before-command").expect("first message");
        let feedback = joined.find("sub-session opened").expect("local feedback");
        let after = joined.find("after-command").expect("last message");
        assert!(before < feedback && feedback < after);
    }

    fn render_single(line: ChatLine) -> String {
        let content = TranscriptContent {
            lines: &[line],
            streaming: None,
            waiting: false,
            banner: &[],
            show_welcome: false,
            connecting: false,
            disconnected: false,
            active_agent: "default",
            fallback: None,
            clock: Instant::now(),
            turn_start: None,
            tool_elapsed: None,
            expand_thinking: false,
            ask: None,
            width: 120,
        };
        let mut markdown = MarkdownCache::new();
        let (rendered, _) =
            build_transcript_lines(&content, &mut markdown);
        rendered
            .iter()
            .flat_map(|line| line.spans.iter())
            .map(|span| span.content.as_ref())
            .collect::<String>()
    }

    #[test]
    fn tools_render_completion_status() {
        let mut line = sample_line("assistant", "done", false);
        line.segments = vec![
            TurnSegment::Tool(ToolCallDisplay {
                name: "bash".into(),
                label: "ls -la".into(),
                status: ToolStatus::Done,
            }),
            TurnSegment::Tool(ToolCallDisplay {
                name: "read".into(),
                label: "README.md".into(),
                status: ToolStatus::Failed,
            }),
        ];
        let joined = render_single(line);
        assert!(joined.contains("✓"), "done tool should show a check");
        assert!(joined.contains("✗"), "failed tool should show a cross");
    }

    #[test]
    fn tool_lines_use_a_clean_marker_not_emoji() {
        let mut line = sample_line("assistant", "done", false);
        line.segments = vec![
            TurnSegment::Tool(ToolCallDisplay {
                name: "bash".into(),
                label: "ls -la".into(),
                status: ToolStatus::Done,
            }),
            TurnSegment::Tool(ToolCallDisplay {
                name: "mcp__git__commit".into(),
                label: "git/commit".into(),
                status: ToolStatus::Running,
            }),
        ];
        let joined = render_single(line);
        for emoji in ["🐚", "🔌", "📖", "📝", "📁", "🔍", "🔧"] {
            assert!(!joined.contains(emoji), "tool line must not use {emoji}");
        }
        assert!(
            joined.contains("▸ ls -la") && joined.contains("▸ git/commit"),
            "tool lines open with a single-width marker"
        );
    }

    #[test]
    fn one_assistant_bullet_per_reply_regardless_of_text_blocks() {
        let mut line = sample_line("assistant", "", false);
        line.segments = vec![
            TurnSegment::Text("First body paragraph".into()),
            TurnSegment::Tool(ToolCallDisplay {
                name: "read".into(),
                label: "index.ts".into(),
                status: ToolStatus::Done,
            }),
            TurnSegment::Text("Second body paragraph".into()),
        ];
        let content = TranscriptContent {
            lines: &[line],
            streaming: None,
            waiting: false,
            banner: &[],
            show_welcome: false,
            connecting: false,
            disconnected: false,
            active_agent: "default",
            fallback: None,
            clock: Instant::now(),
            turn_start: None,
            tool_elapsed: None,
            expand_thinking: true,
            ask: None,
            width: 120,
        };
        let mut markdown = MarkdownCache::new();
        let (rendered, _) = build_transcript_lines(&content, &mut markdown);
        let joined: Vec<String> = rendered
            .iter()
            .map(|l| {
                l.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect();
        let bullets = joined
            .iter()
            .filter(|l| l.starts_with("●"))
            .count();
        assert_eq!(bullets, 1, "one reply carries exactly one bullet: {joined:?}");
        let first = joined.iter().position(|l| l.contains("First body")).unwrap();
        let second = joined.iter().position(|l| l.contains("Second body")).unwrap();
        assert!(
            joined[second].starts_with("  ") && !joined[second].starts_with("●"),
            "later body blocks use the continuation indent, not a fresh bullet"
        );
        assert!(first < second);
    }

    #[test]
    fn narrow_terminal_keeps_content_aligned_under_the_bullet() {
        let mut line = sample_line("assistant", "", false);
        line.segments = vec![TurnSegment::Text(
            "This sentence is long enough to wrap more than once even on a narrow terminal"
                .into(),
        )];
        let content = TranscriptContent {
            lines: &[line],
            streaming: None,
            waiting: false,
            banner: &[],
            show_welcome: false,
            connecting: false,
            disconnected: false,
            active_agent: "default",
            fallback: None,
            clock: Instant::now(),
            turn_start: None,
            tool_elapsed: None,
            expand_thinking: true,
            ask: None,
            width: 18,
        };
        let mut markdown = MarkdownCache::new();
        let (rendered, _) = build_transcript_lines(&content, &mut markdown);
        let joined: Vec<String> = rendered
            .iter()
            .map(|l| {
                l.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect();
        assert!(joined.len() > 2, "the body must wrap on a narrow terminal");
        for l in &joined {
            assert!(
                l.is_empty() || l.starts_with("● ") || l.starts_with("  "),
                "every body line keeps the 2-column gutter aligned: {l:?}"
            );
        }
    }

    #[test]
    fn long_thinking_collapses_until_expanded() {
        let thinking = (0..20)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let mut line = sample_line("assistant", "answer", false);
        line.segments = vec![TurnSegment::Thinking(thinking)];

        let collapsed = render_single(line.clone());
        assert!(collapsed.contains("more lines · Ctrl+T"), "collapsed hint");
        assert!(
            !collapsed.contains("line 19"),
            "tail is hidden when collapsed"
        );

        let content = TranscriptContent {
            lines: &[line],
            streaming: None,
            waiting: false,
            banner: &[],
            show_welcome: false,
            connecting: false,
            disconnected: false,
            active_agent: "default",
            fallback: None,
            clock: Instant::now(),
            turn_start: None,
            tool_elapsed: None,
            expand_thinking: true,
            ask: None,
            width: 120,
        };
        let mut markdown = MarkdownCache::new();
        let (rendered, _) =
            build_transcript_lines(&content, &mut markdown);
        let expanded = rendered
            .iter()
            .flat_map(|line| line.spans.iter())
            .map(|span| span.content.as_ref())
            .collect::<String>();
        assert!(
            expanded.contains("line 19"),
            "full thinking shown when expanded"
        );
    }

    #[test]
    fn system_messages_render_distinct_from_assistant() {
        let status = render_single(sample_line("status", "Reloading config…", false));
        assert!(status.contains("Reloading config…"));
        assert!(
            status.contains("ℹ ") && !status.starts_with('●'),
            "system messages use an info prefix, not the assistant bullet"
        );

        let local = render_single(sample_line("local", "Log saved to: /tmp/x.md", false));
        assert!(local.contains("Log saved to: /tmp/x.md"));
        assert!(local.contains("ℹ ") && !local.starts_with('●'));
    }

    #[test]
    fn ask_user_question_renders_with_brand_prefix_not_info() {
        let ask = render_single(
            sample_line("ask", "Which stack should I use?", false),
        );
        assert!(ask.contains("Which stack should I use?"));
        assert!(
            ask.contains("? ") && !ask.contains("ℹ ") && !ask.starts_with('●'),
            "ask prompts use the brand question prefix, not the info/system one"
        );
    }

    #[test]
    fn ask_options_render_inline_under_the_question() {
        let mut line = sample_line("assistant", "Which DB?", false);
        line.segments = vec![TurnSegment::Ask(AskDisplay {
            id: "a1".into(),
            question: "Which DB?".into(),
            options: vec!["postgres".into(), "sqlite".into()],
        })];
        let ask = PendingAsk {
            id: "a1".into(),
            question: "Which DB?".into(),
            options: vec!["postgres".into(), "sqlite".into()],
            selected: 1,
        };
        let content = TranscriptContent {
            lines: &[line.clone()],
            streaming: Some(&line),
            waiting: true,
            banner: &[],
            show_welcome: false,
            connecting: false,
            disconnected: false,
            active_agent: "default",
            fallback: None,
            clock: Instant::now(),
            turn_start: None,
            tool_elapsed: None,
            expand_thinking: false,
            ask: Some(&ask),
            width: 120,
        };
        let mut markdown = MarkdownCache::new();
        let (rendered, _) = build_transcript_lines(&content, &mut markdown);
        let joined: String = rendered
            .iter()
            .flat_map(|line| line.spans.iter())
            .map(|span| span.content.as_ref())
            .collect();
        assert!(joined.contains("Which DB?"));
        assert!(joined.contains("❯ sqlite"), "selected option is highlighted");
        assert!(joined.contains("postgres"));
        let question_pos = joined.find("Which DB?").unwrap();
        let selected_pos = joined.find('❯').unwrap();
        assert!(selected_pos > question_pos, "options render under the question");
    }

    #[test]
    fn multiple_asks_render_in_turn_order_with_replies_between() {
        let mut line = sample_line("assistant", "before", false);
        line.segments = vec![
            TurnSegment::Text("Let me check with you.".into()),
            TurnSegment::Ask(AskDisplay {
                id: "a1".into(),
                question: "Which DB?".into(),
                options: vec!["postgres".into(), "sqlite".into()],
            }),
            TurnSegment::Reply("postgres".into()),
            TurnSegment::Text("Thanks, continuing…".into()),
            TurnSegment::Ask(AskDisplay {
                id: "a2".into(),
                question: "Port number?".into(),
                options: vec!["5432".into(), "5433".into()],
            }),
        ];
        let ask = PendingAsk {
            id: "a2".into(),
            question: "Port number?".into(),
            options: vec!["5432".into(), "5433".into()],
            selected: 0,
        };
        let content = TranscriptContent {
            lines: &[line.clone()],
            streaming: Some(&line),
            waiting: true,
            banner: &[],
            show_welcome: false,
            connecting: false,
            disconnected: false,
            active_agent: "default",
            fallback: None,
            clock: Instant::now(),
            turn_start: None,
            tool_elapsed: None,
            expand_thinking: false,
            ask: Some(&ask),
            width: 120,
        };
        let mut markdown = MarkdownCache::new();
        let (rendered, _) = build_transcript_lines(&content, &mut markdown);
        let joined: String = rendered
            .iter()
            .flat_map(|line| line.spans.iter())
            .map(|span| span.content.as_ref())
            .collect();
        for needle in [
            "Let me check with you.",
            "Which DB?",
            "postgres",
            "Thanks, continuing…",
            "Port number?",
        ] {
            assert!(joined.contains(needle), "missing: {needle}");
        }
        // Strict turn order: first question → first reply → continuation →
        // second question (which carries the live ❯ selection).
        assert!(joined.find("Which DB?").unwrap() < joined.find("postgres").unwrap());
        assert!(joined.find("postgres").unwrap() < joined.find("Thanks, continuing…").unwrap());
        assert!(
            joined.find("Thanks, continuing…").unwrap() < joined.find("Port number?").unwrap()
        );
        let first_question_end = joined.find("Which DB?").unwrap() + "Which DB?".len();
        assert!(!joined[..first_question_end].contains('❯'));
        assert!(joined[joined.find("Port number?").unwrap()..].contains("❯ 5432"));
    }

    #[test]
    fn disconnected_shows_reconnect_banner() {
        let content = TranscriptContent {
            lines: &[],
            streaming: None,
            waiting: false,
            banner: &[],
            show_welcome: false,
            connecting: false,
            disconnected: true,
            active_agent: "default",
            fallback: None,
            clock: Instant::now(),
            turn_start: None,
            tool_elapsed: None,
            expand_thinking: false,
            ask: None,
            width: 80,
        };
        let mut markdown = MarkdownCache::new();
        let (rendered, _) =
            build_transcript_lines(&content, &mut markdown);
        let joined = rendered
            .iter()
            .flat_map(|line| line.spans.iter())
            .map(|span| span.content.as_ref())
            .collect::<String>();
        assert!(joined.contains("Connection lost"));
    }

    fn render_streaming(line: &ChatLine, waiting: bool) -> String {
        let content = TranscriptContent {
            lines: &[],
            streaming: Some(line),
            waiting,
            banner: &[],
            show_welcome: false,
            connecting: false,
            disconnected: false,
            active_agent: "default",
            fallback: None,
            clock: Instant::now(),
            turn_start: None,
            tool_elapsed: None,
            expand_thinking: false,
            ask: None,
            width: 120,
        };
        let mut markdown = MarkdownCache::new();
        let (rendered, _) =
            build_transcript_lines(&content, &mut markdown);
        rendered
            .iter()
            .flat_map(|line| line.spans.iter())
            .map(|span| span.content.as_ref())
            .collect::<String>()
    }

    #[test]
    fn segments_render_in_emitted_order() {
        let mut line = sample_line("assistant", "final answer", false);
        line.segments = vec![
            TurnSegment::Thinking("first reasoning".into()),
            TurnSegment::Tool(ToolCallDisplay {
                name: "bash".into(),
                label: "ls -la".into(),
                status: ToolStatus::Done,
            }),
            TurnSegment::Thinking("second reasoning".into()),
            TurnSegment::Tool(ToolCallDisplay {
                name: "read".into(),
                label: "README.md".into(),
                status: ToolStatus::Running,
            }),
        ];
        let joined = render_streaming(&line, false);
        let first = joined.find("first reasoning").unwrap();
        let ls = joined.find("ls -la").unwrap();
        let second = joined.find("second reasoning").unwrap();
        let read = joined.find("README.md").unwrap();
        let answer = joined.find("final answer").unwrap();
        assert!(
            first < ls && ls < second && second < read && read < answer,
            "thinking/tools/text must render in emitted order"
        );
    }

    #[test]
    fn thinking_renders_before_its_tool_in_committed_lines() {
        let mut line = sample_line("assistant", "answer", false);
        line.segments = vec![
            TurnSegment::Thinking("reasoning first".into()),
            TurnSegment::Tool(ToolCallDisplay {
                name: "bash".into(),
                label: "git status".into(),
                status: ToolStatus::Done,
            }),
        ];
        let joined = render_single(line);
        assert!(
            joined.find("reasoning first").unwrap() < joined.find("git status").unwrap(),
            "thinking must precede the tool it motivated"
        );
    }

    #[test]
    fn spinner_stays_visible_for_the_whole_turn() {
        let tool = TurnSegment::Tool(ToolCallDisplay {
            name: "bash".into(),
            label: "sleep 30".into(),
            status: ToolStatus::Running,
        });
        let mut running = sample_line("assistant", "", false);
        running.segments = vec![tool.clone()];
        let busy = render_streaming(&running, true);
        assert!(
            busy.contains("Working…"),
            "loading indicator stays visible while a tool runs"
        );

        // Some text may have streamed earlier, but a tool still executing keeps
        // the loading indicator visible.
        let mut with_text = sample_line("assistant", "checked the files", false);
        with_text.segments = vec![tool];
        let mixed = render_streaming(&with_text, true);
        assert!(
            mixed.contains("Working…"),
            "loading indicator stays visible while a tool still runs"
        );

        // Even while the final answer streams, the turn is not done yet, so the
        // loading indicator must not vanish (the screen would otherwise look
        // frozen during pauses between bursts of output).
        let mut typing = sample_line("assistant", "the answer…", false);
        typing.segments = vec![TurnSegment::Tool(ToolCallDisplay {
            name: "read".into(),
            label: "index.ts".into(),
            status: ToolStatus::Done,
        })];
        let streaming = render_streaming(&typing, true);
        assert!(
            streaming.contains("Working…"),
            "the loading indicator stays until the turn finishes"
        );

        // Once the turn is over the spinner is gone.
        let done = render_streaming(&typing, false);
        assert!(
            !done.contains("Working…") && !done.contains("Thinking…"),
            "no loading indicator after the turn completes"
        );
    }

    #[test]
    fn text_renders_in_model_order_between_tools() {
        let mut line = sample_line("assistant", "", false);
        line.text = "checked the docs; calling a tool next".to_string();
        line.segments = vec![
            TurnSegment::Thinking("need to inspect".into()),
            TurnSegment::Text("let me look at the files".into()),
            TurnSegment::Tool(ToolCallDisplay {
                name: "read".into(),
                label: "index.ts".into(),
                status: ToolStatus::Running,
            }),
            TurnSegment::Text("here is the answer".into()),
        ];
        let joined = render_streaming(&line, false);
        let thinking = joined.find("need to inspect").unwrap();
        let text1 = joined.find("let me look at the files").unwrap();
        let tool = joined.find("index.ts").unwrap();
        let text2 = joined.find("here is the answer").unwrap();
        assert!(
            thinking < text1 && text1 < tool && tool < text2,
            "text and tools must render exactly in the order the model emitted them"
        );
    }

    #[test]
    fn completed_plan_renders_like_panel_with_spacer_above_body() {
        let mut line = sample_line("assistant", "", false);
        line.text = "Plan · 2/2\n  ✓ Inspect UI\n  ✓ Build panel".to_string();
        line.segments = vec![TurnSegment::Plan(PlanDisplay {
            steps: vec![
                PlanStep {
                    text: "Inspect UI".into(),
                    status: "completed".into(),
                },
                PlanStep {
                    text: "Build panel".into(),
                    status: "completed".into(),
                },
            ],
        })];

        let content = TranscriptContent {
            lines: &[line],
            streaming: None,
            waiting: false,
            banner: &[],
            show_welcome: false,
            connecting: false,
            disconnected: false,
            active_agent: "default",
            fallback: None,
            clock: Instant::now(),
            turn_start: None,
            tool_elapsed: None,
            expand_thinking: false,
            ask: None,
            width: 120,
        };
        let mut markdown = MarkdownCache::new();
        let (rendered, _) = build_transcript_lines(&content, &mut markdown);
        let joined: Vec<String> = rendered
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect();
        let header = joined
            .iter()
            .position(|l| l.contains("Plan 2/2"))
            .expect("plan header");
        assert!(
            joined.get(header + 1).is_some_and(|l| l.is_empty()),
            "a blank spacer line should separate the header from the body"
        );
        let body = joined
            .iter()
            .position(|l| l.contains("Inspect UI"))
            .expect("plan step");
        assert_eq!(body, header + 2, "the body starts after the spacer");
        assert!(joined[body].contains("✓"), "steps use the panel check style");
        assert!(joined[body + 1].contains("✓ Build panel"));
    }

    #[test]
    fn tool_calls_collapse_to_most_recent_two_until_expanded() {
        let mut line = sample_line("assistant", "done", false);
        line.segments = (0..5)
            .map(|i| {
                TurnSegment::Tool(ToolCallDisplay {
                    name: "bash".into(),
                    label: format!("tool call {i}"),
                    status: ToolStatus::Done,
                })
            })
            .collect();

        let collapsed = render_single(line.clone());
        assert!(!collapsed.contains("tool call 0"), "oldest calls hidden");
        assert!(!collapsed.contains("tool call 1"));
        assert!(!collapsed.contains("tool call 2"));
        assert!(
            collapsed.contains("tool call 3") && collapsed.contains("tool call 4"),
            "the most recent two calls stay visible"
        );
        assert!(
            collapsed.contains("+3 more calls · Ctrl+T"),
            "the first visible call carries the collapse hint"
        );

        let content = TranscriptContent {
            lines: &[line],
            streaming: None,
            waiting: false,
            banner: &[],
            show_welcome: false,
            connecting: false,
            disconnected: false,
            active_agent: "default",
            fallback: None,
            clock: Instant::now(),
            turn_start: None,
            tool_elapsed: None,
            expand_thinking: true,
            ask: None,
            width: 120,
        };
        let mut markdown = MarkdownCache::new();
        let (rendered, _) = build_transcript_lines(&content, &mut markdown);
        let expanded = rendered
            .iter()
            .flat_map(|line| line.spans.iter())
            .map(|span| span.content.as_ref())
            .collect::<String>();
        assert!(expanded.contains("tool call 0"), "expansion shows everything");
        assert!(!expanded.contains("Ctrl+T to expand"));
    }

    #[test]
    fn different_block_kinds_are_separated_by_blank_lines() {
        let mut line = sample_line("assistant", "the answer", false);
        line.segments = vec![
            TurnSegment::Thinking("reason one".into()),
            TurnSegment::Tool(ToolCallDisplay {
                name: "bash".into(),
                label: "ls".into(),
                status: ToolStatus::Done,
            }),
            TurnSegment::Tool(ToolCallDisplay {
                name: "read".into(),
                label: "README.md".into(),
                status: ToolStatus::Done,
            }),
            TurnSegment::Thinking("reason two".into()),
            TurnSegment::Text("the answer".into()),
        ];
        let content = TranscriptContent {
            lines: &[line],
            streaming: None,
            waiting: false,
            banner: &[],
            show_welcome: false,
            connecting: false,
            disconnected: false,
            active_agent: "default",
            fallback: None,
            clock: Instant::now(),
            turn_start: None,
            tool_elapsed: None,
            expand_thinking: false,
            ask: None,
            width: 120,
        };
        let mut markdown = MarkdownCache::new();
        let (rendered, _) = build_transcript_lines(&content, &mut markdown);
        let joined: Vec<String> = rendered
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect();

        let first = joined.iter().position(|l| l.contains("reason one")).unwrap();
        let tool1 = joined.iter().position(|l| l.contains("ls")).unwrap();
        let tool2 = joined.iter().position(|l| l.contains("README.md")).unwrap();
        let second = joined.iter().position(|l| l.contains("reason two")).unwrap();
        let answer = joined.iter().position(|l| l.contains("the answer")).unwrap();

        // Consecutive tool calls stay grouped…
        assert_eq!(tool2, tool1 + 1, "same-kind items stay together");
        // …but different kinds get a blank line between them.
        assert_eq!(tool1, first + 2, "blank line between thinking and tools");
        assert_eq!(second, tool2 + 2, "blank line between tools and thinking");
        assert_eq!(answer, second + 2, "blank line between thinking and reply");
    }

    #[test]
    fn consecutive_text_segments_are_separated_by_a_blank_line() {
        let mut line = sample_line("assistant", "the answer", false);
        line.segments = vec![
            TurnSegment::Text("First body text".into()),
            TurnSegment::Text("Second body text".into()),
        ];
        let content = TranscriptContent {
            lines: &[line],
            streaming: None,
            waiting: false,
            banner: &[],
            show_welcome: false,
            connecting: false,
            disconnected: false,
            active_agent: "default",
            fallback: None,
            clock: Instant::now(),
            turn_start: None,
            tool_elapsed: None,
            expand_thinking: false,
            ask: None,
            width: 100,
        };
        let mut markdown = MarkdownCache::new();
        let (rendered, _) = build_transcript_lines(&content, &mut markdown);
        let joined: Vec<String> = rendered
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect();
        let first = joined
            .iter()
            .position(|l| l.contains("First body text"))
            .expect("first body");
        let second = joined
            .iter()
            .position(|l| l.contains("Second body text"))
            .expect("second body");
        assert_eq!(
            second,
            first + 2,
            "two body texts must be separated by a blank line"
        );
    }

    #[test]
    fn collapsed_thinking_hint_rides_on_the_last_line() {
        let thinking = (0..20)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let mut line = sample_line("assistant", "answer", false);
        line.segments = vec![TurnSegment::Thinking(thinking)];
        let content = TranscriptContent {
            lines: &[line],
            streaming: None,
            waiting: false,
            banner: &[],
            show_welcome: false,
            connecting: false,
            disconnected: false,
            active_agent: "default",
            fallback: None,
            clock: Instant::now(),
            turn_start: None,
            tool_elapsed: None,
            expand_thinking: false,
            ask: None,
            width: 120,
        };
        let mut markdown = MarkdownCache::new();
        let (rendered, _) = build_transcript_lines(&content, &mut markdown);
        let joined: Vec<String> = rendered
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect();
        let hint_line = joined
            .iter()
            .find(|l| l.contains("more lines"))
            .expect("collapse hint");
        assert!(
            hint_line.contains("line 3") && hint_line.starts_with("  line"),
            "the ellipsis hint is appended to the last shown thinking line"
        );
    }
}
