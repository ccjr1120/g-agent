use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::buffer::Buffer;
use ratatui::widgets::Widget;

use crate::ui::paste::{
    expand_paste_placeholders, find_placeholder_at, normalize_paste, paste_placeholder,
    should_attach_as_block, PastedBlock,
};
use crate::ui::textarea::{TextArea, TextAreaWidget};
use crate::ui::theme::style;

#[derive(Debug, Clone)]
pub struct SlashCommand {
    pub value: String,
    pub description: String,
}

pub struct Composer {
    pub textarea: TextArea,
    pub pastes: Vec<PastedBlock>,
    next_paste_id: usize,
    pub menu_open: bool,
    pub menu_index: usize,
    pub open_group: Option<String>,
    pub restore_pending: Option<String>,
}

impl Composer {
    pub fn new() -> Self {
        Self {
            textarea: TextArea::new(),
            pastes: Vec::new(),
            next_paste_id: 1,
            menu_open: false,
            menu_index: 0,
            open_group: None,
            restore_pending: None,
        }
    }

    pub fn on_text_changed(&mut self) {
        self.menu_open = self.textarea.text().starts_with('/') && !self.textarea.text().contains(' ');
        if self.menu_open {
            self.menu_index = 0;
            self.open_group = None;
        }
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

        if should_attach_as_block(&content) {
            let id = self.next_paste_id;
            self.next_paste_id += 1;
            let line_count = content.lines().count().max(1);
            let placeholder = paste_placeholder(id, line_count);
            self.pastes.push(PastedBlock {
                id,
                content,
                placeholder: placeholder.clone(),
            });
            self.textarea.insert_str(&placeholder);
        } else {
            self.textarea.insert_str(&content);
        }
        self.on_text_changed();
    }

    pub fn expand_message(&self, display: &str) -> String {
        expand_paste_placeholders(display, &self.pastes)
    }

    pub fn delete_backward(&mut self) {
        if let Some((range, id)) = find_placeholder_at(self.textarea.text(), self.textarea.cursor()) {
            self.textarea.replace_range(range);
            self.pastes.retain(|block| block.id != id);
            self.on_text_changed();
            return;
        }
        self.textarea.delete_backward();
        self.on_text_changed();
    }

    pub fn delete_forward(&mut self) {
        let cursor = self.textarea.cursor();
        if let Some((range, id)) = find_placeholder_at(self.textarea.text(), cursor.saturating_add(1)) {
            if range.start == cursor || range.contains(&cursor) {
                self.textarea.replace_range(range);
                self.pastes.retain(|block| block.id != id);
                self.on_text_changed();
                return;
            }
        }
        self.textarea.delete_forward();
        self.on_text_changed();
    }

    pub fn delete_current_line(&mut self) {
        self.textarea.delete_current_line();
        self.pastes
            .retain(|block| self.textarea.text().contains(&block.placeholder));
        self.on_text_changed();
    }

    pub fn clear(&mut self) {
        self.textarea.set_text(String::new());
        self.pastes.clear();
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
        let query = self.textarea.text().to_lowercase();
        let root: Vec<&SlashCommand> = commands
            .iter()
            .filter(|command| command.value.to_lowercase().starts_with(&query))
            .collect();
        if let Some(group) = &self.open_group {
            let mut items = Vec::new();
            if let Some(header) = root
                .iter()
                .find(|command| command_group_id(&command.value) == group.as_str())
            {
                items.push(*header);
            }
            if let Some((_, children)) = groups
                .iter()
                .find(|(name, _)| command_group_id(name) == group.as_str())
            {
                items.extend(children.iter());
            }
            return items;
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

        TextAreaWidget::new(
            &self.composer.textarea,
            "> ",
            style,
            !self.disabled,
        )
        .render(area, buf);
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

        let hint = Line::from(vec![Span::styled(
            "Commands · ↑↓ select · Enter run · Esc close",
            style::muted(),
        )]);
        buf.set_line(area.x, area.y, &hint, area.width);

        for (index, item) in self.menu_items.iter().enumerate().take(6) {
            let row = area.y + 1 + index as u16;
            if row >= area.bottom() {
                break;
            }
            let selected = index == self.composer.menu_index;
            let prefix = if selected { "❯ " } else { "  " };
            let line = Line::from(vec![
                Span::styled(
                    format!("{prefix}{}", item.value),
                    if selected {
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

pub fn menu_height(composer: &Composer, menu_items: &[SlashCommand]) -> u16 {
    if composer.menu_open && !menu_items.is_empty() {
        menu_items.len().min(6) as u16 + 1
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
