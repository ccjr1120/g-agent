# AGENTS.md — G-Agent Project Conventions

This is the **single hard set of conventions** for AI collaboration (and human maintainers). Read this file before touching TUI / agent logic. It merges the previous project habits with the development implementation rules; **on any conflict with earlier docs, the rules below take precedence.**

Goals: **small diffs, readable, testable, reversible** — never "improvise" blindly without understanding.

## 1. Iron Rule: Display Order = Model Output Order

- **Messages, thinking, tool calls and body text must render strictly in the order the model produced them.** Never cluster tools at the top, push body to the bottom, or reorder prompt types (user/queued/error/local/status).
- The server event stream (`packages/agent` → `apps/server` → `apps/tui`) is forwarded **without reordering**: `thinking_delta` / `delta` / `tool_call` / `tool_result` pass through in arrival order.
- In the TUI, the `TurnSegment.segments` vector is the **single source of display order**; `ChatLine.text` is only the accumulated body used for persistence and must not drive ordering.
- Tool results match the **first running tool with the same name (FIFO, first-come-first-served)**. Do not switch to matching the last one (`.rev()`), or parallel same-name tools will be cross-wired.
- Restored/reconnected sessions (`restored_segments`) rebuild in thinking → text → tools order. **Body text always precedes tools**; never let body fall back to rendering after tools.

## 2. Interaction Details (User-Visible)

- **Blank lines between body blocks**, including between consecutive body paragraphs (`push_block_gap` must insert a gap for Text→Text too). Different block types (thinking/tool/body/plan) are separated by blank lines; tool calls stay compact among themselves, thinking lines stay compact among themselves.
- Long thinking blocks and more than 2 tool calls are **collapsed by default**; `Ctrl+T` expands. The collapse hint follows on the last visible line, not on its own line.
- Running tools show an `mm:ss` timer and `✓/✗` state; the loading indicator (Thinking…/Working…) stays visible as long as any tool is running, and disappears only after the body actually starts streaming.
- Queued messages get a `⏳` prefix and render **after the live reply and before the next user message**. Errors/status/local feedback are inserted at their occurrence position, never sunk to the bottom.

## 3. State UI vs. Messages

Per `apps/tui/UI_SPEC.md`:

- **State UI** (may live outside the message list): Status Bar (connection/model/agent/context usage), Sub Agents task status/activity/duration/unread marks, input completion menu, scroll hint, waiting animation.
- **Must go into the Transcript**: agent replies, slash-command results & usage hints, toggle/copy/export/reload/reconnect feedback, and user-facing warnings, failures and errors — rendered in occurrence order.
- Local feedback uses a message role distinct from `user`/`assistant` (so it is never sent into model history), but its render order must match regular messages.

## 4. Sessions & Panels

- Start directly in the built-in `default` main session; it never appears in the Sub Agents area and cannot invoke other agents.
- `/agent <name>` candidates are flattened into the top-level slash-command menu (no secondary `/agent` menu).
- `/<number>` enters an existing subsession; each subsession keeps its own Transcript.
- The first user message of a subsession is sent verbatim as its fixed title (no other-agent rewriting).
- Sub Agents uses two lines per session: line 1 `/<number> <title>`, line 2 fixed as Agent / status / activity / duration. Titles truncate with `…` to fit width and must never squeeze or hide the status line.
- Plan (`update_plan`) steps must not mix into the Transcript as ordinary tool calls. The in-progress Plan lives in a bordered area below the Transcript showing completion count; when all steps finish it becomes a normal assistant message in the Transcript and the fixed panel disappears. Max 5 visible steps; with more, center on the current step.
- Panels: `Tab` switches focus between Scheduled Tasks / Sub Agents; `Esc` returns to the input area.

## 5. Language & UI Theme

- **Always English** for UI copy and documentation.
- Colors and semantic styles **must** come from the `src/ui/theme.rs` tokens (`palette::*` / `style::*`). **Never hardcode `Color::Cyan`** etc. inside components.
- When touching UI, update `apps/tui/UI_SPEC.md` first, then `theme.rs`, then migrate the components.

## 6. Repository Overview & Boundaries

**pnpm + cargo dual-stack monorepo.** Each directory has a fixed responsibility; do not cross boundaries:

| Directory | Stack | Responsibility | Runtime |
|---|---|---|---|
| `apps/tui/` | Rust (Ratatui + Crossterm) | Terminal UI | `cargo` |
| `apps/server/` | TypeScript (NodeNext/ESM) | Background server | `bun` |
| `packages/agent/` | TypeScript | Protocol, Agent logic, tools, skills | `bun` |
| `packages/config/` | TypeScript | Config loading/normalization | `bun` |
| `packages/shared/` | TypeScript | Shared types/constants | `bun` |
| `crates/markdown-ratatui/` | Rust | Markdown rendering (TUI) | `cargo` |
| `scripts/` | Bash/docs | Build & init scripts | **bash** |

- Business logic goes into `packages/*`, UI goes into `apps/tui`. Do not leak into unrelated directories.
- On the JS side always use `"type": "module"` + NodeNext, and **relative imports MUST carry the `.js` extension** (`import { x } from "./foo.js"`). Never write `.ts` or bare relative paths.
- On the Rust side use the workspace convention; put new code in the proper module (`mod` file) of the crate. **Never add new features into a single big `lib.rs` / `mod.rs`.**

