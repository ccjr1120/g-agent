import type { CollapsedBlock } from "./collapse.js";
import type { DisplayBlock } from "./transcript.js";

export const ASSISTANT_BULLET = "● ";
export const ASSISTANT_CONTINUATION = "  ";
export const THINKING_PREFIX = "  ";

export type AnnotatedBlock = {
  block: CollapsedBlock;
  isFirstInLine: boolean;
  showAssistantBullet: boolean;
};

/** Annotate collapsed blocks for rendering (assistant bullet, gaps). */
export function annotateBlocks(blocks: CollapsedBlock[]): AnnotatedBlock[] {
  let seenText = false;
  return blocks.map((block, index) => {
    const showAssistantBullet = block.kind === "text" && !seenText;
    if (block.kind === "text") seenText = true;
    return { block, isFirstInLine: index === 0, showAssistantBullet };
  });
}

export function blockKind(block: DisplayBlock | CollapsedBlock): string {
  return block.kind;
}

/** Different block kinds (and consecutive body texts) need a blank line between them. */
export function needsGapBefore(prev: DisplayBlock | CollapsedBlock | null, next: DisplayBlock | CollapsedBlock): boolean {
  if (!prev) return false;
  if (prev.kind !== next.kind) return true;
  if (prev.kind === "text" && next.kind === "text") return true;
  return false;
}

export function streamingHasBody(
  segments: unknown[],
  pendingText: string,
  pendingThinking: string,
): boolean {
  return segments.length > 0 || pendingText.trim().length > 0 || pendingThinking.trim().length > 0;
}

export function gapsBeforeBlocks(blocks: CollapsedBlock[]): boolean[] {
  const gaps: boolean[] = [];
  let prev: CollapsedBlock | null = null;
  for (const block of blocks) {
    gaps.push(needsGapBefore(prev, block));
    prev = block;
  }
  return gaps;
}

/** A visible blank transcript row (empty `<box height={1} />` does not render in OpenTUI). */
export function blankLineContent(): string {
  return " ";
}
