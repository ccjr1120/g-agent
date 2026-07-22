import {
  useCallback,
  useDeferredValue,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import type { DOMElement } from "ink";
import {
  buildOffsets,
  MessageHeightCache,
} from "../lib/heightCache.js";
import {
  computeVirtualRange,
  estimateTotalHeight,
  spacerHeights,
  type VirtualRange,
} from "../lib/virtualScroll.js";

export type UseVirtualScrollOptions = {
  itemIds: readonly string[];
  columns: number;
  viewportHeight: number;
  historyOffset: number;
  followBottom: boolean;
  liveRowHeight: number;
};

export type UseVirtualScrollResult = {
  range: VirtualRange;
  topSpacer: number;
  bottomSpacer: number;
  totalHeight: number;
  maxHistoryOffset: number;
  measureRef: (messageId: string) => (element: DOMElement | null) => void;
  measureLiveRef: (element: DOMElement | null) => void;
};

const heightCache = new MessageHeightCache();

export function useVirtualScroll({
  itemIds,
  columns,
  viewportHeight,
  historyOffset,
  followBottom,
  liveRowHeight,
}: UseVirtualScrollOptions): UseVirtualScrollResult {
  const itemRefs = useRef(new Map<string, DOMElement>());
  const measuredKeysRef = useRef(new Set<string>());
  const offsetVersionRef = useRef(0);
  const offsetsRef = useRef<{ arr: Float64Array; version: number; count: number }>({
    arr: new Float64Array(0),
    version: -1,
    count: -1,
  });
  const previousRangeRef = useRef<VirtualRange | null>(null);
  const previousHistoryOffsetRef = useRef(historyOffset);
  const previousColumnsRef = useRef(columns);
  const skipMeasurementRef = useRef(false);
  const freezeRendersRef = useRef(0);

  if (previousColumnsRef.current !== columns) {
    heightCache.scaleColumns(previousColumnsRef.current, columns);
    previousColumnsRef.current = columns;
    offsetVersionRef.current += 1;
    skipMeasurementRef.current = true;
    freezeRendersRef.current = 2;
  }

  useMemo(() => {
    heightCache.prune(new Set(itemIds));
    offsetVersionRef.current += 1;
  }, [itemIds]);

  const n = itemIds.length;
  if (
    offsetsRef.current.version !== offsetVersionRef.current ||
    offsetsRef.current.count !== n
  ) {
    offsetsRef.current = {
      arr: buildOffsets(itemIds, columns, heightCache),
      version: offsetVersionRef.current,
      count: n,
    };
  }
  const offsets = offsetsRef.current.arr;

  const scrollVelocity = Math.abs(historyOffset - previousHistoryOffsetRef.current);
  previousHistoryOffsetRef.current = historyOffset;

  const frozenRange = freezeRendersRef.current > 0 ? previousRangeRef.current : null;
  const immediateRange = frozenRange ?? computeVirtualRange({
    itemCount: n,
    offsets,
    viewportHeight,
    historyOffset,
    followBottom,
    columns,
    cache: heightCache,
    itemIds,
    measuredKeys: measuredKeysRef.current,
    previousRange: previousRangeRef.current,
    scrollVelocity,
  });

  const deferredStart = useDeferredValue(immediateRange[0]);
  const deferredEnd = useDeferredValue(immediateRange[1]);
  let start = immediateRange[0] < deferredStart ? deferredStart : immediateRange[0];
  let end = immediateRange[1] > deferredEnd ? deferredEnd : immediateRange[1];
  if (start > end || followBottom) {
    start = immediateRange[0];
    end = immediateRange[1];
  }

  if (freezeRendersRef.current > 0) {
    freezeRendersRef.current -= 1;
  } else {
    previousRangeRef.current = immediateRange;
  }

  const staticHeight = offsets[n] ?? 0;
  const totalHeight = staticHeight + liveRowHeight;
  const maxHistoryOffset = Math.max(0, totalHeight - viewportHeight);
  const { topSpacer, bottomSpacer } = spacerHeights(offsets, [start, end], staticHeight);

  const measureRef = useCallback((messageId: string) => {
    return (element: DOMElement | null) => {
      if (element) {
        itemRefs.current.set(messageId, element);
      } else {
        itemRefs.current.delete(messageId);
      }
    };
  }, []);

  const measureLiveRef = useCallback((element: DOMElement | null) => {
    if (element) {
      itemRefs.current.set("__live__", element);
    } else {
      itemRefs.current.delete("__live__");
    }
  }, []);

  useLayoutEffect(() => {
    if (skipMeasurementRef.current) {
      skipMeasurementRef.current = false;
      return;
    }

    let changed = false;
    for (const [messageId, element] of itemRefs.current) {
      if (messageId === "__live__") continue;
      const yoga = element.yogaNode;
      if (!yoga) continue;
      const height = Math.round(yoga.getComputedHeight());
      const previous = heightCache.get(messageId, columns);
      if (height > 0 && previous !== height) {
        heightCache.set(messageId, columns, height);
        measuredKeysRef.current.add(messageId);
        changed = true;
      }
    }

    if (changed) {
      offsetVersionRef.current += 1;
    }
  });

  return {
    range: [start, end],
    topSpacer,
    bottomSpacer,
    totalHeight: estimateTotalHeight(itemIds, columns, heightCache, liveRowHeight),
    maxHistoryOffset,
    measureRef,
    measureLiveRef,
  };
}

export { heightCache as messageHeightCache };
