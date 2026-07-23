use std::collections::HashMap;
use std::hash::{Hash, Hasher};

use markdown_ratatui::{render_with, Theme};
use markdown_stream::{parse_gfm, Event, Parser, StreamParser};
use ratatui::text::Line;

pub struct MarkdownCache {
    width: u16,
    static_cache: HashMap<u64, Vec<Line<'static>>>,
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

    pub fn render_static(&mut self, text: &str, width: u16) -> &[Line<'static>] {
        self.set_width(width);
        let key = cache_key(text, width);
        if !self.static_cache.contains_key(&key) {
            let lines = render_markdown(text, width);
            self.static_cache.insert(key, lines);
        }
        &self.static_cache[&key]
    }
}

pub struct StreamingMarkdown {
    parser: StreamParser,
    events: Vec<Event>,
    fed_len: usize,
    rendered: Vec<Line<'static>>,
}

impl StreamingMarkdown {
    pub fn new() -> Self {
        Self {
            parser: StreamParser::new_gfm(),
            events: Vec::new(),
            fed_len: 0,
            rendered: Vec::new(),
        }
    }

    pub fn reset(&mut self) {
        *self = Self::new();
    }

    pub fn sync(&mut self, text: &str, width: u16) {
        if text.len() < self.fed_len {
            self.reset();
        }
        if text.len() > self.fed_len {
            let delta = &text[self.fed_len..];
            self.events.extend(self.parser.write(delta.as_bytes()));
            self.fed_len = text.len();
        }
        self.rerender(width);
    }

    pub fn flush(&mut self, text: &str, width: u16) {
        self.sync(text, width);
        self.events.extend(self.parser.flush());
        self.rerender(width);
    }

    pub fn lines(&self) -> &[Line<'static>] {
        &self.rendered
    }

    fn rerender(&mut self, width: u16) {
        self.rendered = render_with(
            &self.events,
            &Theme::default(),
            width.max(1) as usize,
        )
        .lines;
    }
}

pub fn render_markdown(text: &str, width: u16) -> Vec<Line<'static>> {
    if text.trim().is_empty() {
        return Vec::new();
    }
    let events = parse_gfm(text);
    render_with(&events, &Theme::default(), width.max(1) as usize).lines
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
}
