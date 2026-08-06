use std::collections::HashMap;
use std::hash::{Hash, Hasher};

use markdown_ratatui::{render_with_links, Theme};
use markdown_stream::{parse_gfm, Event, InlineStyle};
use ratatui::style::Style;
use ratatui::text::{Line, Span};

pub use markdown_ratatui::LinkRegion;

struct CachedMarkdown {
    lines: Vec<Line<'static>>,
    links: Vec<LinkRegion>,
}

pub struct MarkdownCache {
    width: u16,
    static_cache: HashMap<u64, CachedMarkdown>,
}

impl MarkdownCache {
    pub fn new() -> Self {
        Self {
            width: 0,
            static_cache: HashMap::new(),
        }
    }

    pub fn set_width(&mut self, width: u16) {
        if self.width != width {
            self.width = width;
            self.static_cache.clear();
        }
    }

    pub fn clear(&mut self) {
        self.static_cache.clear();
    }

    pub fn render_static_with_links(
        &mut self,
        text: &str,
        width: u16,
    ) -> (&[Line<'static>], &[LinkRegion]) {
        self.set_width(width);
        let key = cache_key(text, width);
        let cached = self.static_cache.entry(key).or_insert_with(|| {
            let (lines, links) = render_markdown_with_links(text, width);
            CachedMarkdown { lines, links }
        });
        (&cached.lines, &cached.links)
    }
}

#[cfg(test)]
pub fn render_markdown(text: &str, width: u16) -> Vec<Line<'static>> {
    render_markdown_with_links(text, width).0
}

pub fn render_markdown_with_links(text: &str, width: u16) -> (Vec<Line<'static>>, Vec<LinkRegion>) {
    if text.trim().is_empty() {
        return (Vec::new(), Vec::new());
    }
    let events = parse_gfm(text);
    let (text, links) = render_with_links(&events, &Theme::default(), width.max(1) as usize);
    (text.lines, links)
}

/// Render inline markdown (bold, italic, code, links, strikethrough) into styled
/// spans, embedding them into a line that already has a plain prefix. Block-level
/// markers (`-`, `#`, `>`…) are left literal so panel text never loses content.
pub fn render_inline_markdown(text: &str, base: Style) -> Vec<Span<'static>> {
    if text.trim().is_empty() || starts_with_block_marker(text) {
        return vec![Span::styled(text.to_string(), base)];
    }
    let theme = Theme::default();
    let mut spans = Vec::new();
    for event in parse_gfm(text) {
        if let Event::Text { text, style, .. } = event {
            if text.is_empty() {
                continue;
            }
            spans.push(Span::styled(text, inline_style(style, &theme, base)));
        }
    }
    if spans.is_empty() {
        vec![Span::styled(text.to_string(), base)]
    } else {
        spans
    }
}

fn inline_style(inline: InlineStyle, theme: &Theme, base: Style) -> Style {
    let mut style = base;
    if inline.strong {
        style = style.patch(theme.bold);
    }
    if inline.emphasis {
        style = style.patch(theme.italic);
    }
    if inline.strikethrough {
        style = style.patch(theme.strike);
    }
    if inline.code {
        style = style.patch(theme.code);
    }
    if inline.link.is_some() {
        style = style.patch(theme.link);
    }
    style
}

/// True when the text begins with a block-level construct whose marker would be
/// dropped by inline-only parsing (e.g. a list `- ` or a heading `#`).
fn starts_with_block_marker(text: &str) -> bool {
    let trimmed = text.trim_start();
    let mut chars = trimmed.chars();
    match chars.next() {
        Some('#') | Some('>') => true,
        Some('-') | Some('+') | Some('*') => {
            chars.next().is_some_and(char::is_whitespace) || trimmed.starts_with("---")
        }
        Some(c) if c.is_ascii_digit() => {
            let rest = &trimmed[c.len_utf8()..];
            let digits = rest.chars().take_while(|ch| ch.is_ascii_digit()).count();
            rest.chars()
                .nth(digits)
                .is_some_and(|ch| ch == '.' || ch == ')')
        }
        _ => false,
    }
}

fn cache_key(text: &str, width: u16) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut hasher);
    width.hash(&mut hasher);
    hasher.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_bold_inline() {
        let lines = render_markdown("hello **world**", 80);
        let joined: String = lines
            .iter()
            .flat_map(|line| line.spans.iter().map(|span| span.content.as_ref()))
            .collect();
        assert!(joined.contains("world"));
    }

    #[test]
    fn inline_render_splits_styled_runs() {
        let spans = render_inline_markdown("a **b** c", Style::default());
        let joined: String = spans.iter().map(|span| span.content.as_ref()).collect();
        assert_eq!(joined, "a b c");
        assert!(spans[1]
            .style
            .add_modifier
            .contains(ratatui::style::Modifier::BOLD));
    }

    #[test]
    fn inline_render_keeps_block_markers_literal() {
        let spans = render_inline_markdown("- item **bold**", Style::default());
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].content.as_ref(), "- item **bold**");
    }

    #[test]
    fn inline_render_keeps_emphasis_text() {
        let spans = render_inline_markdown("done", Style::default());
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].content.as_ref(), "done");
    }
}
