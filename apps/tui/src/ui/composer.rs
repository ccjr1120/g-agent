use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::Widget;

use crate::ui::paste::normalize_paste;
use crate::ui::textarea::{TextArea, TextAreaWidget};
use crate::ui::theme::style;

#[derive(Debug, Clone)]
pub struct SlashCommand {
    pub value: String,
    pub description: String,
}

pub struct Composer {
    pub textarea: TextArea,
    pub menu_open: bool,
    pub menu_index: usize,
    pub open_group: Option<String>,
    pub restore_pending: Option<String>,
}

impl Composer {
    pub fn new() -> Self {
        Self {
            textarea: TextArea::new(),
            menu_open: false,
            menu_index: 0,
            open_group: None,
            restore_pending: None,
        }
    }

    pub fn on_text_changed(&mut self) {
        // While browsing a group (e.g. skills), keep the menu open and let the
        // input act as a filter — even when it no longer starts with `/`.
        if self.open_group.is_some() {
            self.menu_open = true;
            self.menu_index = 0;
            return;
        }
        self.menu_open = self.textarea.text().starts_with('/');
        self.menu_index = 0;
    }

    pub fn consume_restore(&mut self) -> Option<String> {
        let value = self.restore_pending.take();
        if let Some(text) = value.clone() {
            self.textarea.set_text(text.clone());
            self.textarea.move_end();
            self.on_text_changed();
        }
        value
    }

    pub fn set_restore(&mut self, text: String) {
        self.restore_pending = Some(text);
    }

    pub fn insert_paste(&mut self, raw: &str) {
        let content = normalize_paste(raw);
        if content.is_empty() {
            return;
        }
        self.textarea.insert_str(&content);
        self.on_text_changed();
    }

    pub fn delete_backward(&mut self) {
        self.textarea.delete_backward();
        self.on_text_changed();
    }

    pub fn delete_forward(&mut self) {
        self.textarea.delete_forward();
        self.on_text_changed();
    }

    pub fn delete_current_line(&mut self) {
        self.textarea.delete_current_line();
        self.on_text_changed();
    }

    pub fn move_word_left(&mut self) {
        self.textarea.move_word_left();
    }

    pub fn move_word_right(&mut self) {
        self.textarea.move_word_right();
    }

    pub fn delete_word_backward(&mut self) {
        self.textarea.delete_word_backward();
        self.on_text_changed();
    }

    pub fn delete_word_forward(&mut self) {
        self.textarea.delete_word_forward();
        self.on_text_changed();
    }

    pub fn delete_to_line_start(&mut self) {
        self.textarea.delete_to_line_start();
        self.on_text_changed();
    }

    pub fn delete_to_line_end(&mut self) {
        self.textarea.delete_to_line_end();
        self.on_text_changed();
    }

    pub fn clear(&mut self) {
        self.textarea.set_text(String::new());
        self.open_group = None;
        self.on_text_changed();
    }

    pub fn menu_items<'a>(
        &'a self,
        commands: &'a [SlashCommand],
        groups: &'a [(&'a str, &'a [SlashCommand])],
    ) -> Vec<&'a SlashCommand> {
        if !self.menu_open {
            return Vec::new();
        }
        if let Some(group) = &self.open_group {
            let query = self
                .textarea
                .text()
                .trim()
                .trim_start_matches('/')
                .to_lowercase();
            if let Some((_, children)) = groups
                .iter()
                .find(|(name, _)| command_group_id(name) == group.as_str())
            {
                return children
                    .iter()
                    .filter(|command| {
                        if query.is_empty() {
                            return true;
                        }
                        let name = command_group_id(&command.value).to_lowercase();
                        name.contains(&query) || command.description.to_lowercase().contains(&query)
                    })
                    .collect();
            }
            return Vec::new();
        }
        let query = self.textarea.text().to_lowercase();
        let mut root: Vec<&SlashCommand> = commands
            .iter()
            .filter(|command| command.value.to_lowercase().starts_with(&query))
            .collect();
        if root.is_empty() {
            let needle = query.trim_start_matches('/');
            if !needle.is_empty() {
                root = commands
                    .iter()
                    .filter(|command| command.value.to_lowercase().contains(needle))
                    .collect();
            }
        }
        root
    }

    pub fn move_menu(&mut self, delta: isize, item_count: usize) {
        if item_count == 0 {
            self.menu_index = 0;
            return;
        }
        let next = (self.menu_index as isize + delta).rem_euclid(item_count as isize) as usize;
        self.menu_index = next;
    }

    pub fn cursor_pos(&self, area: Rect, prefix_cols: u16) -> Option<(u16, u16)> {
        let inner = Rect {
            x: area.x.saturating_add(prefix_cols),
            y: area.y,
            width: area.width.saturating_sub(prefix_cols),
            height: area.height,
        };
        self.textarea.cursor_pos(inner)
    }
}

