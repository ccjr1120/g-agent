import React, { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Box, measureElement, type DOMElement } from "ink";
import type { ChatLine } from "../hooks/useAgentSocket.js";
import { useVirtualScroll } from "../hooks/useVirtualScroll.js";
import { MessageLine } from "./MessageLine.js";

type VirtualTranscriptProps = {
  staticLines: ChatLine[];
  liveTurnContent: ReactNode;
  columns: number;
  historyOffset: number;
  onLayout: (layout: {
    totalHeight: number;
    viewportHeight: number;
    maxHistoryOffset: number;
    growth: number;
  }) => void;
  viewportRef: React.RefObject<DOMElement | null>;
};

export function VirtualTranscript({
  staticLines,
  liveTurnContent,
  columns,
  historyOffset,
  onLayout,
  viewportRef,
}: VirtualTranscriptProps) {
  const [viewportHeight, setViewportHeight] = useState(0);
  const [liveRowHeight, setLiveRowHeight] = useState(0);
  const liveRowRef = useRef<DOMElement | null>(null);
  const previousTotalHeightRef = useRef(0);
  const itemIds = staticLines.map((line) => line.id);
  const followBottom = historyOffset === 0;

  const {
    range: [start, end],
    topSpacer,
    bottomSpacer,
    totalHeight,
    maxHistoryOffset,
    measureRef,
    measureLiveRef,
  } = useVirtualScroll({
    itemIds,
    columns,
    viewportHeight,
    historyOffset,
    followBottom,
    liveRowHeight,
  });

  useLayoutEffect(() => {
    if (!viewportRef.current) return;
    const nextViewportHeight = measureElement(viewportRef.current).height;
    setViewportHeight(nextViewportHeight);

    const nextLiveHeight = liveRowRef.current
      ? measureElement(liveRowRef.current).height
      : 0;
    setLiveRowHeight(nextLiveHeight);

    const growth = Math.max(0, totalHeight - previousTotalHeightRef.current);
    previousTotalHeightRef.current = totalHeight;
    onLayout({
      totalHeight,
      viewportHeight: nextViewportHeight,
      maxHistoryOffset,
      growth,
    });
  }, [
    staticLines,
    liveTurnContent,
    columns,
    historyOffset,
    totalHeight,
    maxHistoryOffset,
    onLayout,
    viewportRef,
  ]);

  const top = Math.min(0, viewportHeight - totalHeight) + historyOffset;

  return (
    <Box
      position="absolute"
      top={top}
      width="100%"
      flexDirection="column"
    >
      {topSpacer > 0 ? <Box height={topSpacer} flexShrink={0} /> : null}
      {staticLines.slice(start, end).map((line) => (
        <Box key={line.id} ref={measureRef(line.id)} flexShrink={0}>
          <MessageLine line={line} />
        </Box>
      ))}
      {bottomSpacer > 0 ? <Box height={bottomSpacer} flexShrink={0} /> : null}
      <Box
        ref={(element) => {
          liveRowRef.current = element;
          measureLiveRef(element);
        }}
        flexShrink={0}
      >
        {liveTurnContent}
      </Box>
    </Box>
  );
}
