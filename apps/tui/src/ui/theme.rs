//! Centralized UI theme tokens for the g-agent TUI.
//!
//! All user-facing colors and styles should come from this module.
//! See `apps/tui/UI_SPEC.md` for the full design specification.

/// Raw palette tokens. Prefer semantic helpers in [`style`] for rendering.
pub mod palette {
    use ratatui::style::Color;

    /// Primary brand accent — interactive highlights, user input, key metadata.
    pub const BRAND: Color = Color::Cyan;

    /// Positive feedback such as copy confirmations.
    pub const SUCCESS: Color = Color::Green;

    /// Non-blocking warnings, history hints, and elevated context usage.
    pub const WARNING: Color = Color::Yellow;

    /// Errors and critical context usage.
    pub const ERROR: Color = Color::Red;

    /// Secondary text, hints, tool labels, borders, and disabled states.
    pub const MUTED: Color = Color::DarkGray;
}

/// Semantic styles mapped to UI roles.
pub mod style {
    use super::palette;
    use ratatui::style::{Modifier, Style};

    pub fn brand() -> Style {
        Style::default().fg(palette::BRAND)
    }

    pub fn brand_bold() -> Style {
        brand().add_modifier(Modifier::BOLD)
    }

    pub fn user_message() -> Style {
        brand()
    }

    pub fn assistant_bullet() -> Style {
        Style::default().add_modifier(Modifier::BOLD)
    }

    pub fn thinking() -> Style {
        Style::default()
            .fg(palette::MUTED)
            .add_modifier(Modifier::ITALIC)
    }

    pub fn tool_call() -> Style {
        Style::default().fg(palette::MUTED)
    }

    pub fn banner() -> Style {
        brand_bold()
    }

    pub fn welcome() -> Style {
        Style::default().fg(palette::MUTED)
    }

    pub fn warning() -> Style {
        Style::default().fg(palette::WARNING)
    }

    pub fn error() -> Style {
        Style::default().fg(palette::ERROR)
    }

    pub fn success() -> Style {
        Style::default().fg(palette::SUCCESS)
    }

    pub fn muted() -> Style {
        Style::default().fg(palette::MUTED)
    }

    pub fn border() -> Style {
        muted()
    }

    pub fn composer_active() -> Style {
        brand()
    }

    pub fn composer_disabled() -> Style {
        muted()
    }

    pub fn menu_selected() -> Style {
        brand_bold()
    }

    pub fn menu_description() -> Style {
        muted()
    }

    pub fn status_icon() -> Style {
        brand()
    }

    pub fn status_label() -> Style {
        muted()
    }

    /// Secondary metadata on the status bar (model, agent, context percent).
    pub fn status_meta() -> Style {
        muted()
    }

    pub fn spinner_frame() -> Style {
        Style::default().fg(palette::WARNING)
    }

    pub fn spinner_label() -> Style {
        muted()
    }

    pub fn context_track() -> Style {
        muted()
    }

    pub fn context_usage(percent: u8) -> Style {
        let color = if percent >= 90 {
            palette::ERROR
        } else if percent >= 75 {
            palette::WARNING
        } else {
            palette::BRAND
        };
        Style::default().fg(color)
    }
}
