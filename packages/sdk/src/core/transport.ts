import { ApiError, TransportError, type ApiErrorCode } from "./errors.js";
import type { ResolvedConfig } from "./config.js";

/**
 * The HTTP transport.
 *
 * Responsibilities kept in one place so no resource method reimplements them:
 *  - a single `Authorization: Bearer` header, never a query parameter;
 *  - an `AbortController` timeout on every request;
 *  - bounded retries with exponential backoff + jitter, honoring `Retry-After`;
 *  - a typed error for every failure shape (a non-2xx body, a non-JSON body, a
 *    network error, a timeout);
 *  - idempotency-aware retry: a request that carries an `Idempotency-Key` may be
 *    retried even on a timeout, because the server deduplicates it; a request
 *    without one is retried only when it never reached the server.
 */

export type RequestOptions = {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  /** Send this as the `Idempotency-Key` header (create-intent). */
  idempotencyKey?: string;
  /** Override the client timeout for this request. */
  timeoutMs?: number;
  /** Override the client retry budget for this request. */
  maxRetries?: number;
  /**
   * A request whose effects are not safely repeatable (e.g. `submit`) sets this,
   * so a *timeout* is not retried — the transaction may already exist. A connect
   * error (the request never left) is still retried.
   */
  nonIdempotent?: boolean;
  signal?: AbortSignal;
};

/** A minimal sleep that rejects if the caller's signal aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new TransportError("transport_network_error", "The request was aborted."));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new TransportError("transport_network_error", "The request was aborted."));
      },
      { once: true },
    );
  });
}

/** Exponential backoff with full jitter, capped at 8s. */
export function backoffDelay(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined && retryAfterMs >= 0) return Math.min(retryAfterMs, 30_000);
  const base = Math.min(250 * 2 ** attempt, 8_000);
  return Math.floor(base / 2 + Math.random() * (base / 2));
}

/** Parse a `Retry-After` header (seconds or an HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return undefined;
}

/**
 * Whether a request may be retried after a given failure.
 *
 * The rule has one safety property at its centre: **a transaction-submitting
 * request is never repeated unless the repeat is provably safe.** "Provably
 * safe" means one of:
 *   - the request never established a connection, so it did not reach the
 *     server (`neverReachedServer`);
 *   - the request is idempotent by design (a read, or a create the server
 *     deduplicates);
 *   - the request carries an `Idempotency-Key` the server deduplicates on.
 *
 * A `submit` is none of these, so a timeout or a 5xx on a submit is reported to
 * the caller to reconcile — never silently retried.
 */
export function shouldRetry(input: {
  attempt: number;
  maxRetries: number;
  status?: number | undefined;
  neverReachedServer?: boolean | undefined;
  timedOut?: boolean | undefined;
  nonIdempotent?: boolean | undefined;
  idempotencyKey?: string | undefined;
}): boolean {
  if (input.attempt >= input.maxRetries) return false;
  if (input.neverReachedServer) return true;
  const repeatSafe = !input.nonIdempotent || Boolean(input.idempotencyKey);
  if (!repeatSafe) return false;
  if (input.status === undefined) return Boolean(input.timedOut);
  return input.status === 429 || input.status === 408 || (input.status >= 500 && input.status <= 599);
}

export type RawResponse = {
  status: number;
  ok: boolean;
  headers: Headers;
  text: string;
};

/** A `fetch` failure that never established a connection (safe to retry). */
function isConnectError(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  const message = String((err as { message?: string })?.message ?? "");
  if (name === "AbortError") return false;
  // Node's undici reports ECONNREFUSED / ENOTFOUND / EAI_AGAIN on a connect error.
  return /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|fetch failed/i.test(message) || name === "TypeError";
}

export class Transport {
  constructor(private readonly config: ResolvedConfig) {}

  /** Perform one request with the full retry policy applied. */
  async request(options: RequestOptions): Promise<RawResponse> {
    const url = `${this.config.baseUrl}${options.path}`;
    const timeoutMs = options.timeoutMs ?? this.config.timeoutMs;
    const maxRetries = options.maxRetries ?? this.config.maxRetries;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

    let attempt = 0;
    for (;;) {
      let response: RawResponse | undefined;
      let failure: { neverReachedServer: boolean; timedOut: boolean; err: unknown } | undefined;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onOuterAbort = () => controller.abort();
      options.signal?.addEventListener("abort", onOuterAbort, { once: true });
      try {
        const init: RequestInit = {
          method: options.method,
          headers,
          signal: controller.signal,
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        };
        const res = await this.config.fetch(url, init);
        response = { status: res.status, ok: res.ok, headers: res.headers, text: await res.text() };
      } catch (err) {
        const aborted = (err as { name?: string })?.name === "AbortError";
        // A timeout aborts our own controller; an outer abort is the caller's.
        const timedOut = aborted && !options.signal?.aborted;
        failure = { neverReachedServer: !aborted && isConnectError(err), timedOut, err };
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onOuterAbort);
      }

      if (response) {
        if (!response.ok && shouldRetry({ attempt, maxRetries, status: response.status, nonIdempotent: options.nonIdempotent, idempotencyKey: options.idempotencyKey })) {
          const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
          attempt++;
          await sleep(backoffDelay(attempt, retryAfter), options.signal);
          continue;
        }
        return response;
      }

      if (failure) {
        if (failure.neverReachedServer && shouldRetry({ attempt, maxRetries, neverReachedServer: true, nonIdempotent: options.nonIdempotent, idempotencyKey: options.idempotencyKey })) {
          attempt++;
          await sleep(backoffDelay(attempt), options.signal);
          continue;
        }
        if (failure.timedOut && shouldRetry({ attempt, maxRetries, timedOut: true, nonIdempotent: options.nonIdempotent, idempotencyKey: options.idempotencyKey })) {
          attempt++;
          await sleep(backoffDelay(attempt), options.signal);
          continue;
        }
        throw new TransportError(
          failure.timedOut ? "transport_timeout" : "transport_network_error",
          failure.timedOut ? `The request to ${options.path} timed out after ${timeoutMs}ms.` : `The request to ${options.path} could not be sent.`,
          { path: options.path },
        );
      }
    }
  }

  /**
   * Perform a request and parse the JSON body, mapping a non-2xx response to an
   * `ApiError` that carries the server's stable code and message.
   */
  async json<T>(options: RequestOptions): Promise<T> {
    const response = await this.request(options);
    let parsed: unknown;
    try {
      parsed = response.text ? JSON.parse(response.text) : undefined;
    } catch {
      if (!response.ok) {
        throw new ApiError("internal_error", "The server returned a response the SDK could not read.", {
          status: response.status,
          path: options.path,
          body: response.text.slice(0, 500),
        });
      }
      throw new TransportError("transport_bad_response", "The server returned a response that was not valid JSON.", {
        status: response.status,
        path: options.path,
      });
    }

    if (!response.ok) {
      const error = (parsed as { error?: { code?: string; message?: string; detail?: string; requestId?: string } })?.error;
      const code = (error?.code ?? "internal_error") as ApiErrorCode;
      throw new ApiError(code, error?.message ?? `Request failed with status ${response.status}.`, {
        status: response.status,
        path: options.path,
        ...(error?.requestId ? { requestId: error.requestId } : {}),
        ...(error?.detail ? { detail: error.detail } : {}),
      });
    }

    return parsed as T;
  }
}
