use super::*;
use crossterm::event::MouseButton;

impl App {
    pub(super) fn handle_input(&mut self, event: Event, area: Rect) {
        let transcript_area = self.transcript_area(area);
        match event {
            Event::Key(key) if key.kind == KeyEventKind::Press => {
                self.handle_key(key, transcript_area);
            }
            Event::Mouse(mouse) => self.handle_mouse(mouse, transcript_area),
            Event::Paste(text) => {
                self.input_history.reset_browse();
                self.composer.insert_paste(&text);
            }
            _ => {}
        }
    }

    /// True while an `ask_user` question with discrete options awaits a reply.
    fn ask_has_options(&self) -> bool {
        self.active_ask().is_some_and(|ask| ask.has_options())
    }

    fn handle_mouse(&mut self, mouse: crossterm::event::MouseEvent, transcript_area: Rect) {
        match mouse.kind {
            MouseEventKind::ScrollUp => self.scroll_history(3, transcript_area),
            MouseEventKind::ScrollDown => self.scroll_history(-3, transcript_area),
            MouseEventKind::Down(MouseButton::Left) => {
                self.open_link_at(mouse.column, mouse.row);
            }
            _ => {}
        }
    }

    /// Open a link under the cursor with the system browser.
    /// Terminals can't report Cmd in mouse events, so any left-click on a link
    /// opens it.
    fn open_link_at(&mut self, column: u16, row: u16) {
        let Some(region) = self.link_regions.iter().find(|region| {
            row == region.row && column >= region.col_start && column < region.col_end
        }) else {
            return;
        };
        let url = region.url.clone();
        match open_url(&url) {
            Ok(_) => self.add_status(format!("Opening {url}")),
            Err(error) => self.add_error(format!("Failed to open {url}: {error}")),
        }
    }

    /// Handle a key while the command menu is open. Returns true when the
    /// key was consumed; ↑/↓ with no candidates fall through so they keep
    /// recalling prompts / scrolling the transcript.
    fn handle_menu_key(&mut self, key: KeyEvent) -> bool {
        let menu_items = self.current_menu_items();
        let has_items = !menu_items.is_empty();

        match key.code {
            KeyCode::Up if has_items => {
                self.composer.move_menu(-1, menu_items.len());
                true
            }
            KeyCode::Down if has_items => {
                self.composer.move_menu(1, menu_items.len());
                true
            }
            KeyCode::Tab if has_items => {
                let index = self.composer.menu_index.min(menu_items.len() - 1);
                if let Some(item) = menu_items.get(index).cloned() {
                    if !self.try_open_command_group(&item) {
                        self.complete_into_composer(&item.value);
                    }
                }
                true
            }
            KeyCode::Enter if has_items => {
                let index = self.composer.menu_index.min(menu_items.len() - 1);
                if let Some(item) = menu_items.get(index).cloned() {
                    if self.try_open_command_group(&item) {
                        return true;
                    }
                    if item.value.ends_with(' ') {
                        // The command expects an argument — complete it so the
                        // candidate list opens instead of running it bare.
                        self.complete_into_composer(&item.value);
                        return true;
                    }
                    self.composer.clear();
                    self.submit(item.value.clone(), item.value);
                }
                true
            }
            // Don't submit the filter text as a chat message when no skills match.
            KeyCode::Enter if self.composer.open_group.is_some() => true,
            KeyCode::Esc => {
                if self.composer.open_group.is_some() {
                    self.composer.open_group = None;
                    self.composer.menu_index = 0;
                    // Return to the root command menu.
                    self.composer.textarea.set_text("/".into());
                    self.composer.textarea.move_end();
                    self.composer.on_text_changed();
                } else {
                    self.composer.clear();
                }
                true
            }
            _ => false,
        }
    }

