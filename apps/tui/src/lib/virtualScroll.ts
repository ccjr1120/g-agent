import type { MessageHeightCache } from "./heightCache.js";
import { DEFAULT_ROW_ESTIMATE } from "./heightCache.js";

export const OVERSCAN_ROWS = 60;
export const SCROLL_QUANTUM = OVERSCAN_ROWS >> 1;
export const COLD_START_COUNT = 30;
export const PESSIMISTIC_HEIGHT = 1;
export const MAX_MOUNTED_ITEMS = 300;
export const SLIDE_STEP = 25;

export type VirtualRange = readonly [number, number];

export function computeVirtualRange(options: {
  itemCount: number;
  offsets: ArrayLike<number>;
  viewportHeight: number;
  historyOffset: number;
  followBottom: boolean;
  columns: number;
  cache: MessageHeightCache;
  itemIds: readonly string[];
  measuredKeys: ReadonlySet<string>;
  previousRange: VirtualRange | null;
  scrollVelocity: number;
}): VirtualRange {
  const {
    itemCount,
    offsets,
    viewportHeight,
    historyOffset,
    followBottom,
    columns,
    cache,
    itemIds,
    measuredKeys,
    previousRange,
    scrollVelocity,
  } = options;

  const totalHeight = offsets[itemCount] ?? 0;
  const maxHistoryOffset = Math.max(0, totalHeight - viewportHeight);
  const clampedHistoryOffset = Math.max(0, Math.min(maxHistoryOffset, historyOffset));
  const scrollTop = Math.max(0, totalHeight - viewportHeight - clampedHistoryOffset);

  let start: number;
  let end: number;

  if (viewportHeight <= 0 || itemCount === 0) {
    start = Math.max(0, itemCount - COLD_START_COUNT);
    end = itemCount;
  } else if (followBottom) {
    const budget = viewportHeight + OVERSCAN_ROWS;
    start = itemCount;
    while (start > 0 && totalHeight - (offsets[start - 1] ?? 0) < budget) {
      start -= 1;
    }
    end = itemCount;
  } else {
    const lo = scrollTop - OVERSCAN_ROWS;
    start = binarySearchStart(offsets, lo, itemCount);
    start = guardUnmeasuredStart(start, previousRange, measuredKeys, itemIds);

    const needed = viewportHeight + 2 * OVERSCAN_ROWS;
    const maxEnd = Math.min(itemCount, start + MAX_MOUNTED_ITEMS);
    let coverage = 0;
    end = start;
    const targetBottom = scrollTop + viewportHeight + OVERSCAN_ROWS;
    while (
      end < maxEnd &&
      (coverage < needed || (offsets[end] ?? 0) < targetBottom)
    ) {
      coverage += cache.get(itemIds[end]!, columns) ?? PESSIMISTIC_HEIGHT;
      end += 1;
    }

    const minStart = Math.max(0, end - MAX_MOUNTED_ITEMS);
    coverage = 0;
    for (let index = start; index < end; index += 1) {
      coverage += cache.get(itemIds[index]!, columns) ?? PESSIMISTIC_HEIGHT;
    }
    while (start > minStart && coverage < needed) {
      start -= 1;
      coverage += cache.get(itemIds[start]!, columns) ?? PESSIMISTIC_HEIGHT;
    }
  }

  if (previousRange && scrollVelocity > viewportHeight * 2) {
    const [prevStart, prevEnd] = previousRange;
    if (start < prevStart - SLIDE_STEP) start = prevStart - SLIDE_STEP;
    if (end > prevEnd + SLIDE_STEP) end = prevEnd + SLIDE_STEP;
    if (start > end) end = Math.min(start + SLIDE_STEP, itemCount);
  }

  start = Math.max(0, Math.min(start, itemCount));
  end = Math.max(start, Math.min(end, itemCount));
  if (end - start > MAX_MOUNTED_ITEMS) {
    end = start + MAX_MOUNTED_ITEMS;
  }

  return [start, end];
}

function binarySearchStart(offsets: ArrayLike<number>, lo: number, itemCount: number): number {
  let left = 0;
  let right = itemCount;
  while (left < right) {
    const mid = (left + right) >> 1;
    if ((offsets[mid + 1] ?? 0) <= lo) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }
  return left;
}

function guardUnmeasuredStart(
  start: number,
  previousRange: VirtualRange | null,
  measuredKeys: ReadonlySet<string>,
  itemIds: readonly string[],
): number {
  if (!previousRange) return start;
  const [prevStart, prevEnd] = previousRange;
  if (prevStart >= start) return start;

  for (let index = prevStart; index < Math.min(start, prevEnd); index += 1) {
    const id = itemIds[index];
    if (id && !measuredKeys.has(id)) {
      return index;
    }
  }
  return start;
}

export function quantizeScrollDelta(delta: number): number {
  if (delta === 0 || Math.abs(delta) <= SCROLL_QUANTUM) {
    return delta;
  }
  const sign = Math.sign(delta);
  const magnitude = Math.round(Math.abs(delta) / SCROLL_QUANTUM) * SCROLL_QUANTUM;
  return sign * Math.max(SCROLL_QUANTUM, magnitude);
}

export function estimateTotalHeight(
  itemIds: readonly string[],
  columns: number,
  cache: MessageHeightCache,
  liveHeight: number,
): number {
  let total = liveHeight;
  for (const id of itemIds) {
    total += cache.get(id, columns) ?? DEFAULT_ROW_ESTIMATE;
  }
  return total;
}

export function spacerHeights(
  offsets: ArrayLike<number>,
  range: VirtualRange,
  totalHeight: number,
): { topSpacer: number; bottomSpacer: number } {
  const [start, end] = range;
  const topSpacer = offsets[start] ?? 0;
  const bottomSpacer = Math.max(0, totalHeight - (offsets[end] ?? totalHeight));
  return { topSpacer, bottomSpacer };
}
