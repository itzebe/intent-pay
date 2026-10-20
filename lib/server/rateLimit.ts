import { getStore } from "@/lib/store";

/**
 * A minimal, fixed-window rate limiter backed by the shared store.
 *
 * It is deliberately simple and dependency-free. It is *not* a substitute for a
 * distributed limiter in front of the app, but it does bound referral-code
 * enumeration, attribution spam, and qualification flooding at the application
 * layer — and it works identically in the SQLite and in-memory stores, so the
 * tests exercise the real logic.
 *
 * Keys are namespaced (`rl:<bucket>:<subject>:<window>`). A counter lives in the
 * `kv` table and is unique by key, so concurrent increments converge on one row.
 */

export type RateLimitResult = {
  ok: boolean;
  remaining: number;
  /** Unix ms when the window resets (for a Retry-After). */
  resetAt: number;
  limit: number;
};

export type RateLimitInput = {
  bucket: string;
  subject: string;
  limit: number;
  windowMs: number;
  now?: number;
};

export function rateLimit(input: RateLimitInput): RateLimitResult {
  const now = input.now ?? Date.now();
  const windowIndex = Math.floor(now / input.windowMs);
  const resetAt = (windowIndex + 1) * input.windowMs;
  const key = `rl:${input.bucket}:${input.subject}:${windowIndex}`;
  const store = getStore();
  const existing = store.findOne("kv", { key });
  const count = existing ? Number(existing.value) || 0 : 0;
  if (count >= input.limit) {
    return { ok: false, remaining: 0, resetAt, limit: input.limit };
  }
  const next = count + 1;
  if (existing) {
    store.update("kv", { key }, { value: String(next), updatedAt: now });
  } else {
    try {
      store.insert("kv", { key, value: String(next), updatedAt: now });
    } catch {
      // Lost a race creating the row: increment the winner.
      const row = store.findOne("kv", { key });
      if (row) store.update("kv", { key }, { value: String(Number(row.value) + 1), updatedAt: now });
    }
  }
  return { ok: true, remaining: Math.max(0, input.limit - next), resetAt, limit: input.limit };
}

/**
 * A coarse, privacy-preserving client fingerprint.
 *
 * It is a salted hash of the client IP plus the user agent, used only for
 * deduplicating clicks and detecting abuse. It is not reversible and is never
 * treated as a hard identity — two legitimate users behind one NAT may share it,
 * so it never by itself blocks a legitimate referral.
 */
export function clientFingerprint(req: Request, now = Date.now()): string {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  const ua = req.headers.get("user-agent") ?? "unknown";
  const salt = process.env.INTENT_PAY_FINGERPRINT_SALT ?? "intent-pay";
  // A stable, non-cryptographic hash is enough for a dedup bucket; combine a day
  // so the fingerprint rotates and cannot be used for long-term tracking.
  const day = new Date(now).toISOString().slice(0, 10);
  let h = 2166136261;
  const input = `${salt}|${ip}|${ua}|${day}`;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** The client IP, for IP-scoped rate limits. */
export function clientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

/** A standard 429 body with a Retry-After header, without leaking internals. */
export function tooManyResponse(resetAt: number): { body: Record<string, unknown>; headers: Record<string, string> } {
  const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
  return {
    body: { ok: false, code: "rate_limited", message: "Too many requests. Please wait and try again." },
    headers: { "Retry-After": String(retryAfter) },
  };
}
