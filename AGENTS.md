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
- Running tools show an `mm:ss` timer and `✓/✗` state; the loading indicator (Thinking…/Working…) stays visible for the whole turn — while the model reasons, runs tools, or pauses between bursts of streamed output — and disappears only when the turn finishes, so the screen never looks frozen mid-turn.
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
- Colors and semantic styles **must** come from the `apps/tui/src/theme/index.ts` tokens (`Style` / `Theme`). **Never hardcode hex colors** inside components.
- When touching UI, update `apps/tui/UI_SPEC.md` first, then `theme/index.ts`, then migrate the components.

## 6. Repository Overview & Boundaries

**pnpm + bun monorepo.** Each directory has a fixed responsibility; do not cross boundaries:

| Directory | Stack | Responsibility | Runtime |
|---|---|---|---|
| `apps/tui/` | TypeScript (SolidJS + OpenTUI) | Terminal UI | `bun` |
| `apps/server/` | TypeScript (NodeNext/ESM) | Background server | `bun` |
| `packages/agent/` | TypeScript | Protocol, Agent logic, tools, skills | `bun` |
| `packages/config/` | TypeScript | Config loading/normalization | `bun` |
| `packages/shared/` | TypeScript | Shared types/constants | `bun` |
| `scripts/` | Bash/docs | Build & init scripts | **bash** |

- Business logic goes into `packages/*`, UI goes into `apps/tui`. Do not leak into unrelated directories.

## 7. Code Editing Rules

### 7.1 File Size (Hard Limit)

- **No single file exceeds 600 lines** (target ≤ 500). Exceeding means it is a "big file" and must be split into modules.
- Any new file that hits the limit is split immediately. When editing an **existing file over 600 lines**, put the change into a suitable submodule and split off the extracted lines rather than piling onto the old big file.
  - Functions should ideally be **≤ 60 lines**; otherwise extract named helpers, avoid running with one long deeply-nested chain.

### 7.2 Small-Change Discipline

- **Small and minimal** diffs are preferred. Change 3 lines when 3 lines do it; never rewrite a whole file.
- Limit changes to the scope of the request. **No unrelated refactors** unless adjacent in responsibility and clearly lower risk.
- Never delete code that merely "looks unused" without confirming there are no references.
- Naming must be semantic: `isValid` over `flag1`, `MAX_OUTPUT` over `30000` (following existing style such as `MAX_OUTPUT` / `BASH_TIMEOUT_MS` in `tools/index.ts`).
- **Write code only.** Finish the requested code/doc changes and stop. **Do not proactively run** tests, builds, typecheck, dev servers, or any `pnpm` / `bun` / `scripts/` command — unless the user explicitly asks (e.g. "run tests", "verify the build").

### 7.3 TypeScript Conventions

- `strict` must pass; avoid widening with `any`. If `any` is truly needed, first narrow via `unknown`.
- Always ESM + NodeNext: `import { x } from "./foo.js"`.
- Separate types from implementation: use `import type { ... }` for pure types.
- Centralize public exports: `packages/*/src/index.ts` is the public surface; implementations live in `src/<dir>/`; `index.ts` only re-exports.
- Define constants in one place with a name (`MAX_OUTPUT`, `BASH_TIMEOUT_MS` pattern). No magic numbers.

### 7.5 Config & Conventions

- `config.json` field naming, defaults follow `config.example.json` and `packages/config/src/normalize.ts`. Adding a config field means: add field → normalize → document (README / AGENTS) → update example.
- Builtin agent source lives in `packages/agent/src/agents/builtin/<name>/`; **changing `builtin-skills` requires syncing the corresponding `system.md`** (see README "Modifying builtin agents").

## 8. Testing Gate

- TUI ordering/spacing logic **must have unit tests** (see existing cases in `apps/tui/src/transcript.test.ts`, `apps/tui/src/context/plan.test.ts`). Add regression tests for ordering/gaps when changing rendering logic.
- TS uses `bun test`; test files sit next to sources (`*.test.ts`) under `packages/*/src/**` or `apps/server/src/`.
- Any logic change **should include tests** when appropriate (at least one happy path + one boundary/failure). **Writing** tests is in scope; **running** them is not — see §7.2.
- Verification commands (`pnpm test`, `pnpm test:tui`, `typecheck`, etc.) are for the user or CI to run when they choose; agents do not run them unless explicitly asked.

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
- ❌ Introducing dependencies not declared in `package.json` (add dependencies only with consent).
- ❌ Editing UI with hardcoded colors without syncing `theme/index.ts` / `UI_SPEC.md`.
- ❌ Rewriting core protocol / message structures (`packages/agent/src/types.ts`, `packages/shared/src/index.ts`) without a design review.
- ❌ Committing tokens / secrets / personal data; never commit files covered by `.gitignore` (`memory.md`, `dist/`, `target/`, etc.).
- ❌ Proactively running tests, builds, typecheck, or dev/install scripts after code changes (see §7.2).

## 12. Authority & Conflicts

- This file is the **single authoritative convention** for this repository. On conflicts with earlier docs, the rules above win.
- For semantic description differences: **README describes structure/behavior, UI_SPEC describes UI**. Cross-check README first.
- This is a **living** document. New relaxations need a concrete rationale; avoid loosening rules arbitrarily.