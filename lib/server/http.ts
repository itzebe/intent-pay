/**
 * Tiny TTL + in-flight-dedup cache for server-side provider calls.
 *
 * Provider calls (prices, wallet intelligence) are expensive and bursty — a
 * single keystroke can fan out to several. This keeps the composer responsive
 * and polite to rate-limited APIs without any background machinery.
 */
export class TtlCache<K, V> {
  private store = new Map<K, { value: V; at: number }>();
  private inflight = new Map<K, Promise<V>>();

  constructor(private ttlMs: number) {}

  peek(key: K): V | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > this.ttlMs) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }

  async get(key: K, produce: () => Promise<V>): Promise<V> {
    const hit = this.peek(key);
    if (hit !== undefined) return hit;

    const existing = this.inflight.get(key);
    if (existing) return existing;

    const p = produce()
      .then((value) => {
        this.store.set(key, { value, at: Date.now() });
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  set(key: K, value: V): void {
    this.store.set(key, { value, at: Date.now() });
  }

  clear(): void {
    this.store.clear();
  }
}

/**
 * Reduce an upstream error (RPC, indexer, provider) to a short, client-safe
 * message.
 *
 * A raw provider message can embed the full request URL — and a viem
 * `HttpRequestError` includes it verbatim (`URL: https://…/v2/<key>`). Returning
 * that straight to the browser would disclose the configured RPC key inside an
 * API error body (and any proxy/analytics log of it). This strips every URL down
 * to its origin before truncating, and never returns a stack trace.
 */
export function sanitizeUpstreamError(err: unknown, fallback: string): string {
  const raw = (err as { message?: unknown })?.message;
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  const scrubbed = raw.replace(
    // Keep the origin (host) — useful for diagnosis, discloses no path/query.
    /https?:\/\/[^\s"'<>)\]]+/gi,
    (url) => {
      try {
        return new URL(url).origin;
      } catch {
        return "[url]";
      }
    },
  );
  return scrubbed.length > 200 ? `${scrubbed.slice(0, 200)}…` : scrubbed;
}

/** fetch with a hard timeout so a hung provider can never stall a quote. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 6000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...rest, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
