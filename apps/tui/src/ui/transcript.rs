use std::time::Instant;

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::text::{Line, Span};
use ratatui::widgets::{Paragraph, Widget, Wrap};
use unicode_width::UnicodeWidthStr;

use crate::agent::client::{ChatLine, ToolCallDisplay, ToolStatus};
use crate::ui::markdown::{LinkRegion, MarkdownCache, StreamingMarkdown};
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
    pub width: u16,
}

pub fn build_transcript_lines(
    content: &TranscriptContent<'_>,
    markdown: &mut MarkdownCache,
    streaming_md: &StreamingMarkdown,
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
        );
    }

    if content.waiting {
        rendered.push(spinner_line(
            "Thinking…",
            content.clock,
            content.turn_start,
            false,
        ));
    } else if let Some(line) = content.streaming {
        push_streaming_line(
            &mut rendered,
            &mut links,
            line,
            width,
            markdown,
            streaming_md,
            content.tool_elapsed,
            content.expand_thinking,
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
    streaming_md: &StreamingMarkdown,
    tool_elapsed: Option<Instant>,
    expand_thinking: bool,
) {
    if line.role == "user" {
        push_chat_line(lines, links, line, width, markdown, expand_thinking);
        return;
    }

    let last_tool = line.tools.len().saturating_sub(1);
    for (index, tool) in line.tools.iter().enumerate() {
        let elapsed = if index == last_tool {
            tool_elapsed.map(|start| start.elapsed())
        } else {
            None
        };
        lines.push(tool_line(tool, elapsed));
    }
    push_thinking_text(lines, &line.thinking, expand_thinking);
    if streaming_md.lines().is_empty() {
        push_assistant_plain(lines, &line.text);
    } else {
        let base = lines.len() as u16;
        lines.extend(prefix_assistant_lines(streaming_md.lines()));
        for region in streaming_md.links() {
            links.push(offset_link_region(region, base, 2));
        }
    }
    lines.push(Line::from(""));
}

pub fn max_history_scroll(
    content: &TranscriptContent<'_>,
    markdown: &mut MarkdownCache,
    streaming_md: &StreamingMarkdown,
    height: u16,
) -> u16 {
    if height == 0 {
        return 0;
    }
    let (lines, _) = build_transcript_lines(content, markdown, streaming_md);
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
        _ => {
            for tool in &line.tools {
                lines.push(tool_line(tool, None));
            }
            push_thinking_text(lines, &line.thinking, expand_thinking);
            push_assistant_body(lines, links, &line.text, width, markdown);
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

/// Render a thinking block. Long blocks are collapsed to a few lines with a
/// hint unless the user has toggled expansion.
fn push_thinking_text(lines: &mut Vec<Line<'static>>, text: &str, expand: bool) {
    if text.trim().is_empty() {
        return;
    }
    let style = style::thinking();
    let chunks: Vec<&str> = text.lines().collect();
    let hidden = chunks.len().saturating_sub(THINKING_COLLAPSE_LINES);
    if hidden > 0 && !expand {
        for chunk in chunks.iter().take(THINKING_COLLAPSE_SHOWN) {
            lines.push(Line::from(vec![
                Span::styled(THINKING_CONTINUATION, style),
                Span::styled(chunk.to_string(), style),
            ]));
        }
        let hint = format!("··· {hidden} more thinking lines · Ctrl+T to expand");
        lines.push(Line::from(vec![
            Span::styled(THINKING_CONTINUATION, style),
            Span::styled(hint, style::muted()),
        ]));
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

fn push_assistant_plain(lines: &mut Vec<Line<'static>>, text: &str) {
    if text.trim().is_empty() {
        return;
    }
    for (index, chunk) in text.lines().enumerate() {
        if index == 0 {
            let mut spans = assistant_leading_spans();
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

fn prefix_assistant_lines(body: &[Line<'static>]) -> Vec<Line<'static>> {
    body.iter()
        .enumerate()
        .map(|(index, line)| {
            let mut spans = if index == 0 {
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
        .max(20)
}

pub fn assistant_markdown_width(viewport_width: u16) -> u16 {
    assistant_body_width(viewport_width)
}

fn push_assistant_body(
    lines: &mut Vec<Line<'static>>,
    links: &mut Vec<LinkRegion>,
    text: &str,
    width: u16,
    markdown: &mut MarkdownCache,
) {
    if text.trim().is_empty() {
        return;
    }
    let body_width = assistant_body_width(width);
    let (rendered, rendered_links) = markdown.render_static_with_links(text, body_width);
    if rendered.is_empty() {
        push_assistant_plain(lines, text);
        return;
    }
    let base = lines.len() as u16;
    lines.extend(prefix_assistant_lines(rendered));
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

fn tool_line(tool: &ToolCallDisplay, elapsed: Option<std::time::Duration>) -> Line<'static> {
    let mut spans = vec![Span::styled(
        format!("{} {}", tool_icon(&tool.name), tool.label),
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
    Line::from(spans)
}

fn tool_icon(name: &str) -> &'static str {
    if name.starts_with("mcp__") {
        return "🔌";
    }
    match name {
        "bash" => "🐚",
        "read" => "📖",
        "write" => "📝",
        "glob" => "📁",
        "grep" => "🔍",
        _ => "🔧",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::client::ChatLine;
    use crate::ui::markdown::{MarkdownCache, StreamingMarkdown};
    use std::time::Instant;

    fn sample_line(role: &str, text: &str, queued: bool) -> ChatLine {
        ChatLine {
            role: role.to_string(),
            text: text.to_string(),
            sent_content: None,
            thinking: String::new(),
            tools: Vec::new(),
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
            width: 120,
        };
        let mut markdown = MarkdownCache::new();
        let (rendered, links) =
            build_transcript_lines(&content, &mut markdown, &StreamingMarkdown::new());
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
            width: 80,
        };
        let mut markdown = MarkdownCache::new();
        let streaming_md = StreamingMarkdown::new();
        let (rendered, _) = build_transcript_lines(&content, &mut markdown, &streaming_md);
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
            width: 80,
        };
        let mut markdown = MarkdownCache::new();
        let (rendered, _) =
            build_transcript_lines(&content, &mut markdown, &StreamingMarkdown::new());
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
            width: 80,
        };
        let mut markdown = MarkdownCache::new();
        let (rendered, _) =
            build_transcript_lines(&content, &mut markdown, &StreamingMarkdown::new());
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
            width: 120,
        };
        let mut markdown = MarkdownCache::new();
        let (rendered, _) =
            build_transcript_lines(&content, &mut markdown, &StreamingMarkdown::new());
        rendered
            .iter()
            .flat_map(|line| line.spans.iter())
            .map(|span| span.content.as_ref())
            .collect::<String>()
    }

    #[test]
    fn tools_render_completion_status() {
        let mut line = sample_line("assistant", "done", false);
        line.tools = vec![
            ToolCallDisplay {
                name: "bash".into(),
                label: "ls -la".into(),
                status: ToolStatus::Done,
            },
            ToolCallDisplay {
                name: "read".into(),
                label: "README.md".into(),
                status: ToolStatus::Failed,
            },
        ];
        let joined = render_single(line);
        assert!(joined.contains("✓"), "done tool should show a check");
        assert!(joined.contains("✗"), "failed tool should show a cross");
    }

    #[test]
    fn long_thinking_collapses_until_expanded() {
        let thinking = (0..20)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let mut line = sample_line("assistant", "answer", false);
        line.thinking = thinking;

        let collapsed = render_single(line.clone());
        assert!(collapsed.contains("more thinking lines"), "collapsed hint");
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
            width: 120,
        };
        let mut markdown = MarkdownCache::new();
        let (rendered, _) =
            build_transcript_lines(&content, &mut markdown, &StreamingMarkdown::new());
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
            width: 80,
        };
        let mut markdown = MarkdownCache::new();
        let (rendered, _) =
            build_transcript_lines(&content, &mut markdown, &StreamingMarkdown::new());
        let joined = rendered
            .iter()
            .flat_map(|line| line.spans.iter())
            .map(|span| span.content.as_ref())
            .collect::<String>();
        assert!(joined.contains("Connection lost"));
    }
}
