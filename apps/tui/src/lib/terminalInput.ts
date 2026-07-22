import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const scrollEvents = new EventEmitter();

const CSI_ARROW_UP = "\x1b[A";
const CSI_ARROW_DOWN = "\x1b[B";
const SS3_ARROW_UP = "\x1bOA";
const SS3_ARROW_DOWN = "\x1bOB";

/** How long to wait before treating a lone arrow key as keyboard input. */
const WHEEL_BURST_IDLE_MS = 35;

export type ScrollWheelDirection = "up" | "down";

export function onScrollWheel(listener: (direction: ScrollWheelDirection) => void) {
  scrollEvents.on("wheel", listener);
  return () => {
    scrollEvents.off("wheel", listener);
  };
}

type ArrowDirection = ScrollWheelDirection;

function arrowSequence(direction: ArrowDirection): string {
  return direction === "up" ? CSI_ARROW_UP : CSI_ARROW_DOWN;
}

function matchArrow(chunk: string, index: number): { direction: ArrowDirection; length: number } | null {
  if (chunk.startsWith(CSI_ARROW_UP, index)) {
    return { direction: "up", length: CSI_ARROW_UP.length };
  }
  if (chunk.startsWith(CSI_ARROW_DOWN, index)) {
    return { direction: "down", length: CSI_ARROW_DOWN.length };
  }
  if (chunk.startsWith(SS3_ARROW_UP, index)) {
    return { direction: "up", length: SS3_ARROW_UP.length };
  }
  if (chunk.startsWith(SS3_ARROW_DOWN, index)) {
    return { direction: "down", length: SS3_ARROW_DOWN.length };
  }
  return null;
}

/**
 * Alternate scroll mode (DECSET 1007) turns wheel events into cursor-key
 * sequences. Bursts are treated as scroll; isolated arrows are forwarded to
 * Ink for transcript scrolling.
 */
export function createScrollAwareStdin(stdin: NodeJS.ReadStream): NodeJS.ReadStream {
  const filtered = new PassThrough() as PassThrough & NodeJS.ReadStream;

  Object.defineProperties(filtered, {
    isTTY: { get: () => stdin.isTTY },
    isRaw: { get: () => stdin.isRaw },
  });
  filtered.setRawMode = (mode: boolean) => {
    stdin.setRawMode?.(mode);
    return filtered;
  };
  filtered.ref = () => {
    stdin.ref?.();
    return filtered;
  };
  filtered.unref = () => {
    stdin.unref?.();
    return filtered;
  };

  let pendingDirection: ArrowDirection | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let wheelBurst = false;

  const clearPending = () => {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    pendingDirection = null;
    wheelBurst = false;
  };

  const flushPendingArrow = () => {
    if (!pendingDirection) {
      return;
    }
    filtered.write(arrowSequence(pendingDirection));
    clearPending();
  };

  const schedulePendingFlush = () => {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
    }
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      if (!wheelBurst) {
        flushPendingArrow();
      } else {
        clearPending();
      }
    }, WHEEL_BURST_IDLE_MS);
  };

  const handleArrow = (direction: ArrowDirection) => {
    if (wheelBurst) {
      scrollEvents.emit("wheel", direction);
      schedulePendingFlush();
      return;
    }

    if (pendingDirection === direction) {
      wheelBurst = true;
      scrollEvents.emit("wheel", direction);
      schedulePendingFlush();
      return;
    }

    flushPendingArrow();
    pendingDirection = direction;
    schedulePendingFlush();
  };

  stdin.on("data", (chunk: Buffer | string) => {
    const input = chunk.toString();
    let cursor = 0;
    let output = "";

    while (cursor < input.length) {
      const arrow = matchArrow(input, cursor);
      if (arrow) {
        if (output) {
          filtered.write(output);
          output = "";
        }
        handleArrow(arrow.direction);
        cursor += arrow.length;
        continue;
      }

      output += input[cursor]!;
      cursor += 1;
    }

    if (output) {
      filtered.write(output);
    }
  });

  return filtered;
}
