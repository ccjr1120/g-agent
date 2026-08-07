# TUI UI Specification — G-Agent

Terminal UI built on **TypeScript + SolidJS + OpenTUI** (`@opentui/solid`), run with `bun`. This
document drives UI structure, ordering, focus and keymapping. **README** describes repo
structure/behavior; this file describes the UI only. On conflicts, AGENTS.md wins.

## Layout

The single screen is a column box (`Root` in `src/app.tsx`):

```
┌────────────────────────────────────────────┐
│  Transcript   (scrollable message list)   │  ← messages + blocks (paddingX=1)
├────────────────────────────────────────────┤
│  Plan / Scheduled Tasks / Sub Agents      │  ← panels (as present)
├────────────────────────────────────────────┤
│  ● Connected · <model> · 0% ◯            │  ← status bar (fixed, padded)
│  > Type a message… (/ for commands)      │  ← composer (input, padded)
│  ? Question? · options · Chat other…     │  ← ask selection replaces input
└────────────────────────────────────────────┘
```

The transcript area carries horizontal padding (`paddingX={1}`) so messages never touch
the screen edges; the status bar and composer content are likewise left/right padded.

## State UI (may live outside the message list)

- **Status bar** (`src/routes/status-bar.tsx`): connection ●/label, active session/model,
  context usage percent + usage ring glyph. Not part of the transcript.
- **Panels** (`src/routes/panels.tsx`): Scheduled Tasks / Sub Agents — two-line entries
  (`/<n> <title>` + status/activity/duration). Plan panel is also a render-only box here.
  Pending `ask_user` questions no longer render a panel — they take over the composer (below).
- **Plan panel**: in-progress `update_plan` shows in a bordered box below the transcript with a
  completion count; when all steps are done it becomes a transcript message and the panel
  disappears. Max 5 visible steps; with more, center on the current step.
- **Composer completion menu**: when the input starts with `/`, matching slash-commands are
  listed above the input (static + dynamic: agents, skills, MCP servers, sub-agent slots,
  saved sessions); **↑/↓** to move, **Enter** to pick, **Tab** to complete, **Esc** to dismiss.
  Every menu (including sub-completions) ends with a **Chat other…** option that dismisses the
  menu and restores the input for typing a plain message instead of a command.
- **Exit**: `exit` / `/quit` / `/exit` — quit TUI in main session; close sub-session in sub.
- **Cancel**: **Ctrl+C** or **Esc** cancels the running/queued turn and restores the prompt;
  does not quit the app.
- **Expand**: **Ctrl+T** toggles expanded thinking / hidden tool calls.
- **History**: **↑/↓** recalls previous prompts; **PageUp/PageDown** scrolls the transcript.
- **Status bar** shows `◎ agent` and `◇ model` plus context usage ring.

## Transcript (must go into the message list)

Agent replies, slash-command results & hints, toggle/copy/export feedback, and user-facing
warnings/errors/statuses render as message lines **in occurrence order** — never sunk to the
bottom. Local feedback uses a role distinct from `user`/`assistant` so it is never sent to model
history, yet its render order matches normal messages.

## Display Order (Iron Rule)

`TurnSegment.segments` in `src/model.ts` is the single source of display order. Render order
always follows model output order: **thinking → text → tools → ask/reply**, as produced.
`ChatLine.text` is only the accumulated body for persistence and never drives ordering.
`lineToBlocks()` in `src/transcript.ts` is the pure expander and is the contract for the TUI —
anything that reorders blocks or tools is a regression.

Tool results match the **first** running tool with the same name (FIFO).

## Blank-Line Gaps

Gaps go between body blocks — including between consecutive body paragraphs. Different block
types are separated by blank lines; tool calls stay compact among themselves; thinking lines
stay compact among themselves. Each committed message line also ends with a trailing blank
line (user `> `, assistant `● ` on the first body line, thinking prefixed with `  `).
The renderer (`BlockRow` in `src/session.tsx`) inserts blank lines between block groups;
loading spinner gets a blank line after thinking/streaming content.

## Loading / Timers

- Running tools show an `mm:ss` timer and ✓/✗ state.
- The spinner (Thinking…/Working…/Waiting…) stays visible for the whole turn and only disappears
  at turn end.
- Collapse long thinking and >2 tool calls by default; `Ctrl+T` expands. The collapse hint sits
  on the last visible line.

## Theme

All colors/styles come from `src/theme/index.ts` tokens (`Theme` / `Style`). The dark palette
follows the original ratatui terminal scheme: **Cyan** brand, **Green** success, **Yellow**
warning/spinner, **Red** error, **DarkGray** muted/borders. **Background is not painted** — empty
areas inherit the terminal emulator theme (same as the old ratatui TUI). Semantic tokens (`t().brand`,
`t().thinking`, `t().toolCall`, …) are used, never hardcoded hex inside components.

## Bottom chrome

- **Composer** (`src/routes/composer.tsx`): top+bottom border only (no side box); `> ` prefix in
  brand color; slash-command menu is plain text above the input. Commands are dispatched via
  `src/commands/dispatch.ts` (covers `/help`, `/new`, `/reload`, `/log`, `/export`, `/scheduled …`,
  `/resume …`, `/<slot>`, `/mcp auth`, direct `/<skill>`, etc.). While a pending `ask_user` is
  active the composer becomes the answer UI — it **replaces the input area** and is restored when
  the ask is answered or skipped:
  - With options: the question and its options render in the composer with a **Chat other…**
    fallback as the last row. **↑/↓** pick, **Enter** confirms the highlighted option, **Esc**
    skips. Choosing **Chat other…** reveals an inline input (`> `) beside the options for typing
    a custom answer; **Enter** sends it, **Esc** returns to the option list.
  - Without options: the question renders with the inline input already active for a free-text
    answer.
  - Multiple pending questions: **Tab**/←/→ switches between them.
- **Status bar** (`src/routes/status-bar.tsx`): left- and right-padded single row — `● Connected`
  on the left, `◎ <agent> · ◇ <model> · <percent>%` and a usage ring glyph on the right.

## Queued messages

A user message submitted while a turn is in flight is marked queued and shown with a `⏳`
prefix; an idle submit is not queued. Queued lines drain FIFO: each `start` event dequeues the
oldest one (the server processes prompts in order). `cancel` drops every queued line because the
server clears its whole prompt queue. Restored/reconnected sessions rebuild in
thinking → text → tools order.

## Focus / Navigation

- `Tab` switches focus between panels; `Esc` returns to the input.
- Sub Agents sessions are entered with `/<number>`; each has its own transcript. Start directly
  in built-in `default`; it never appears in Sub Agents.

## Tests

Ordering/spacing logic must have unit tests (`src/transcript.test.ts`, `src/context/plan.test.ts`).
After any rendering change, run `bun test` in `apps/tui` and add regressions for order/gaps.