pub struct ComposerWidget<'a> {
    composer: &'a Composer,
    disabled: bool,
}

impl<'a> ComposerWidget<'a> {
    pub fn new(composer: &'a Composer, disabled: bool) -> Self {
        Self { composer, disabled }
    }
}

impl Widget for ComposerWidget<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let style = if self.disabled {
            style::composer_disabled()
        } else {
            style::composer_active()
        };

        TextAreaWidget::new(&self.composer.textarea, "> ", style, !self.disabled).render(area, buf);
    }
}

pub struct MenuWidget<'a> {
    composer: &'a Composer,
    menu_items: &'a [SlashCommand],
}

impl<'a> MenuWidget<'a> {
    pub fn new(composer: &'a Composer, menu_items: &'a [SlashCommand]) -> Self {
        Self {
            composer,
            menu_items,
        }
    }
}

impl Widget for MenuWidget<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if !self.composer.menu_open || self.menu_items.is_empty() || area.height == 0 {
            return;
        }

        let total = self.menu_items.len();
        let selected = self.composer.menu_index.min(total.saturating_sub(1));
        let counter = if total > MENU_VISIBLE_ROWS {
            format!(" · {}/{}", selected + 1, total)
        } else {
            String::new()
        };
        let hint_text = if self.composer.open_group.is_some() {
            format!("Filter · type to search · ↑↓ select · Enter run · Esc back{counter}")
        } else {
            format!("Commands · ↑↓ select · Tab complete · Enter run · Esc close{counter}")
        };
        let hint = Line::from(vec![Span::styled(hint_text, style::muted())]);
        buf.set_line(area.x, area.y, &hint, area.width);

        let start = selected.saturating_sub(MENU_VISIBLE_ROWS - 1);
        for (offset, (index, item)) in self
            .menu_items
            .iter()
            .enumerate()
            .skip(start)
            .take(MENU_VISIBLE_ROWS)
            .enumerate()
        {
            let row = area.y + 1 + offset as u16;
            if row >= area.bottom() {
                break;
            }
            let is_selected = index == selected;
            let prefix = if is_selected { "❯ " } else { "  " };
            let line = Line::from(vec![
                Span::styled(
                    format!("{prefix}{}", item.value),
                    if is_selected {
                        style::menu_selected()
                    } else {
                        Style::default()
                    },
                ),
                Span::raw("  "),
                Span::styled(item.description.clone(), style::menu_description()),
            ]);
            buf.set_line(area.x, row, &line, area.width);
        }
    }
}

pub const MENU_VISIBLE_ROWS: usize = 6;

pub fn menu_height(composer: &Composer, menu_items: &[SlashCommand]) -> u16 {
    if composer.menu_open && !menu_items.is_empty() {
        menu_items.len().min(MENU_VISIBLE_ROWS) as u16 + 1
    } else {
        0
    }
}

pub fn command_group_id(name: &str) -> &str {
    name.trim_start_matches('/')
}

impl Default for Composer {
    fn default() -> Self {
        Self::new()
    }
}

/// Global prompt history for ↑/↓ recall. Survives agent switches and `/new`.
#[derive(Debug, Default)]
pub struct InputHistory {
    entries: Vec<String>,
    /// `None` means the live draft is active (not browsing history).
    index: Option<usize>,
    draft: String,
}

