import { rateLimit, tooManyResponse } from "@/lib/server/rateLimit";

/**
 * Per-tenant rate limits for the developer API.
 *
 * Limits are keyed by the *developer id* (never the IP), so one integrator
 * cannot exhaust another's budget, and a shared NAT does not penalize a
 * legitimate tenant. The store-backed fixed-window limiter is reused so the
 * behaviour is identical across backends and testable without a network.
 */
export type LimitName = "read" | "write" | "create_intent" | "prepare" | "submit" | "verify" | "webhook";

const LIMITS: Record<LimitName, { limit: number; windowMs: number }> = {
  read: { limit: 300, windowMs: 60_000 },
  write: { limit: 120, windowMs: 60_000 },
  create_intent: { limit: 60, windowMs: 60_000 },
  prepare: { limit: 60, windowMs: 60_000 },
  submit: { limit: 60, windowMs: 60_000 },
  verify: { limit: 60, windowMs: 60_000 },
  webhook: { limit: 30, windowMs: 60_000 },
};

export type RateOutcome = { ok: true; remaining: number; limit: number } | { ok: false; resetAt: number };

export async function checkLimit(developerId: string, name: LimitName, now = Date.now()): Promise<RateOutcome> {
  const cfg = LIMITS[name];
  const result = await rateLimit({ bucket: `v1_${name}`, subject: developerId, limit: cfg.limit, windowMs: cfg.windowMs, now });
  if (result.ok) return { ok: true, remaining: result.remaining, limit: result.limit };
  return { ok: false, resetAt: result.resetAt };
}

export { tooManyResponse };
