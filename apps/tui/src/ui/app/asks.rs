use super::model::PendingAsk;
use super::*;

impl App {
    /// The `ask_user` question currently focused for answering.
    pub(super) fn active_ask(&self) -> Option<&PendingAsk> {
        self.pending_asks.get(self.active_ask)
    }

    /// Switch the active question to the previous/next pending one, wrapping.
    pub(super) fn cycle_active_ask(&mut self, delta: isize) {
        let len = self.pending_asks.len();
        if len == 0 {
            return;
        }
        self.active_ask = (self.active_ask as isize + delta).rem_euclid(len as isize) as usize;
    }

    /// Remove an answered/skipped question and keep the active index valid.
    pub(super) fn remove_pending_ask(&mut self, id: &str) {
        if let Some(index) = self.pending_asks.iter().position(|ask| ask.id == id) {
            self.pending_asks.remove(index);
            if self.pending_asks.is_empty() {
                self.active_ask = 0;
            } else {
                self.active_ask = self.active_ask.min(self.pending_asks.len() - 1);
            }
        }
    }

    /// Drop all pending questions (turn finished, cancelled, or disconnected).
    pub(super) fn clear_pending_asks(&mut self) {
        self.pending_asks.clear();
        self.active_ask = 0;
    }
}

/// Compose the "answering" hint shown inside the composer while an ask_user
/// question awaits a reply, truncated to the composer width. When several
/// questions are pending, a `(i/n)` counter shows which one is being answered.
pub(super) fn truncate_ask_hint(question: &str, total: usize, index: usize, width: u16) -> String {
    let prefix = if total > 1 {
        format!("Answer ({}/{}): ", index + 1, total)
    } else {
        "Answer: ".to_string()
    };
    let max = width.saturating_sub(2) as usize;
    let text = question.replace('\n', " ");
    if prefix.chars().count() + text.chars().count() <= max || max == 0 {
        return format!("{prefix}{text}");
    }
    let budget = max.saturating_sub(prefix.chars().count() + 1);
    let truncated = text.chars().take(budget).collect::<String>();
    format!("{prefix}{truncated}…")
}

#[cfg(test)]
mod tests {
    use super::truncate_ask_hint;

    #[test]
    fn hint_shows_counter_only_when_multiple_questions_pending() {
        assert_eq!(
            truncate_ask_hint("Which DB?", 1, 0, 80),
            "Answer: Which DB?"
        );
        assert_eq!(
            truncate_ask_hint("Which DB?", 3, 1, 80),
            "Answer (2/3): Which DB?"
        );
    }

    #[test]
    fn hint_truncates_to_fit_the_composer_width() {
        let hint = truncate_ask_hint("A very long question about the preferred database engine", 2, 0, 30);
        assert!(hint.starts_with("Answer (1/2): A "));
        assert!(hint.ends_with('…'));
        assert!(hint.chars().count() <= 30);
    }

    #[test]
    fn hint_flattens_newlines() {
        assert_eq!(
            truncate_ask_hint("first line\nsecond line", 1, 0, 80),
            "Answer: first line second line"
        );
    }
}