    fn handle_key(&mut self, key: KeyEvent, transcript_area: Rect) {
        if matches!(key.code, KeyCode::Char('0'))
            && key
                .modifiers
                .intersects(KeyModifiers::SUPER | KeyModifiers::ALT)
        {
            if self.active_child.is_some() {
                self.client.send(ClientMessage::AgentBack);
            }
            return;
        }

        // Ctrl+C mirrors Esc: close the command menu, otherwise cancel the
        // running/queued turn (matching the universal "interrupt" expectation).
        if matches!(key.code, KeyCode::Char('c')) && key.modifiers.contains(KeyModifiers::CONTROL) {
            if self.composer.menu_open {
                self.composer.clear();
            } else {
                self.revert_last_send();
            }
            return;
        }

        // Ctrl+T toggles expanding long thinking blocks.
        if matches!(key.code, KeyCode::Char('t')) && key.modifiers.contains(KeyModifiers::CONTROL) {
            self.expand_thinking = !self.expand_thinking;
            return;
        }

        // While a panel is focused, route navigation keys to it; Tab returns
        // to the transcript. The composer is only editable again after
        // pressing Esc/Tab/Enter to drop focus.
        if !self.composer.menu_open && !self.input_history.is_browsing() {
            // While questions are pending, ←/→ switch the question being
            // answered (the Ask panel), just like Tab; ↑/↓ move the option
            // selection for the current question. With an open question the
            // user may be typing a free-form answer, so ←/→ stay available
            // for cursor movement there.
            if !self.pending_asks.is_empty()
                && matches!(
                    key.code,
                    KeyCode::Tab | KeyCode::Left | KeyCode::Right
                )
                && key.modifiers.is_empty()
                && (self.ask_has_options() || self.composer.textarea.text().is_empty())
            {
                if self.panel_focus != PanelFocus::Transcript {
                    self.reset_panel_scroll();
                }
                let delta = match key.code {
                    KeyCode::Left => -1,
                    _ => 1,
                };
                self.cycle_active_ask(delta);
                return;
            }
            if self.panel_focus != PanelFocus::Transcript {
                if self.handle_panel_key(key) {
                    return;
                }
            } else if matches!(key.code, KeyCode::Tab) && key.modifiers.is_empty() {
                self.cycle_panel_focus();
                return;
            }
        }

        // History browse owns ↑/↓/Enter so slash-looking recalls (e.g. `/resume …`)
        // never trap keys in the command menu.
        if self.input_history.is_browsing() {
            match key.code {
                KeyCode::Up | KeyCode::Down => {
                    self.handle_input_history_key(key.code, transcript_area);
                    return;
                }
                KeyCode::Enter if !key.modifiers.contains(KeyModifiers::SHIFT) => {
                    self.submit_composer();
                    return;
                }
                _ => {}
            }
        } else if matches!(key.code, KeyCode::Up | KeyCode::Down) && !self.composer.menu_open {
            // While the agent's question offers discrete options, ↑/↓ move the
            // highlighted option instead of recalling prompt history.
            if self.ask_has_options() {
                if let Some(ask) = self.pending_asks.get_mut(self.active_ask) {
                    let delta = if key.code == KeyCode::Up { -1 } else { 1 };
                    ask.move_selection(delta);
                }
                return;
            }
            self.handle_input_history_key(key.code, transcript_area);
            return;
        }

        if self.composer.menu_open && self.handle_menu_key(key) {
            return;
        }

        match key.code {
            KeyCode::Esc if !self.composer.menu_open => {
                // While an ask_user question awaits a reply, Esc skips just the
                // question (the agent continues) instead of aborting the turn.
                if !self.pending_asks.is_empty() {
                    self.skip_pending_ask();
                    return;
                }
                if self.revert_last_send() {
                    return;
                }
                if let Some(entry) = self.undo.pop() {
                    match entry {
                        UndoEntry::Local { line_index } => {
                            if line_index < self.static_lines.len() {
                                self.static_lines.remove(line_index);
                            }
                            self.composer.set_restore(String::new());
                        }
                        UndoEntry::Chat { user_index, text } => {
                            if user_index < self.static_lines.len() {
                                let restore = self.static_lines[user_index]
                                    .sent_content
                                    .clone()
                                    .unwrap_or_else(|| text.clone());
                                self.static_lines.remove(user_index);
                                self.composer.set_restore(restore);
                            } else {
                                self.composer.set_restore(text);
                            }
                        }
                    }
                }
            }
            KeyCode::Enter if key.modifiers.contains(KeyModifiers::SHIFT) => {
                self.leave_input_history_browse();
                self.composer.textarea.insert_str("\n");
                self.composer.on_text_changed();
            }
            KeyCode::Enter => {
                // With discrete ask_user options and an empty composer, Enter
                // picks the highlighted option instead of starting a chat turn.
                if self.ask_has_options() && self.composer.textarea.text().trim().is_empty() {
                    self.select_ask_option();
                } else {
                    self.submit_composer();
                }
            }
            // Cmd+Backspace deletes the whole logical line (macOS muscle memory).
            KeyCode::Backspace if key.modifiers.contains(KeyModifiers::SUPER) => {
                self.leave_input_history_browse();
                self.composer.delete_current_line();
            }
            // Option+Backspace deletes the previous word.
            KeyCode::Backspace if key.modifiers.contains(KeyModifiers::ALT) => {
                self.leave_input_history_browse();
                self.composer.delete_word_backward();
            }
            KeyCode::Backspace => {
                self.leave_input_history_browse();
                self.composer.delete_backward();
            }
            KeyCode::Delete if key.modifiers.contains(KeyModifiers::SUPER) => {
                self.leave_input_history_browse();
                self.composer.delete_current_line();
            }
            KeyCode::Delete if key.modifiers.contains(KeyModifiers::ALT) => {
                self.leave_input_history_browse();
                self.composer.delete_word_forward();
            }
            KeyCode::Delete => {
                self.leave_input_history_browse();
                self.composer.delete_forward();
            }
            KeyCode::Left if key.modifiers.contains(KeyModifiers::SUPER) => {
                self.composer.textarea.move_home();
            }
            KeyCode::Left if key.modifiers.contains(KeyModifiers::ALT) => {
                self.composer.move_word_left();
            }
            KeyCode::Left => self.composer.textarea.move_left(),
            KeyCode::Right if key.modifiers.contains(KeyModifiers::SUPER) => {
                self.composer.textarea.move_end();
            }
            KeyCode::Right if key.modifiers.contains(KeyModifiers::ALT) => {
                self.composer.move_word_right();
            }
            KeyCode::Right => self.composer.textarea.move_right(),
            KeyCode::Home => self.composer.textarea.move_home(),
            KeyCode::End => self.composer.textarea.move_end(),
            KeyCode::PageUp => {
                self.scroll_history(10, transcript_area);
            }
            KeyCode::PageDown => {
                self.scroll_history(-10, transcript_area);
            }
            KeyCode::Char(ch) if key.modifiers.contains(KeyModifiers::CONTROL) && ch == 'y' => {
                self.copy_last_reply();
            }
            // readline-style editing: Ctrl+A/E move to line start/end, Ctrl+K/U
            // kill to line end/start, Ctrl+W delete previous word, Ctrl+D delete forward.
            KeyCode::Char('a') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.leave_input_history_browse();
                self.composer.textarea.move_home();
            }
            KeyCode::Char('e') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.leave_input_history_browse();
                self.composer.textarea.move_end();
            }
            KeyCode::Char('k') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.leave_input_history_browse();
                self.composer.delete_to_line_end();
            }
            KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.leave_input_history_browse();
                self.composer.delete_to_line_start();
            }
            KeyCode::Char('w') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.leave_input_history_browse();
                self.composer.delete_word_backward();
            }
            KeyCode::Char('d') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.leave_input_history_browse();
                self.composer.delete_forward();
            }
            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::SUPER) => {
                self.copy_last_reply();
            }
            KeyCode::Char(ch)
                if !key
                    .modifiers
                    .intersects(KeyModifiers::CONTROL | KeyModifiers::SUPER) =>
            {
                self.leave_input_history_browse();
                self.composer.textarea.insert_str(&ch.to_string());
                self.composer.on_text_changed();
            }
            _ => {}
        }
    }

    fn submit_composer(&mut self) {
        let display = self.composer.textarea.text().trim().to_string();
        if display.is_empty() {
            return;
        }
        // Send exactly what was typed/pasted (untrimmed) so pasted content is
        // never replaced by a placeholder.
        let full = self.composer.textarea.text().to_string();
        self.composer.clear();
        self.submit(display, full);
    }

    fn handle_input_history_key(&mut self, code: KeyCode, transcript_area: Rect) {
        match code {
            KeyCode::Up => {
                let current = self.composer.textarea.text().to_string();
                if let Some(text) = self.input_history.up(&current) {
                    self.apply_input_history_text(text);
                } else if !self.input_history.is_browsing() {
                    self.scroll_history(1, transcript_area);
                }
            }
            KeyCode::Down => {
                if let Some(text) = self.input_history.down() {
                    self.apply_input_history_text(text);
                    // Restoring the live draft should reopen the slash menu if needed.
                    if !self.input_history.is_browsing() {
                        self.composer.on_text_changed();
                    }
                } else if !self.input_history.is_browsing() {
                    self.scroll_history(-1, transcript_area);
                }
            }
            _ => {}
        }
    }

    fn leave_input_history_browse(&mut self) {
        self.input_history.reset_browse();
    }

    /// If the selected item is a group header (e.g. "/skills"), open the
    /// group as a filterable picker instead of running it. Returns true when
    /// it was one.
    fn try_open_command_group(&mut self, item: &SlashCommand) -> bool {
        if self.composer.open_group.is_none() {
            let group = command_group_id(&item.value);
            if self
                .command_groups
                .iter()
                .any(|(name, _)| command_group_id(name) == group)
            {
                if group == "mcp" {
                    self.client.send(ClientMessage::Mcp);
                }
                self.enter_command_picker(group);
                return true;
            }
        }
        false
    }

    pub(super) fn enter_command_picker(&mut self, group: &str) {
        self.composer.open_group = Some(group.into());
        self.composer.menu_index = 0;
        self.composer.textarea.set_text(String::new());
        self.composer.menu_open = true;
    }

    pub(super) fn complete_into_composer(&mut self, value: &str) {
        self.composer.textarea.set_text(value.to_string());
        self.composer.textarea.move_end();
        self.composer.on_text_changed();
    }

    fn apply_input_history_text(&mut self, text: String) {
        self.composer.textarea.set_text(text);
        self.composer.textarea.move_end();
        // Keep the slash menu closed while browsing history so ↑/↓ don't get
        // trapped by `/resume …` / `/agent …` candidate lists.
        self.composer.menu_open = false;
        self.composer.menu_index = 0;
        self.composer.open_group = None;
    }

    /// Keys consumed while a panel is focused. Returns true when handled.
    fn handle_panel_key(&mut self, key: KeyEvent) -> bool {
        match key.code {
            KeyCode::Up => {
                self.scroll_focused_panel(-1);
                true
            }
            KeyCode::Down => {
                self.scroll_focused_panel(1);
                true
            }
            KeyCode::PageUp => {
                self.scroll_focused_panel(-5);
                true
            }
            KeyCode::PageDown => {
                self.scroll_focused_panel(5);
                true
            }
            KeyCode::Home => {
                self.scroll_focused_panel(-i16::MAX);
                true
            }
            KeyCode::End => {
                self.scroll_focused_panel(i16::MAX);
                true
            }
            KeyCode::Tab | KeyCode::Esc | KeyCode::Enter => {
                self.reset_panel_scroll();
                true
            }
            // Consume everything else so typing doesn't land in the composer
            // while a panel owns focus.
            _ => true,
        }
    }
}

/// Open a URL with the platform's default browser.
fn open_url(url: &str) -> std::io::Result<std::process::Child> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .spawn()
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(url).spawn()
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open").arg(url).spawn()
    }
}
