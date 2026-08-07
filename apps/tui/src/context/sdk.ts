import {
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
} from "@g-agent/shared";

type Handler = (event: ServerMessage) => void;

/** RECONNECT backoff (ms). */
const RECONNECT_BASE_MS = 300;
const RECONNECT_MAX_MS = 5000;

/**
 * Low-level WebSocket client over the g-agent protocol. Emits parsed
 * `ServerMessage`s through a batched emitter so a burst of streaming tokens
 * results in a single repaint (opencode's 16ms coalescing). Auto-reconnects
 * with exponential backoff.
 */
export class AgentClient {
  private ws: WebSocket | null = null;
  private url: string;
  private closed = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private handlers = new Set<Handler>();
  private queue: ServerMessage[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFlush = 0;

  onOpen: (() => void) | undefined;
  onClose: (() => void) | undefined;

  constructor(url: string) {
    this.url = url;
  }

  connect() {
    this.closed = false;
    this.openConnection();
  }

  private openConnection() {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.onOpen?.();
    };

    ws.onmessage = (event) => {
      const text = typeof event.data === "string" ? event.data : String(event.data);
      const message = parseServerMessage(text);
      if (message) this.enqueue(message);
    };

    ws.onerror = () => {
      // onclose will fire; nothing to do here
    };

    ws.onclose = () => {
      this.ws = null;
      this.onClose?.();
      if (this.closed) return;
      if (!this.reconnectTimer) {
        const attempt = this.reconnectAttempts++;
        const backoff = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.openConnection();
        }, backoff);
      }
    };
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close();
    this.ws = null;
    this.clearFlush();
  }

  send(message: ClientMessage) {
    this.ws?.send(JSON.stringify(message));
  }

  // ---- batched emitter ----
  on(handler: Handler) {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  private enqueue(message: ServerMessage) {
    this.queue.push(message);
    const now = Date.now();
    if (this.flushTimer) return;
    const elapsed = now - this.lastFlush;
    if (elapsed < 16) {
      this.flushTimer = setTimeout(() => this.flush(), 16);
    } else {
      this.flush();
    }
  }

  private flush() {
    this.flushTimer = null;
    this.lastFlush = Date.now();
    if (this.queue.length === 0) return;
    const events = this.queue;
    this.queue = [];
    for (const handler of this.handlers) {
      for (const event of events) handler(event);
    }
  }

  private clearFlush() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.queue = [];
  }
}