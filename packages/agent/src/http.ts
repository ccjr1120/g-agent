import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  RETRYABLE_STATUS,
} from "./types.js";

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  const timeoutMs = positiveEnvNumber(
    "G_AGENT_REQUEST_TIMEOUT_MS",
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  const maxRetries = positiveEnvNumber(
    "G_AGENT_MAX_RETRIES",
    DEFAULT_MAX_RETRIES,
    true,
  );

  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal
      ? AbortSignal.any([signal, timeout])
      : timeout;

    try {
      const response = await fetch(url, { ...init, signal: requestSignal });
      if (!RETRYABLE_STATUS.has(response.status) || attempt >= maxRetries) {
        return response;
      }
      await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      if (signal?.aborted || attempt >= maxRetries || !isRetryableError(error)) {
        throw error;
      }
    }

    await abortableDelay(Math.min(250 * 2 ** attempt, 2_000), signal);
  }
}

export function positiveEnvNumber(
  name: string,
  fallback: number,
  allowZero = false,
): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && (allowZero ? value >= 0 : value > 0)
    ? Math.floor(value)
    : fallback;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function isRetryableError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof DOMException && error.name === "TimeoutError")
  );
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