impl InputHistory {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_browsing(&self) -> bool {
        self.index.is_some()
    }

    /// Record a submitted prompt. Consecutive duplicates are ignored.
    pub fn push(&mut self, entry: impl Into<String>) {
        let entry = entry.into().trim().to_string();
        if entry.is_empty() {
            return;
        }
        if self.entries.last() == Some(&entry) {
            self.reset_browse();
            return;
        }
        self.entries.push(entry);
        self.reset_browse();
    }

    pub fn reset_browse(&mut self) {
        self.index = None;
        self.draft.clear();
    }

    /// Move to an older entry. Returns the text to show, or `None` if nothing changed.
    pub fn up(&mut self, current: &str) -> Option<String> {
        if self.entries.is_empty() {
            return None;
        }
        let start = match self.index {
            None => {
                self.draft = current.to_string();
                self.entries.len()
            }
            Some(0) => return None,
            Some(i) => i,
        };

        let Some(idx) = (0..start).rev().find(|&i| is_recallable(&self.entries[i])) else {
            if self.index.is_none() {
                self.draft.clear();
            }
            return None;
        };
        self.index = Some(idx);
        Some(self.entries[idx].clone())
    }

    /// Move toward newer entries / restore the draft. Returns text to show, or
    /// `None` when not browsing.
    pub fn down(&mut self) -> Option<String> {
        let i = self.index?;
        let next = i + 1;
        if next >= self.entries.len() {
            self.index = None;
            return Some(std::mem::take(&mut self.draft));
        }
        if let Some(idx) = (next..self.entries.len()).find(|&j| is_recallable(&self.entries[j])) {
            self.index = Some(idx);
            Some(self.entries[idx].clone())
        } else {
            self.index = None;
            Some(std::mem::take(&mut self.draft))
        }
    }
}

fn is_recallable(text: &str) -> bool {
    let trimmed = text.trim();
    !trimmed.is_empty() && !trimmed.starts_with('/') && trimmed != "exit"
}

#[cfg(test)]
mod input_history_tests {
    use super::*;

    #[test]
    fn up_down_recalls_across_entries_and_restores_draft() {
        let mut history = InputHistory::new();
        history.push("first");
        history.push("second");

        assert_eq!(history.up("draft-now").as_deref(), Some("second"));
        assert_eq!(history.up("second").as_deref(), Some("first"));
        assert!(history.up("first").is_none());
        assert_eq!(history.down().as_deref(), Some("second"));
        assert_eq!(history.down().as_deref(), Some("draft-now"));
        assert!(!history.is_browsing());
        assert!(history.down().is_none());
    }

    #[test]
    fn push_skips_consecutive_duplicates_and_resets_browse() {
        let mut history = InputHistory::new();
        history.push("hello");
        history.push("hello");
        assert_eq!(history.entries.len(), 1);

        history.push("world");
        let _ = history.up("");
        assert!(history.is_browsing());
        history.push("again");
        assert!(!history.is_browsing());
        assert_eq!(history.entries, vec!["hello", "world", "again"]);
    }

    #[test]
    fn up_skips_slash_commands_already_in_history() {
        let mut history = InputHistory::new();
        history.entries = vec![
            "hello".into(),
            "/resume 160c737d-71ef-426a-8a0b-e79612fd1d8a".into(),
            "world".into(),
        ];

        assert_eq!(history.up("").as_deref(), Some("world"));
        assert_eq!(history.up("world").as_deref(), Some("hello"));
        assert_eq!(history.down().as_deref(), Some("world"));
        assert_eq!(history.down().as_deref(), Some(""));
    }

    #[test]
    fn pasted_content_is_inserted_verbatim_and_sent_as_is() {
        let mut composer = Composer::new();
        let pasted = "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9";
        composer.insert_paste(pasted);
        assert_eq!(composer.textarea.text(), pasted);
    }

    #[test]
    fn short_paste_is_inserted_directly() {
        let mut composer = Composer::new();
        composer.insert_paste("hello world");
        assert_eq!(composer.textarea.text(), "hello world");
    }
}
