import { getStore } from "@/lib/store";
import { sweepExpiredKv } from "@/lib/server/kvMaintenance";

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

export async function rateLimit(input: RateLimitInput): Promise<RateLimitResult> {
  const now = input.now ?? Date.now();
  // Best-effort, at-most-once-per-interval sweep of dead counters/nonces so the
  // kv/counter tables cannot grow without bound on a serverless deployment with
  // no cron.
  sweepExpiredKv(now);
  const windowIndex = Math.floor(now / input.windowMs);
  const resetAt = (windowIndex + 1) * input.windowMs;
  const key = `rl:${input.bucket}:${input.subject}:${windowIndex}`;
  try {
    const store = getStore();
    // A single atomic increment: the count and the write are one step, so a burst
    // of concurrent requests cannot all read the same value and slip past the
    // limit (the read-modify-write this replaced was lossy under concurrency).
    const next = await store.incrementInt(
      "counters",
      { key },
      "value",
      1,
      { key, value: 1, updatedAt: now },
    );
    if (next > input.limit) {
      return { ok: false, remaining: 0, resetAt, limit: input.limit };
    }
    return { ok: true, remaining: Math.max(0, input.limit - next), resetAt, limit: input.limit };
  } catch {
    // Fail *open*: a storage outage must never block a legitimate payment. The
    // limiter is a politeness/abuse control, not an authorization gate, so
    // availability wins here. A persistent failure is visible through the ops
    // surface and the provider's own rate limits remain the backstop.
    return { ok: true, remaining: 0, resetAt, limit: input.limit };
  }
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
  const ip = clientIp(req);
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

/**
 * The client IP, for IP-scoped rate limits.
 *
 * The first entry of `X-Forwarded-For` is *client-controlled* and must never be
 * trusted: a caller can prepend an arbitrary value and rotate it to defeat every
 * IP-keyed limit. We prefer the platform's own peer address (`x-real-ip`, set by
 * Vercel) and the Vercel-managed forwarded chain, and only fall back to the
 * *last* hop of `x-forwarded-for` (the entry the trusted edge appended), never
 * the first. When nothing is present we return "unknown", which still yields a
 * single shared bucket rather than an attacker-chosen one.
 */
export function clientIp(req: Request): string {
  const realIp = req.headers.get("x-real-ip");
  if (realIp && realIp.trim()) return realIp.trim();

  // Vercel sets this to the real client address; a caller cannot prepend to it.
  const vercelFwd = req.headers.get("x-vercel-forwarded-for");
  if (vercelFwd) {
    const first = vercelFwd.split(",")[0]?.trim();
    if (first) return first;
  }

  // Last resort: the platform-appended (last) hop, never the client-supplied
  // first hop.
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }

  return "unknown";
}

/** A standard 429 body with a Retry-After header, without leaking internals. */
export function tooManyResponse(resetAt: number): { body: Record<string, unknown>; headers: Record<string, string> } {
  const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
  return {
    body: { ok: false, code: "rate_limited", message: "Too many requests. Please wait and try again." },
    headers: { "Retry-After": String(retryAfter) },
  };
}
