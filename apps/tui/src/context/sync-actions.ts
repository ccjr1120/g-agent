import type { DispatchAction } from "../commands/dispatch.js";
import type { ChatLine } from "../model.js";
import { newLineId } from "../model.js";
import type { SyncInternals } from "./sync-internals.js";

export function pushFeedbackLine(
  setLines: (fn: (prev: ChatLine[]) => ChatLine[]) => void,
  role: "local" | "status" | "error",
  text: string,
  slot?: number,
): void {
  setLines((prev) => [
    ...prev,
    {
      id: newLineId(),
      role,
      text,
      segments: [],
      pendingThinking: "",
      pendingText: "",
      queued: false,
      slot,
    },
  ]);
}

export function applyDispatchActions(store: SyncInternals, actions: DispatchAction[]): boolean {
  let shouldQuit = false;
  for (const action of actions) {
    switch (action.type) {
      case "noop":
        break;
      case "quit":
        shouldQuit = true;
        break;
      case "close_sub":
        store.send({ type: "agent_task_close", slot: action.slot });
        break;
      case "chat":
        store.submit(action.message);
        break;
      case "send":
        store.send(action.message);
        break;
      case "reset":
        store.reset();
        break;
      case "local":
        pushFeedbackLine(store.setLines, "local", action.text, store.activeSlot());
        break;
      case "status":
        pushFeedbackLine(store.setLines, "status", action.text, store.activeSlot());
        break;
      case "error":
        pushFeedbackLine(store.setLines, "error", action.text, store.activeSlot());
        break;
      case "complete":
        store.setPendingComplete(action.text);
        break;
      case "open_task":
        if (action.deferred) {
          store.setPendingOpen(action.slot);
        } else {
          store.send({ type: "agent_task", slot: action.slot });
        }
        break;
    }
  }
  return shouldQuit;
}