## 7. Code Editing Rules

### 7.1 File Size (Hard Limit)

- **No single file exceeds 600 lines** (target ≤ 500). Exceeding means it is a "big file" and must be split into modules.
- Any new file that hits the limit is split immediately. When editing an **existing file over 600 lines**, put the change into a suitable submodule and split off the extracted lines rather than piling onto the old big file.
  - Known big files to split on touch: `apps/tui/src/ui/transcript.rs` (~1500 lines), `crates/markdown-ratatui/src/lib.rs` (~840 lines) — push changes into a submodule and carve out an independent module when feasible.
  - Functions should ideally be **≤ 60 lines**; otherwise extract named helpers, avoid running with one long deeply-nested chain.

### 7.2 Small-Change Discipline

- **Small and minimal** diffs are preferred. Change 3 lines when 3 lines do it; never rewrite a whole file.
- Limit changes to the scope of the request. **No unrelated refactors** unless adjacent in responsibility and clearly lower risk.
- Never delete code that merely "looks unused" without confirming there are no references.
- Naming must be semantic: `isValid` over `flag1`, `MAX_OUTPUT` over `30000` (following existing style such as `MAX_OUTPUT` / `BASH_TIMEOUT_MS` in `tools/index.ts`).

### 7.3 TypeScript Conventions

- `strict` must pass; avoid widening with `any`. If `any` is truly needed, first narrow via `unknown`.
- Always ESM + NodeNext: `import { x } from "./foo.js"`.
- Separate types from implementation: use `import type { ... }` for pure types.
- Centralize public exports: `packages/*/src/index.ts` is the public surface; implementations live in `src/<dir>/`; `index.ts` only re-exports.
- Define constants in one place with a name (`MAX_OUTPUT`, `BASH_TIMEOUT_MS` pattern). No magic numbers.

### 7.4 Rust Conventions

- Group `use` statements: std → third-party → crate-internal.
- Errors use `Result<T, anyhow::Error>` (TUI side already uses anyhow). Avoid bare `unwrap`/`expect` that crash.
- Colors & styles go through `theme.rs` tokens (see section 5).

### 7.5 Config & Conventions

- `config.json` field naming, defaults follow `config.example.json` and `packages/config/src/normalize.ts`. Adding a config field means: add field → normalize → document (README / AGENTS) → update example.
- Builtin agent source lives in `packages/agent/src/agents/builtin/<name>/`; **changing `builtin-skills` requires syncing the corresponding `system.md`** (see README "Modifying builtin agents").

## 8. Testing Gate

- TUI ordering/spacing logic **must have unit tests** (see existing cases in `apps/tui/src/ui/transcript.rs`, `events.rs`, `sessions.rs`). After any rendering change, run `cargo test` (`apps/tui`) and add regression tests for ordering/gaps.
- TS uses `bun test`; test files sit next to sources (`*.test.ts`) under `packages/*/src/**` or `apps/server/src/`.
- Any logic change **must have tests** (at least one happy path + one boundary/failure).
- After modifying, run:

  ```bash
  pnpm test:agent
  pnpm test:server
  cargo test -p g-agent-tui   # = pnpm test:tui
  pnpm test                   # all
  ```

## 9. Commit Convention

Follow the repo style — **emoji + conventional commit**. Format: `<emoji> <type>(<scope>): <message>`; `type` is one of `feat` / `fix` / `refactor` / `chore`; `scope` is optional.

- `✨ feat(...)` — new feature
- `🔧 fix(...)` — bug fix
- `♻️ refactor(...) / chore(...)` — refactor / maintenance

Example: `✨ feat(tui): optimize interaction — tool status/background notify/panel focus`.

> `git add` before `git commit`. **Only commit / push when the user explicitly asks.**

## 10. Engineering Constraints

- Sessions, scheduled tasks and sub-agents are **persisted to disk**; restored from disk after restart — no data loss allowed.
- Personal tooling: do not add extra security-verification burden, but **never record or commit secrets/keys**.

## 11. Prohibited Actions

- ❌ Mixing irrelevant refactors into the same change (noisy diff).
- ❌ Adding useless comments to "look professional"; keep comments minimal, let naming carry meaning.
- ❌ Introducing dependencies not declared in `package.json` / `Cargo.toml` (add dependencies only with consent).
- ❌ Editing UI with hardcoded colors without syncing `theme.rs` / `UI_SPEC.md`.
- ❌ Rewriting core protocol / message structures (`packages/agent/src/types.ts`, `protocol.rs`) without a design review.
- ❌ Committing tokens / secrets / personal data; never commit files covered by `.gitignore` (`memory.md`, `dist/`, `target/`, etc.).

## 12. Authority & Conflicts

- This file is the **single authoritative convention** for this repository. On conflicts with earlier docs, the rules above win.
- For semantic description differences: **README describes structure/behavior, UI_SPEC describes UI**. Cross-check README first.
- This is a **living** document. New relaxations need a concrete rationale; avoid loosening rules arbitrarily.