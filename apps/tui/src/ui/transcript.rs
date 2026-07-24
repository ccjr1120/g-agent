use std::time::Instant;

use ratatui::layout::Rect;
use ratatui::text::{Line, Span};
use ratatui::buffer::Buffer;
use ratatui::widgets::{Paragraph, Widget, Wrap};
use unicode_width::UnicodeWidthStr;

use crate::agent::client::{ChatLine, ToolCallDisplay};
use crate::ui::markdown::{MarkdownCache, StreamingMarkdown};
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
        Span::styled(
            ASSISTANT_BULLET.to_string(),
            style::assistant_bullet(),
        ),
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
    pub active_agent: &'a str,
    pub fallback: Option<(&'a str, &'a str)>,
    pub clock: Instant,
    pub turn_start: Option<Instant>,
    pub width: u16,
}

pub fn build_transcript_lines(
    content: &TranscriptContent<'_>,
    markdown: &mut MarkdownCache,
    streaming_md: &StreamingMarkdown,
) -> Vec<Line<'static>> {
    let mut rendered: Vec<Line<'static>> = Vec::new();
    let width = content_width(content.width.max(1));

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
                format!(
                    "Active agent: {}. Enter to send, / for commands, Esc to revert last send, Ctrl+Y or Cmd+C to copy.",
                    if content.active_agent.is_empty() {
                        "—"
                    } else {
                        content.active_agent
                    }
                ),
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

    for line in content.lines {
        push_chat_line(&mut rendered, line, width, markdown);
    }

    if content.waiting {
        rendered.push(spinner_line(
            "Thinking…",
            content.clock,
            content.turn_start,
            false,
        ));
    } else if let Some(line) = content.streaming {
        push_streaming_line(&mut rendered, line, width, markdown, streaming_md);
    }

    rendered
}

fn push_streaming_line(
    lines: &mut Vec<Line<'static>>,
    line: &ChatLine,
    width: u16,
    markdown: &mut MarkdownCache,
    streaming_md: &StreamingMarkdown,
) {
    if line.role == "user" {
        push_chat_line(lines, line, width, markdown);
        return;
    }

    for tool in &line.tools {
        lines.push(tool_line(tool));
    }
    push_thinking_text(lines, &line.thinking);
    if streaming_md.lines().is_empty() {
        push_assistant_plain(lines, &line.text);
    } else {
        lines.extend(prefix_assistant_lines(streaming_md.lines()));
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
    let lines = build_transcript_lines(content, markdown, streaming_md);
    let total = line_count(&lines, content_width(content.width.max(1)));
    total.saturating_sub(height)
}

fn line_count(lines: &[Line<'_>], width: u16) -> u16 {
    lines
        .iter()
        .map(|line| line_row_count(line, width))
        .sum()
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
    line: &ChatLine,
    width: u16,
    markdown: &mut MarkdownCache,
) {
    if line.role == "user" {
        push_user_text(lines, &line.text, line.queued);
    } else {
        for tool in &line.tools {
            lines.push(tool_line(tool));
        }
        push_thinking_text(lines, &line.thinking);
        push_assistant_body(lines, &line.text, width, markdown);
    }

    if let Some(duration) = line.duration_ms {
        lines.push(Line::from(Span::styled(
            format!("· {:.1}s", duration as f64 / 1000.0),
            style::muted(),
        )));
    }

    lines.push(Line::from(""));
}

fn push_thinking_text(lines: &mut Vec<Line<'static>>, text: &str) {
    if text.trim().is_empty() {
        return;
    }
    let style = style::thinking();
    for chunk in text.lines() {
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
            if queued { "⏳ " } else { USER_PREFIX }
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

fn user_line_spans(chunk: &str, prefix: &str, base_style: ratatui::style::Style) -> Vec<Span<'static>> {
    const MARKER: &str = "[Pasted text #";
    let mut spans = vec![Span::styled(prefix.to_string(), base_style)];
    if let Some(start) = chunk.find(MARKER) {
        if start > 0 {
            spans.push(Span::styled(chunk[..start].to_string(), base_style));
        }
        let end = chunk[start..]
            .find(']')
            .map(|idx| start + idx + 1)
            .unwrap_or(chunk.len());
        spans.push(Span::styled(
            chunk[start..end].to_string(),
            style::paste_chip(),
        ));
        if end < chunk.len() {
            spans.push(Span::styled(chunk[end..].to_string(), base_style));
        }
    } else {
        spans.push(Span::styled(chunk.to_string(), base_style));
    }
    spans
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
    text: &str,
    width: u16,
    markdown: &mut MarkdownCache,
) {
    if text.trim().is_empty() {
        return;
    }
    let body_width = assistant_body_width(width);
    let rendered = markdown.render_static(text, body_width);
    if rendered.is_empty() {
        push_assistant_plain(lines, text);
    } else {
        lines.extend(prefix_assistant_lines(rendered));
    }
}

fn tool_line(tool: &ToolCallDisplay) -> Line<'static> {
    Line::from(Span::styled(
        format!("{} {}", tool_icon(&tool.name), tool.label),
        style::tool_call(),
    ))
}

fn tool_icon(name: &str) -> &'static str {
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
}
