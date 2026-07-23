use std::f64::consts::{PI, TAU};

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::Widget;
use unicode_width::UnicodeWidthStr;

use crate::agent::client::{ConnectionState, ContextUsage};
use crate::ui::theme::style;

pub const STATUS_HEIGHT: u16 = 1;
const RING_WIDTH: u16 = 1;
const SECTION_GAP: &str = "  ";

const ICON_MODEL: &str = "◇";
const ICON_AGENT: &str = "◎";

const BRAILLE_DOT: [u16; 8] = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80];

#[derive(Clone, Copy, PartialEq, Eq)]
enum DotKind {
    Empty,
    Track,
    Filled,
}

pub struct StatusBar<'a> {
    pub connection: ConnectionState,
    pub model: &'a str,
    pub active_agent: &'a str,
    pub context: ContextUsage,
}

impl Widget for StatusBar<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.height == 0 || area.width == 0 {
            return;
        }

        let connection = self.connection_line();
        let connection_width = line_width(&connection) as u16;
        if connection_width > 0 {
            buf.set_line(area.x, area.y, &connection, connection_width);
        }

        let ring_width = RING_WIDTH.min(area.width);
        let metadata = self.metadata_line();
        let metadata_width = line_width(&metadata) as u16;
        let total_right = metadata_width.saturating_add(ring_width);
        if total_right == 0 {
            return;
        }

        let right_x = area
            .x
            .saturating_add(area.width.saturating_sub(total_right));
        if metadata_width > 0 {
            buf.set_line(right_x, area.y, &metadata, metadata_width);
        }
        if ring_width > 0 {
            ContextRing::new(self.context).render(
                Rect {
                    x: right_x + metadata_width,
                    y: area.y,
                    width: ring_width,
                    height: area.height,
                },
                buf,
            );
        }
    }
}

impl StatusBar<'_> {
    fn connection_line(&self) -> Line<'static> {
        let (icon, label) = match self.connection {
            ConnectionState::Connecting => ("●", "Connecting"),
            ConnectionState::Connected => ("●", "Connected"),
            ConnectionState::Disconnected => ("○", "Disconnected"),
        };

        Line::from(vec![
            Span::styled(icon, style::status_icon()),
            Span::raw(" "),
            Span::styled(label, style::status_label()),
        ])
    }

    fn metadata_line(&self) -> Line<'static> {
        let model = display_model(self.model);
        let agent = if self.active_agent.is_empty() {
            "—".to_string()
        } else {
            self.active_agent.to_string()
        };
        let percent = self.context.percent.min(100);

        Line::from(vec![
            Span::styled(ICON_MODEL, style::status_label()),
            Span::raw(" "),
            Span::styled(model, style::status_meta()),
            Span::raw(SECTION_GAP),
            Span::styled(ICON_AGENT, style::status_label()),
            Span::raw(" "),
            Span::styled(agent, style::status_meta()),
            Span::raw(SECTION_GAP),
            Span::styled(format!("{percent}%"), style::status_meta()),
        ])
    }
}

fn line_width(line: &Line<'_>) -> usize {
    line.spans
        .iter()
        .map(|span| span.content.width())
        .sum()
}

struct ContextRing {
    context: ContextUsage,
}

impl ContextRing {
    fn new(context: ContextUsage) -> Self {
        Self { context }
    }
}

impl Widget for ContextRing {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.width == 0 || area.height == 0 {
            return;
        }

        let percent = self.context.percent.min(100);
        let filled_style = context_style(percent);
        let track_style = style::context_track();

        let dot_w = area.width as usize * 2;
        let dot_h = area.height as usize * 4;
        let mut dots = vec![vec![DotKind::Empty; dot_w]; dot_h];

        let cx = dot_w as f64 / 2.0 - 0.5;
        let cy = dot_h as f64 / 2.0 - 0.5;
        let radius = dot_w.min(dot_h) as f64 / 2.0 - 0.5;
        let r_in = (radius - 1.0).max(0.3);
        let r_out = radius;
        let fill_angle = TAU * percent as f64 / 100.0;

        for y in 0..dot_h {
            for x in 0..dot_w {
                let dx = x as f64 - cx;
                let dy = y as f64 - cy;
                let dist = (dx * dx + dy * dy).sqrt();
                if dist < r_in || dist > r_out {
                    continue;
                }
                let angle = (dy.atan2(dx) + PI / 2.0 + TAU) % TAU;
                dots[y][x] = if angle <= fill_angle {
                    DotKind::Filled
                } else {
                    DotKind::Track
                };
            }
        }

        for char_y in 0..area.height as usize {
            for char_x in 0..area.width as usize {
                let mut track_value = 0u16;
                let mut filled_value = 0u16;

                for row in 0..4 {
                    for col in 0..2 {
                        let dot_x = char_x * 2 + col;
                        let dot_y = char_y * 4 + row;
                        if dot_y >= dot_h || dot_x >= dot_w {
                            continue;
                        }
                        let bit = BRAILLE_DOT[row * 2 + col];
                        match dots[dot_y][dot_x] {
                            DotKind::Filled => filled_value |= bit,
                            DotKind::Track => track_value |= bit,
                            DotKind::Empty => {}
                        }
                    }
                }

                let x = area.x + char_x as u16;
                let y = area.y + char_y as u16;
                let value = track_value | filled_value;
                if value == 0 {
                    continue;
                }
                let style = if filled_value > 0 {
                    filled_style
                } else {
                    track_style
                };
                let ch = char::from_u32(0x2800 + value as u32).unwrap();
                buf[(x, y)].set_char(ch).set_style(style);
            }
        }
    }
}

fn context_style(percent: u8) -> Style {
    style::context_usage(percent)
}

fn display_model(model: &str) -> String {
    model
        .rsplit('/')
        .next()
        .unwrap_or(model)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_ring_renders_without_panic() {
        let mut buf = Buffer::empty(Rect::new(0, 0, 1, 1));
        ContextRing::new(ContextUsage {
            used_tokens: 50_000,
            max_tokens: 100_000,
            percent: 50,
        })
        .render(Rect::new(0, 0, 1, 1), &mut buf);
    }
}
