import type { ClientMessage } from "@g-agent/shared";
import type { ChatLine } from "../model.js";
import type { DispatchAction } from "../commands/dispatch.js";

export type SyncInternals = {
  activeSlot: () => number | undefined;
  send: (message: ClientMessage) => void;
  submit: (text: string) => void;
  reset: () => void;
  setLines: (fn: (prev: ChatLine[]) => ChatLine[]) => void;
  setPendingComplete: (text: string) => void;
  setPendingOpen: (slot: number | undefined) => void;
};

export type { DispatchAction };
