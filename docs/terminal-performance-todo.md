# Terminal performance roadmap

This document records follow-up work after the first TUI performance pass.
The reference implementation is `/Users/ccjr/development/forks/cc-haha`,
especially its virtual message list, virtual-scroll hook, line-width cache,
dirty-node renderer, and terminal frame diff.

## Completed in the first pass

- Batch token deltas before updating React instead of rendering every token.
- Concatenate streamed text once per render batch instead of once per incoming
  WebSocket delta.
- Keep conversation export logs in a ref because they do not affect the UI.
- Memoize completed message rows and stable Markdown theme configuration.
- Slow the cosmetic spinner refresh rate to reduce unrelated terminal paints.

## P0: reproducible benchmark

- [ ] Add a fake WebSocket stream that can replay deterministic responses.
- [ ] Measure startup with 100, 500, and 1,000 messages.
- [ ] Measure a 5,000 and 20,000 token streamed response.
- [ ] Record CPU, RSS, event-loop P50/P95 delay, React commits per second,
      Markdown parses, `measureElement` calls, and stdout bytes.
- [ ] Add a long-session PageUp/PageDown and mouse-wheel benchmark.

Initial targets:

- Streaming event-loop P95 below 30 ms on a typical development machine.
- Stream render cost should remain approximately constant as history grows.
- A 500-message transcript should scroll without visible multi-frame stalls.

## P1: incremental layout and Markdown

- [ ] Cache completed message heights by `(message id, terminal columns)`.
- [ ] Measure only the live assistant row while streaming; derive transcript
      height from cached completed rows plus the live row.
- [ ] Invalidate or scale height estimates when terminal width changes.
- [ ] Split streaming Markdown into immutable completed blocks and one mutable
      tail block, so only the tail is parsed again.
- [ ] Use an adaptive stream interval: 32 ms for short output and 50-80 ms
      under sustained long output or event-loop pressure.
- [ ] Cap or externalize very large tool results retained for `/log`.

## P2: message virtualization

- [ ] Mount only the viewport plus 40-80 rows of overscan.
- [ ] Represent unmounted history with top and bottom spacer boxes.
- [ ] Render at most 30 recent items on cold start.
- [ ] Limit newly mounted messages per commit to avoid large synchronous
      Markdown/Yoga bursts during fast scrolling.
- [ ] Quantize scroll-driven React subscriptions while letting the terminal
      viewport move at full input resolution.
- [ ] Preserve bottom-follow and history anchoring as streamed rows grow.
- [ ] Add regression coverage for resize, resume, `/new`, undo, and scrolling
      while a response is streaming.

## P3: renderer-level work

Only start this after benchmarks show that application-level work is no
longer sufficient.

- [ ] Cache display width for immutable completed lines.
- [ ] Track dirty subtrees and skip painting unchanged nodes.
- [ ] Reuse unchanged areas from the previous screen buffer.
- [ ] Diff terminal cells and write only changed ranges.
- [ ] Merge adjacent cursor moves, style transitions, and no-op ANSI patches.
- [ ] Investigate hardware scroll-region instructions with compatibility and
      flicker fallbacks.

## Guardrails

- Keep session persistence and `/log` output behavior compatible.
- Do not make scroll position depend on stale pre-resize measurements.
- Benchmark before and after every optimization; do not merge complexity that
  lacks a measurable improvement.
- Prefer application-level changes over maintaining a full custom Ink fork.
