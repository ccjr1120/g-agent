use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::buffer::Buffer;
use ratatui::widgets::Widget;

use crate::ui::textarea::{TextArea, TextAreaWidget};

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

    pub fn clear(&mut self) {
        self.textarea.set_text(String::new());
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
            if let Some(header) = root.iter().find(|command| command.value.trim_start_matches('/') == group) {
                items.push(*header);
            }
            if let Some((_, children)) = groups.iter().find(|(name, _)| *name == group) {
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
    menu_items: &'a [SlashCommand],
}

impl<'a> ComposerWidget<'a> {
    pub fn new(composer: &'a Composer, disabled: bool, menu_items: &'a [SlashCommand]) -> Self {
        Self {
            composer,
            disabled,
            menu_items,
        }
    }
}

impl Widget for ComposerWidget<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let style = if self.disabled {
            Style::default().fg(Color::DarkGray)
        } else {
            Style::default().fg(Color::Cyan)
        };

        let input_height = self.composer.textarea.desired_height(area.width.saturating_sub(2)).min(area.height);
        let input_area = Rect {
            x: area.x,
            y: area.y,
            width: area.width,
            height: input_height,
        };
        TextAreaWidget::new(
            &self.composer.textarea,
            "> ",
            style,
            !self.disabled,
        )
        .render(input_area, buf);

        if self.composer.menu_open && !self.menu_items.is_empty() {
            let menu_y = input_area.bottom();
            if menu_y < area.bottom() {
                let hint = Line::from(vec![
                    Span::styled("Commands · ↑↓ select · Enter run · Esc close", Style::default().fg(Color::DarkGray)),
                ]);
                buf.set_line(area.x, menu_y, &hint, area.width);
            }
            for (index, item) in self.menu_items.iter().enumerate().take(6) {
                let row = menu_y + 1 + index as u16;
                if row >= area.bottom() {
                    break;
                }
                let selected = index == self.composer.menu_index;
                let prefix = if selected { "❯ " } else { "  " };
                let line = Line::from(vec![
                    Span::styled(
                        format!("{prefix}{}", item.value),
                        if selected {
                            Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)
                        } else {
                            Style::default()
                        },
                    ),
                    Span::raw("  "),
                    Span::styled(item.description.clone(), Style::default().fg(Color::DarkGray)),
                ]);
                buf.set_line(area.x, row, &line, area.width);
            }
        }
    }
}

impl Default for Composer {
    fn default() -> Self {
        Self::new()
    }
}
