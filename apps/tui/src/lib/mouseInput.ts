import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const mouseEvents = new EventEmitter();
const SGR_MOUSE_REPORT = /\x1b\[<(\d+);\d+;\d+[mM]/g;

export type MouseWheelDirection = "up" | "down";

export function onMouseWheel(listener: (direction: MouseWheelDirection) => void) {
  mouseEvents.on("wheel", listener);
  return () => {
    mouseEvents.off("wheel", listener);
  };
}

/**
 * Ink treats unknown escape sequences as keyboard input. Filter terminal mouse
 * reports before they reach Ink, while forwarding every real keyboard byte.
 */
export function createMouseFilteredStdin(stdin: NodeJS.ReadStream): NodeJS.ReadStream {
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

  stdin.on("data", (chunk: Buffer | string) => {
    const keyboardInput = chunk.toString().replace(
      SGR_MOUSE_REPORT,
      (_report, button: string) => {
        const buttonCode = Number(button);
        if (buttonCode === 64) mouseEvents.emit("wheel", "up");
        if (buttonCode === 65) mouseEvents.emit("wheel", "down");
        return "";
      },
    );

    if (keyboardInput) filtered.write(keyboardInput);
  });

  return filtered;
}
