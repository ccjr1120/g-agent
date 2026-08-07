use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Widget;
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

#[derive(Debug, Clone)]
struct WrappedLine {
    start: usize,
    end: usize,
}

/// Maximum wrapped rows the input area may occupy. Beyond this the text
/// scrolls inside the fixed-height box so a long draft or paste never grows
/// taller than the terminal and pushes the typing position off-screen.
pub const MAX_INPUT_LINES: usize = 8;

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

    /// Move to the start of the previous word (skipping separators).
    pub fn move_word_left(&mut self) {
        self.cursor = self.previous_word_start(self.cursor);
    }

    /// Move to the start of the next word.
    pub fn move_word_right(&mut self) {
        self.cursor = self.next_word_start(self.cursor);
    }

    /// Delete the word immediately before the cursor.
    pub fn delete_word_backward(&mut self) {
        let start = self.previous_word_start(self.cursor);
        self.text.replace_range(start..self.cursor, "");
        self.cursor = start;
    }

    /// Delete the word immediately after the cursor.
    pub fn delete_word_forward(&mut self) {
        let end = self.next_word_end(self.cursor);
        self.text.replace_range(self.cursor..end, "");
    }

    /// Delete from the start of the line up to the cursor.
    pub fn delete_to_line_start(&mut self) {
        let start = self.line_start(self.cursor);
        self.text.replace_range(start..self.cursor, "");
        self.cursor = start;
    }

    /// Delete from the cursor to the end of the line.
    pub fn delete_to_line_end(&mut self) {
        let end = self.line_end(self.cursor);
        self.text.replace_range(self.cursor..end, "");
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

    pub fn delete_current_line(&mut self) {
        if self.text.is_empty() {
            return;
        }

        let start = self.line_start(self.cursor);
        let end = self.line_end(self.cursor);
        let mut range_end = end;

        if range_end < self.text.len() && self.text[range_end..].starts_with('\n') {
            range_end += 1;
        } else if start > 0 && self.text.as_bytes().get(start - 1) == Some(&b'\n') {
            self.text.replace_range((start - 1)..end, "");
            self.cursor = (start - 1).min(self.text.len());
            self.cursor = self.clamp_boundary(self.cursor);
            return;
        }

        self.text.replace_range(start..range_end, "");
        self.cursor = start.min(self.text.len());
        self.cursor = self.clamp_boundary(self.cursor);
    }

    pub fn desired_height(&self, width: u16) -> u16 {
        self.wrapped_lines(width.max(1))
            .len()
            .clamp(1, MAX_INPUT_LINES) as u16
    }

    pub fn cursor_pos(&self, area: Rect) -> Option<(u16, u16)> {
        let width = area.width.max(1);
        let lines = self.wrapped_lines(width);
        let line_index = line_index_for_offset(&lines, self.cursor)?;
        let line = &lines[line_index];
        let col = (self.text[line.start..self.cursor].width() as u16).min(width - 1);
        let visible = line_index.saturating_sub(self.scroll_offset(&lines, area.height));
        Some((area.x + col, area.y + visible as u16))
    }

    /// How many wrapped lines to skip so the cursor line stays on screen when
    /// the draft is taller than the allocated area.
    fn scroll_offset(&self, lines: &[WrappedLine], height: u16) -> usize {
        let cursor_line = line_index_for_offset(lines, self.cursor).unwrap_or(0);
        (cursor_line + 1).saturating_sub(height.max(1) as usize)
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

    fn prev_char_start(&self, pos: usize) -> usize {
        let mut index = pos;
        while index > 0 {
            index -= 1;
            if self.text.is_char_boundary(index) {
                return index;
            }
        }
        0
    }

    fn previous_word_start(&self, from: usize) -> usize {
        let mut pos = from;
        while pos > 0 {
            let prev = self.prev_char_start(pos);
            let ch = self.text[prev..pos].chars().next().unwrap();
            if is_word_char(ch) {
                break;
            }
            pos = prev;
        }
        while pos > 0 {
            let prev = self.prev_char_start(pos);
            let ch = self.text[prev..pos].chars().next().unwrap();
            if !is_word_char(ch) {
                break;
            }
            pos = prev;
        }
        pos
    }

    fn next_word_start(&self, from: usize) -> usize {
        let mut pos = from;
        // Skip past the current word (if the cursor sits on one).
        while pos < self.text.len() {
            let ch = self.text[pos..].chars().next().unwrap();
            if !is_word_char(ch) {
                break;
            }
            pos += ch.len_utf8();
        }
        // Skip past separators to the start of the next word.
        while pos < self.text.len() {
            let ch = self.text[pos..].chars().next().unwrap();
            if is_word_char(ch) {
                break;
            }
            pos += ch.len_utf8();
        }
        pos
    }

    fn next_word_end(&self, from: usize) -> usize {
        let mut pos = from;
        while pos < self.text.len() {
            let ch = self.text[pos..].chars().next().unwrap();
            if is_word_char(ch) {
                break;
            }
            pos += ch.len_utf8();
        }
        while pos < self.text.len() {
            let ch = self.text[pos..].chars().next().unwrap();
            if !is_word_char(ch) {
                break;
            }
            pos += ch.len_utf8();
        }
        pos
    }

    fn prev_boundary(&self, offset: usize) -> usize {
        if offset == 0 {
            return 0;
        }
        self.text
            .grapheme_indices(true)
            .rev()
            .find(|(idx, _)| *idx < offset)
            .map(|(idx, _)| idx)
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
        if offset == 0 {
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

fn is_word_char(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_'
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
        // Each rendered row carries a 2-column prefix ("> " on row 0, "  " on
        // wrapped rows), so the text must wrap at `width - prefix_width`.
        // Wrapping at the full width would push the prefix over the right edge
        // and `set_line` truncates the trailing characters — making the last
        // two characters of every full line invisible and the cursor land on a
        // different row than the text is actually drawn at.
        let prefix_width = self.prefix.width() as u16;
        let width = area.width.max(1);
        let wrap_width = width.saturating_sub(prefix_width).max(1);
        let lines = self.textarea.wrapped_lines(wrap_width);
        let cursor_index = line_index_for_offset(&lines, self.textarea.cursor);
        let scroll = self.textarea.scroll_offset(&lines, area.height);
        let cursor_line = cursor_index.map(|index| index.saturating_sub(scroll));
        let cursor_col = cursor_index
            .map(|index| {
                let line = &lines[index];
                self.textarea.text[line.start..self.textarea.cursor].width()
            })
            .unwrap_or(0);

        for (row, wrapped) in lines
            .iter()
            .enumerate()
            .skip(scroll)
            .take(area.height as usize)
        {
            let y = area.y + row as u16;
            if y >= area.bottom() {
                break;
            }
            let prefix = if row == 0 { self.prefix } else { "  " };
            let line_text =
                &self.textarea.text[wrapped.start..wrapped.end.min(self.textarea.text.len())];
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
                spans.push(Span::styled(
                    at,
                    self.style.add_modifier(Modifier::REVERSED),
                ));
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

    #[test]
    fn cursor_tracks_wrap_width_used_by_render() {
        let mut textarea = TextArea::new();
        textarea.set_text("x".repeat(30).into());
        textarea.move_end();
        // The render wraps at `width - prefix_width` (2), so cursor_pos is
        // called with the reduced width: 30 chars over 8 → 8/8/8/6 lines.
        assert_eq!(textarea.cursor_pos(Rect::new(0, 0, 8, 5)), Some((6, 3)));
        textarea.move_home();
        assert_eq!(textarea.cursor_pos(Rect::new(0, 0, 8, 5)), Some((0, 0)));
    }

    #[test]
    fn cursor_clamps_to_last_visible_column() {
        let mut textarea = TextArea::new();
        textarea.set_text("x".repeat(8).into());
        textarea.move_end();
        // Cursor at the very end of a full wrapped line must not sit past the
        // right edge of the area.
        assert_eq!(textarea.cursor_pos(Rect::new(0, 0, 8, 3)), Some((7, 0)));
    }

    #[test]
    fn full_lines_do_not_truncate_right_edge_chars() {
        let mut textarea = TextArea::new();
        textarea.set_text("x".repeat(12).into());
        let mut buf = Buffer::empty(Rect::new(0, 0, 12, 3));
        TextAreaWidget::new(&textarea, "> ", Style::default(), false)
            .render(Rect::new(0, 0, 12, 3), &mut buf);
        // Row 0 is "> " + the first 10 x's; the trailing "xx" must wrap to row
        // 1 (indented by the 2-column prefix) instead of being truncated.
        assert_eq!(buf[(11, 0)].symbol(), "x");
        assert_eq!(buf[(2, 1)].symbol(), "x");
        assert_eq!(buf[(3, 1)].symbol(), "x");
        assert_eq!(buf[(0, 1)].symbol(), " ");
    }

    #[test]
    fn desired_height_is_capped_at_max_input_lines() {
        let mut textarea = TextArea::new();
        textarea.set_text("x".repeat(1000).into());
        assert_eq!(textarea.desired_height(40), MAX_INPUT_LINES as u16);
        // Short drafts still size to their own height.
        textarea.set_text("hi".into());
        assert_eq!(textarea.desired_height(40), 1);
    }

    #[test]
    fn cursor_scrolls_into_view_when_draft_taller_than_area() {
        let mut textarea = TextArea::new();
        textarea.set_text("x".repeat(200).into());
        textarea.move_end();
        // 200 chars at width 40 → 5 wrapped lines; a 3-row area must scroll so
        // the cursor row (4) stays visible: scroll = (4+1)-3 = 2 → visible row 2.
        assert_eq!(textarea.cursor_pos(Rect::new(0, 0, 40, 3)), Some((39, 2)));
    }

    #[test]
    fn render_scrolls_to_keep_cursor_line_visible() {
        let mut textarea = TextArea::new();
        textarea.set_text("x".repeat(200).into());
        textarea.move_end();
        let mut buf = Buffer::empty(Rect::new(0, 0, 42, 3));
        TextAreaWidget::new(&textarea, "> ", Style::default(), true)
            .render(Rect::new(0, 0, 42, 3), &mut buf);
        // wrap width = 42 - 2 = 40; the last visible row (2) shows wrapped line
        // 4 (the cursor line) indented by the 2-column continuation prefix.
        assert_eq!(buf[(0, 2)].symbol(), " ");
        assert_eq!(buf[(2, 2)].symbol(), "x");
        assert_eq!(buf[(41, 2)].symbol(), "x");
    }

    #[test]
    fn delete_current_line_removes_logical_line() {
        let mut textarea = TextArea::new();
        textarea.set_text("line1\nline2\nline3".into());
        for _ in 0..6 {
            textarea.move_right();
        }
        assert_eq!(textarea.cursor, 6);
        textarea.delete_current_line();
        assert_eq!(textarea.text(), "line1\nline3");
        assert_eq!(textarea.cursor, 6);
    }

    #[test]
    fn delete_current_line_on_last_line() {
        let mut textarea = TextArea::new();
        textarea.insert_str("line1\nline2");
        textarea.move_end();
        textarea.delete_current_line();
        assert_eq!(textarea.text(), "line1");
        assert_eq!(textarea.cursor, 5);
    }

    #[test]
    fn word_movement_skips_separators() {
        let mut textarea = TextArea::new();
        textarea.insert_str("foo bar baz");
        textarea.move_end();
        textarea.move_word_left();
        assert_eq!(&textarea.text()[..textarea.cursor], "foo bar ");
        textarea.move_word_left();
        assert_eq!(&textarea.text()[..textarea.cursor], "foo ");
        textarea.move_word_left();
        assert_eq!(textarea.cursor, 0);
    }

    #[test]
    fn word_movement_right_lands_on_next_word_start() {
        let mut textarea = TextArea::new();
        textarea.insert_str("foo  bar baz");
        textarea.move_home();
        textarea.move_word_right();
        assert_eq!(&textarea.text()[textarea.cursor..], "bar baz");
        textarea.move_word_right();
        assert_eq!(&textarea.text()[textarea.cursor..], "baz");
        textarea.move_word_right();
        assert_eq!(textarea.cursor, textarea.text().len());
    }

    #[test]
    fn delete_word_backward_removes_previous_word() {
        let mut textarea = TextArea::new();
        textarea.insert_str("hello cruel world");
        textarea.move_end();
        textarea.delete_word_backward();
        assert_eq!(textarea.text(), "hello cruel ");
        textarea.delete_word_backward();
        assert_eq!(textarea.text(), "hello ");
        textarea.delete_word_backward();
        assert_eq!(textarea.text(), "");
        assert_eq!(textarea.cursor, 0);
    }

    #[test]
    fn delete_word_forward_removes_next_word() {
        let mut textarea = TextArea::new();
        textarea.insert_str("hello cruel world");
        textarea.move_home();
        textarea.move_word_right();
        assert_eq!(&textarea.text()[textarea.cursor..], "cruel world");
        textarea.delete_word_forward();
        assert_eq!(textarea.text(), "hello  world");
    }

    #[test]
    fn delete_to_line_start_keeps_rest_of_line() {
        let mut textarea = TextArea::new();
        textarea.insert_str("keep\ndrop me");
        textarea.move_end();
        textarea.delete_to_line_start();
        assert_eq!(textarea.text(), "keep\n");
        assert_eq!(textarea.cursor, 5);
    }

    #[test]
    fn delete_to_line_end_keeps_line_start() {
        let mut textarea = TextArea::new();
        textarea.set_text("abc def\nsecond".into());
        textarea.move_right();
        textarea.move_right();
        textarea.move_right();
        textarea.delete_to_line_end();
        assert_eq!(textarea.text(), "abc\nsecond");
        assert_eq!(textarea.cursor, 3);
    }
}
