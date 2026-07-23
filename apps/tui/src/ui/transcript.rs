use std::time::Instant;

use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::buffer::Buffer;
use ratatui::widgets::{Paragraph, Widget, Wrap};
use unicode_width::UnicodeWidthStr;

use crate::agent::client::{ChatLine, ToolCallDisplay};
use crate::ui::markdown::{MarkdownCache, StreamingMarkdown};
use crate::ui::spinner::spinner_line;

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
    pub show_banner: bool,
    pub width: u16,
}

pub fn build_transcript_lines(
    content: &TranscriptContent<'_>,
    markdown: &mut MarkdownCache,
    streaming_md: &StreamingMarkdown,
) -> Vec<Line<'static>> {
    let mut rendered: Vec<Line<'static>> = Vec::new();
    let width = content.width.max(1);

    if content.show_banner {
        for line in content.banner {
            rendered.push(Line::from(Span::styled(
                line.clone(),
                Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD),
            )));
        }
        if !content.banner.is_empty() {
            rendered.push(Line::from(""));
        }
    }

    if content.show_welcome {
        if content.connecting {
            rendered.push(spinner_line("Connecting…", content.clock, None, false));
        } else {
            rendered.push(Line::from(vec![Span::styled(
                format!(
                    "Active agent: {}. Type a message and press Enter. Type / for commands. Esc to undo.",
                    if content.active_agent.is_empty() {
                        "—"
                    } else {
                        content.active_agent
                    }
                ),
                Style::default().fg(Color::DarkGray),
            )]));
            if let Some((requested, active)) = content.fallback {
                rendered.push(Line::from(Span::styled(
                    format!(
                        "Configured agent \"{requested}\" not found, using built-in \"{active}\"."
                    ),
                    Style::default().fg(Color::Yellow),
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

    lines.push(Line::from(vec![
        Span::styled(
            "Assistant ",
            Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD),
        ),
    ]));
    for tool in &line.tools {
        lines.push(tool_line(tool));
    }
    if streaming_md.lines().is_empty() {
        push_plain_text(lines, &line.text);
    } else {
        lines.extend(streaming_md.lines().iter().cloned());
    }
    lines.push(Line::from(""));
}

pub fn max_history_scroll(
    content: &TranscriptContent<'_>,
    markdown: &mut MarkdownCache,
    streaming_md: &StreamingMarkdown,
    height: u16,
) -> u16 {
    if height == 0 || content.show_welcome {
        return 0;
    }
    let lines = build_transcript_lines(content, markdown, streaming_md);
    let total = line_count(&lines, content.width.max(1));
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
    pub show_welcome: bool,
}

impl Widget for TranscriptWidget {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let mut rendered = self.lines;

        if self.show_welcome && self.scroll == 0 {
            let content_height = line_count(&rendered, area.width.max(1));
            let top_pad = area.height.saturating_sub(content_height);
            for _ in 0..top_pad {
                rendered.insert(0, Line::from(""));
            }
        }

        let width = area.width.max(1);
        let total_lines = line_count(&rendered, width);
        let scroll_y = paragraph_scroll_y(total_lines, area.height, self.scroll);

        let paragraph = Paragraph::new(rendered)
            .wrap(Wrap { trim: false })
            .scroll((scroll_y, 0));
        paragraph.render(area, buf);
    }
}

fn push_chat_line(
    lines: &mut Vec<Line<'static>>,
    line: &ChatLine,
    width: u16,
    markdown: &mut MarkdownCache,
) {
    if line.role == "user" {
        lines.push(Line::from(vec![
            Span::styled("You ", Style::default().fg(Color::Green).add_modifier(Modifier::BOLD)),
        ]));
        push_plain_text(lines, &line.text);
    } else {
        lines.push(Line::from(vec![
            Span::styled(
                "Assistant ",
                Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD),
            ),
        ]));
        for tool in &line.tools {
            lines.push(tool_line(tool));
        }
        push_assistant_body(lines, &line.text, width, markdown);
    }

    if let Some(duration) = line.duration_ms {
        lines.push(Line::from(Span::styled(
            format!("· {:.1}s", duration as f64 / 1000.0),
            Style::default().fg(Color::DarkGray),
        )));
    }

    lines.push(Line::from(""));
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
    let rendered = markdown.render_static(text, width);
    if rendered.is_empty() {
        push_plain_text(lines, text);
    } else {
        lines.extend(rendered.iter().cloned());
    }
}

fn push_plain_text(lines: &mut Vec<Line<'static>>, text: &str) {
    for chunk in text.lines() {
        lines.push(Line::from(chunk.to_string()));
    }
}

fn tool_line(tool: &ToolCallDisplay) -> Line<'static> {
    Line::from(Span::styled(
        format!("{} {}", tool_icon(&tool.name), tool.label),
        Style::default().fg(Color::DarkGray),
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
}
