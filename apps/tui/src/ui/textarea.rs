use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::buffer::Buffer;
use ratatui::widgets::Widget;
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

#[derive(Debug, Clone)]
struct WrappedLine {
    start: usize,
    end: usize,
}

pub struct TextArea {
    text: String,
    cursor: usize,
}

impl TextArea {
    pub fn new() -> Self {
        Self {
            text: String::new(),
            cursor: 0,
        }
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn is_empty(&self) -> bool {
        self.text.is_empty()
    }

    pub fn set_text(&mut self, value: String) {
        self.text = value;
        self.cursor = self.clamp_boundary(self.cursor.min(self.text.len()));
    }

    pub fn insert_str(&mut self, value: &str) {
        if value.is_empty() {
            return;
        }
        self.text.insert_str(self.cursor, value);
        self.cursor += value.len();
        self.cursor = self.clamp_boundary(self.cursor);
    }

    pub fn delete_backward(&mut self) {
        if self.cursor == 0 {
            return;
        }
        let prev = self.prev_boundary(self.cursor);
        self.text.replace_range(prev..self.cursor, "");
        self.cursor = prev;
    }

    pub fn delete_forward(&mut self) {
        if self.cursor >= self.text.len() {
            return;
        }
        let next = self.next_boundary(self.cursor);
        self.text.replace_range(self.cursor..next, "");
    }

    pub fn move_left(&mut self) {
        if self.cursor == 0 {
            return;
        }
        self.cursor = self.prev_boundary(self.cursor);
    }

    pub fn move_right(&mut self) {
        if self.cursor >= self.text.len() {
            return;
        }
        self.cursor = self.next_boundary(self.cursor);
    }

    pub fn move_home(&mut self) {
        self.cursor = self.line_start(self.cursor);
    }

    pub fn move_end(&mut self) {
        self.cursor = self.line_end(self.cursor);
    }

    pub fn desired_height(&self, width: u16) -> u16 {
        self.wrapped_lines(width.max(1)).len().max(1) as u16
    }

    pub fn cursor_pos(&self, area: Rect) -> Option<(u16, u16)> {
        let width = area.width.max(1);
        let lines = self.wrapped_lines(width);
        let line_index = line_index_for_offset(&lines, self.cursor)?;
        let line = &lines[line_index];
        let col = self.text[line.start..self.cursor].width() as u16;
        Some((area.x + col, area.y + line_index as u16))
    }

    fn wrapped_lines(&self, width: u16) -> Vec<WrappedLine> {
        if self.text.is_empty() {
            return vec![WrappedLine { start: 0, end: 0 }];
        }

        let mut lines = Vec::new();
        let mut line_start = 0usize;
        let mut width_used = 0usize;
        let max = width as usize;

        for (offset, grapheme) in self.text.grapheme_indices(true) {
            let piece = if grapheme == "\t" { "    " } else { grapheme };
            let piece_width = piece.width();
            if width_used + piece_width > max && width_used > 0 {
                lines.push(WrappedLine {
                    start: line_start,
                    end: offset,
                });
                line_start = offset;
                width_used = piece_width;
                continue;
            }
            width_used += piece_width;
            if grapheme == "\n" {
                lines.push(WrappedLine {
                    start: line_start,
                    end: offset + grapheme.len(),
                });
                line_start = offset + grapheme.len();
                width_used = 0;
            }
        }

        if line_start <= self.text.len() {
            lines.push(WrappedLine {
                start: line_start,
                end: self.text.len(),
            });
        }

        if lines.is_empty() {
            lines.push(WrappedLine { start: 0, end: 0 });
        }

        lines
    }

    fn line_start(&self, pos: usize) -> usize {
        self.text[..pos].rfind('\n').map(|idx| idx + 1).unwrap_or(0)
    }

    fn line_end(&self, pos: usize) -> usize {
        self.text[pos..]
            .find('\n')
            .map(|idx| idx + pos)
            .unwrap_or(self.text.len())
    }

    fn prev_boundary(&self, offset: usize) -> usize {
        if offset == 0 {
            return 0;
        }
        self.text
            .grapheme_indices(true)
            .map(|(idx, _)| idx)
            .filter(|idx| *idx < offset)
            .last()
            .unwrap_or(0)
    }

    fn next_boundary(&self, offset: usize) -> usize {
        self.text
            .grapheme_indices(true)
            .map(|(idx, grapheme)| idx + grapheme.len())
            .find(|idx| *idx > offset)
            .unwrap_or(self.text.len())
    }

    fn clamp_boundary(&self, offset: usize) -> usize {
        if offset <= 0 {
            return 0;
        }
        if offset >= self.text.len() {
            return self.text.len();
        }
        if self.text.is_char_boundary(offset) {
            return offset;
        }
        self.prev_boundary(offset)
    }
}

impl Default for TextArea {
    fn default() -> Self {
        Self::new()
    }
}

fn line_index_for_offset(lines: &[WrappedLine], offset: usize) -> Option<usize> {
    let idx = lines.partition_point(|line| line.start <= offset);
    if idx == 0 {
        None
    } else {
        Some(idx - 1)
    }
}

pub struct TextAreaWidget<'a> {
    textarea: &'a TextArea,
    prefix: &'a str,
    style: Style,
    show_cursor: bool,
}

impl<'a> TextAreaWidget<'a> {
    pub fn new(textarea: &'a TextArea, prefix: &'a str, style: Style, show_cursor: bool) -> Self {
        Self {
            textarea,
            prefix,
            style,
            show_cursor,
        }
    }
}

impl Widget for TextAreaWidget<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let width = area.width.max(1);
        let lines = self.textarea.wrapped_lines(width);
        let cursor_line = line_index_for_offset(&lines, self.textarea.cursor);
        let cursor_col = cursor_line
            .and_then(|index| {
                let line = &lines[index];
                Some(self.textarea.text[line.start..self.textarea.cursor].width())
            })
            .unwrap_or(0);

        for (row, wrapped) in lines.iter().enumerate().take(area.height as usize) {
            let y = area.y + row as u16;
            if y >= area.bottom() {
                break;
            }
            let prefix = if row == 0 { self.prefix } else { "  " };
            let line_text = &self.textarea.text[wrapped.start..wrapped.end.min(self.textarea.text.len())];
            let display = line_text.replace('\t', "    ");
            let mut spans = vec![Span::styled(prefix, self.style)];
            if self.show_cursor && Some(row) == cursor_line {
                let mut width_so_far = 0usize;
                let mut before = String::new();
                let mut at = " ".to_string();
                let mut after = String::new();
                let mut placed = false;
                for grapheme in display.graphemes(true) {
                    if placed {
                        after.push_str(grapheme);
                        continue;
                    }
                    let next = width_so_far + grapheme.width();
                    if next > cursor_col {
                        at = grapheme.to_string();
                        placed = true;
                    } else {
                        width_so_far = next;
                        before.push_str(grapheme);
                    }
                }
                if !before.is_empty() {
                    spans.push(Span::styled(before, self.style));
                }
                spans.push(Span::styled(at, self.style.add_modifier(Modifier::REVERSED)));
                if !after.is_empty() {
                    spans.push(Span::styled(after, self.style));
                }
            } else {
                spans.push(Span::styled(display, self.style));
            }
            let line = Line::from(spans);
            buf.set_line(area.x, y, &line, width);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_column_uses_display_width() {
        let mut textarea = TextArea::new();
        textarea.insert_str("你好");
        textarea.move_home();
        textarea.move_right();
        let col = textarea.text[..textarea.cursor].width();
        assert_eq!(col, 2);
    }
}
