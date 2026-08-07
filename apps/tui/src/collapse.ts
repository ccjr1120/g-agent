import type { DisplayBlock } from "./transcript.js";

export const THINKING_COLLAPSE_LINES = 8;
export const THINKING_COLLAPSE_SHOWN = 4;
export const TOOL_COLLAPSE_VISIBLE = 2;

export type CollapsedBlock = DisplayBlock & {
  collapseHint?: string;
  hiddenLines?: number;
};

/** Apply thinking/tool collapse rules to ordered display blocks. */
export function applyCollapse(blocks: DisplayBlock[], expand: boolean): CollapsedBlock[] {
  if (expand) return blocks.map((b) => ({ ...b }));

  const toolIndices = blocks
    .map((b, i) => (b.kind === "tool" ? i : -1))
    .filter((i) => i >= 0);
  const hiddenTools = Math.max(0, toolIndices.length - TOOL_COLLAPSE_VISIBLE);
  const visibleToolStart = hiddenTools > 0 ? toolIndices[hiddenTools] : -1;

  const out: CollapsedBlock[] = [];
  let toolHintRendered = false;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.kind === "tool" && hiddenTools > 0 && i < visibleToolStart) continue;

    if (block.kind === "thinking") {
      out.push(...collapseThinking(block));
      continue;
    }

    if (block.kind === "tool" && hiddenTools > 0 && !toolHintRendered && i === visibleToolStart) {
      toolHintRendered = true;
      out.push({
        ...block,
        collapseHint: `${hiddenTools} earlier tool call${hiddenTools === 1 ? "" : "s"} hidden · Ctrl+T`,
      });
      continue;
    }

    out.push({ ...block });
  }
  return out;
}

function collapseThinking(block: Extract<DisplayBlock, { kind: "thinking" }>): CollapsedBlock[] {
  const lines = block.text.split("\n");
  const hidden = Math.max(0, lines.length - THINKING_COLLAPSE_LINES);
  if (hidden === 0) return [{ ...block }];

  const shown = Math.min(THINKING_COLLAPSE_SHOWN, lines.length);
  const visible = lines.slice(0, shown).join("\n");
  const noun = hidden === 1 ? "line" : "lines";
  return [
    {
      kind: "thinking",
      text: visible,
      collapseHint: `${hidden} more ${noun} · Ctrl+T`,
      hiddenLines: hidden,
    },
  ];
}

export function collapsedToolCount(toolCount: number, expand: boolean): number {
  if (expand) return 0;
  return Math.max(0, toolCount - TOOL_COLLAPSE_VISIBLE);
}
