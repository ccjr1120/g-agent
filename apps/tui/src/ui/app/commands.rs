use super::model::filter_argument_items;
use super::*;

impl App {
    pub(super) fn rebuild_commands(&mut self) {
        self.commands = vec![
            SlashCommand {
                value: "/skills".into(),
                description: "Select and run a skill".into(),
            },
            SlashCommand {
                value: "/back".into(),
                description: "Return to the main session (⌘0 / Alt+0 / /0)".into(),
            },
            SlashCommand {
                value: "/resume".into(),
                description: "Select and resume a saved session".into(),
            },
            SlashCommand {
                value: "/mcp".into(),
                description: "Select an MCP server and view its tools".into(),
            },
            SlashCommand {
                value: "/tasks".into(),
                description: "Show background agent tasks".into(),
            },
            SlashCommand {
                value: "/scheduled".into(),
                description: "Show recurring scheduled tasks".into(),
            },
            SlashCommand {
                value: "/new".into(),
                description: "Start a new conversation".into(),
            },
            SlashCommand {
                value: "/reload".into(),
                description: "Hot-reload config, agents and skills".into(),
            },
            SlashCommand {
                value: "/log".into(),
                description: "Export the full conversation log".into(),
            },
            SlashCommand {
                value: "/help".into(),
                description: "Show commands and keyboard shortcuts".into(),
            },
            SlashCommand {
                value: "/quit".into(),
                description: "Exit g-agent".into(),
            },
        ];

        self.commands
            .extend(self.agent_tasks.iter().map(|task| SlashCommand {
                value: format!("/{}", task.slot),
                description: task.title.split_whitespace().collect::<Vec<_>>().join(" "),
            }));

        let skill_commands = self
            .skills
            .iter()
            .map(|skill| SlashCommand {
                value: format!("/{}", skill.name),
                description: skill.description.clone(),
            })
            .collect::<Vec<_>>();

        let agent_commands = self
            .agents
            .iter()
            .filter(|agent| agent.name != "default")
            .map(|agent| SlashCommand {
                value: format!("/agent {} ", agent.name),
                description: format!("run in background · add a message · {}", agent.description),
            })
            .collect::<Vec<_>>();
        self.commands.extend(agent_commands.iter().cloned());

        let resume_commands = self
            .saved_sessions
            .iter()
            .filter(|session| session.agent == self.active_agent)
            .map(|session| SlashCommand {
                value: format!("/resume {}", session.id),
                description: format!(
                    "{} · {} · {} msgs",
                    session.preview,
                    format_session_age(session.updated_at),
                    session.turn_count
                ),
            })
            .collect::<Vec<_>>();

        let mcp_commands = self
            .mcp_servers
            .iter()
            .map(|server| {
                let needs_auth = server.auth_required;
                SlashCommand {
                    value: if needs_auth {
                        format!("/mcp auth {}", server.name)
                    } else {
                        format!("/mcp {}", server.name)
                    },
                    description: if server.connected {
                        format!("connected · {} tools", server.tool_count)
                    } else if server.auth_required {
                        "auth required".into()
                    } else {
                        server
                            .error
                            .clone()
                            .unwrap_or_else(|| "not connected".into())
                    },
                }
            })
            .collect::<Vec<_>>();

        self.menu_groups_raw = vec![
            ("skills".to_string(), skill_commands.clone()),
            ("resume".to_string(), resume_commands.clone()),
            ("mcp".to_string(), mcp_commands.clone()),
        ];
        self.command_groups = vec![
            ("skills".to_string(), skill_commands),
            ("resume".to_string(), resume_commands),
            ("mcp".to_string(), mcp_commands),
        ];
    }

    pub(super) fn current_menu_items(&self) -> Vec<SlashCommand> {
        if !self.composer.menu_open {
            return Vec::new();
        }

        let groups = self
            .menu_groups_raw
            .iter()
            .map(|(name, items)| (name.as_str(), items.as_slice()))
            .collect::<Vec<_>>();

        // Skill (or other group) picker: filter children by whatever is typed.
        if self.composer.open_group.is_some() {
            return self
                .composer
                .menu_items(&self.commands, &groups)
                .into_iter()
                .cloned()
                .collect();
        }

        let text = self.composer.textarea.text().to_string();

        if let Some(partial) = text.strip_prefix("/agent ") {
            return filter_argument_items(
                self.agents
                    .iter()
                    .filter(|agent| agent.name != "default")
                    .map(|agent| SlashCommand {
                        value: format!("/agent {} ", agent.name),
                        description: format!("add a message · {}", agent.description),
                    }),
                partial,
            );
        }
        if let Some(partial) = text.strip_prefix("/mcp auth ") {
            return filter_argument_items(
                self.mcp_servers.iter().map(|server| SlashCommand {
                    value: format!("/mcp auth {}", server.name),
                    description: if server.connected {
                        "connected".into()
                    } else if server.auth_required {
                        "auth required".into()
                    } else {
                        "not connected".into()
                    },
                }),
                partial,
            );
        }
        if let Some(partial) = text.strip_prefix("/resume ") {
            return filter_argument_items(
                self.saved_sessions
                    .iter()
                    .filter(|session| session.agent == self.active_agent)
                    .map(|session| SlashCommand {
                        value: format!("/resume {}", session.id),
                        description: format!(
                            "{} · {} · {} msgs",
                            session.preview,
                            format_session_age(session.updated_at),
                            session.turn_count
                        ),
                    }),
                partial,
            );
        }
        if text.contains(' ') {
            return Vec::new();
        }

        self.composer
            .menu_items(&self.commands, &groups)
            .into_iter()
            .cloned()
            .collect()
    }

    pub(super) fn format_help(&self) -> String {
        let mut out = String::from("Commands:\n");
        for command in &self.commands {
            out.push_str(&format!(
                "  {:<12} {}\n",
                command.value.trim_end(),
                command.description
            ));
        }
        out.push_str(&format!(
            "  /<skill>     Run a skill directly ({} loaded)\n",
            self.skills.len()
        ));
        out.push_str("  /scheduled cancel <number|id>  Cancel a scheduled task\n");
        out.push_str("  /scheduled run <number|id>  Run a scheduled task now\n");
        out.push_str("  /scheduled history <number|id>  Show past runs of a scheduled task\n");
        out.push_str(concat!(
            "\nKeys:\n",
            "  Enter send · Shift+Enter newline · Tab complete command\n",
            "  ↑/↓ recall previous prompts (shared across agents) · menu when open\n",
            "  Cmd+←/→ or Ctrl+A/E jump to line start/end\n",
            "  Option+←/→ or Ctrl+W delete/move by word\n",
            "  Cmd+Delete deletes the whole line\n",
            "  Ctrl+K/U delete to line end/start · Ctrl+D delete forward\n",
            "  PageUp/PageDown scroll conversation\n",
            "  Ctrl+C cancel the running/queued turn · Esc undo last send / cancel\n",
            "  Ctrl+T expand or collapse long thinking blocks\n",
            "  Tab cycles focus through Scheduled Tasks / Sub Agents panels (↑↓/PgUp/PgDn scroll, Esc returns)\n",
            "  While an Ask question is pending: ←/→ switch · ↑/↓ pick option · Enter answer · Esc skip\n",
            "  Click a link in the transcript to open it in the browser\n",
            "  Cmd+0 or Alt+0 return to the main agent\n",
            "  Ctrl+Y or Cmd+C copy last reply\n",
        ));
        out
    }
}
