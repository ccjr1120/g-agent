use std::time::Instant;

use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};

const SPINNER_FRAMES: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS: u64 = 140;

pub fn spinner_frame(clock: Instant) -> usize {
    ((clock.elapsed().as_millis() / FRAME_MS as u128) as usize) % SPINNER_FRAMES.len()
}

pub fn format_elapsed(start: Instant) -> String {
    let ms = start.elapsed().as_millis();
    if ms == 0 {
        return "0.0s".into();
    }
    let seconds = ms as f64 / 1000.0;
    if seconds < 60.0 {
        return format!("{seconds:.1}s");
    }
    let minutes = (seconds / 60.0).floor() as u64;
    let remainder = (seconds % 60.0).floor() as u64;
    format!("{minutes}m{remainder}s")
}

pub fn spinner_line(label: &str, clock: Instant, turn_start: Option<Instant>, dim: bool) -> Line<'static> {
    let frame = SPINNER_FRAMES[spinner_frame(clock)];
    let elapsed = turn_start.map(|start| format_elapsed(start));
    let label_text = match (&elapsed, dim) {
        (Some(elapsed), true) => format!(" {elapsed}"),
        (Some(elapsed), false) => format!("{label} {elapsed}"),
        (None, _) => label.to_string(),
    };

    if dim {
        return Line::from(Span::styled(
            format!("{frame}{label_text}"),
            Style::default().fg(Color::DarkGray),
        ));
    }

    Line::from(vec![
        Span::styled(frame.to_string(), Style::default().fg(Color::Yellow)),
        Span::styled(
            format!(" {label_text}"),
            Style::default().fg(Color::DarkGray),
        ),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn format_elapsed_shows_seconds() {
        let start = Instant::now() - Duration::from_millis(2500);
        assert_eq!(format_elapsed(start), "2.5s");
    }

    #[test]
    fn spinner_frame_advances() {
        let clock = Instant::now() - Duration::from_millis(280);
        assert_eq!(spinner_frame(clock), 2);
    }
}
