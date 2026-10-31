import { NextResponse } from "next/server";
import { rateLimit, clientIp, tooManyResponse } from "./rateLimit";

/**
 * Central API guards.
 *
 * Intent Pay's public surface (quote, balances, tokens, optimize, partial, the NL
 * intent engine) is intentionally unauthenticated — a visitor must be able to
 * price and review a payment before connecting a wallet. That makes these routes
 * the abuse surface: each one fans out to paid or rate-limited infrastructure
 * (LLM inference, Alchemy RPC, Zerion, GeckoTerminal/DexScreener). These helpers
 * apply the two controls every expensive route needs:
 *
 *   - a per-IP fixed-window rate limit with a trusted client IP (see
 *     `rateLimit.clientIp`), so a caller cannot rotate a spoofed header to escape
 *     the bucket;
 *   - a bounded request body, so an oversized payload cannot be used to burn CPU
 *     or memory before validation.
 *
 * The limit is a politeness/abuse control, not an authorization gate, so it fails
 * open when the store is unreachable (see `rateLimit`) and it is deliberately
 * generous enough that a normal interactive user never notices it.
 */

export type RouteLimit = {
  /** Namespaced bucket, e.g. "quote". */
  bucket: string;
  /** Requests allowed per window. */
  limit: number;
  /** Window length in ms. */
  windowMs: number;
};

/**
 * A per-route policy. Keep these generous: the composer refreshes a quote every
 * ~15s and revalidates balances every ~12s, so a single active user makes only a
 * handful of calls per minute. The limits below leave ~10x headroom for that
 * while still bounding an abuser.
 */
export const ROUTE_LIMITS = {
  nlp: { bucket: "nlp", limit: 30, windowMs: 60_000 },
  quote: { bucket: "quote", limit: 120, windowMs: 60_000 },
  balances: { bucket: "balances", limit: 60, windowMs: 60_000 },
  optimize: { bucket: "optimize", limit: 60, windowMs: 60_000 },
  partial: { bucket: "partial", limit: 60, windowMs: 60_000 },
  tokensRead: { bucket: "tokens_read", limit: 120, windowMs: 60_000 },
  tokensWrite: { bucket: "tokens_write", limit: 30, windowMs: 60_000 },
  // These read-only endpoints probe external providers (Alchemy, Zerion) and the
  // store, so they are an amplification surface even though they carry no user
  // data. The UI calls them on load, hence the generous ceiling.
  capabilities: { bucket: "capabilities", limit: 60, windowMs: 60_000 },
  referralAvailability: { bucket: "referral_availability", limit: 60, windowMs: 60_000 },
  // Administrative surfaces (diagnostics, ops). Tight, because they are a
  // brute-force target for the admin token and each one fans out to external
  // provider probes. Applied *before* any of that work.
  admin: { bucket: "admin", limit: 10, windowMs: 60_000 },
} as const satisfies Record<string, RouteLimit>;

/** The maximum accepted JSON body size (bytes) for a payment API request. */
export const MAX_JSON_BODY_BYTES = 256 * 1024;

/**
 * Apply a route's rate limit. Returns a 429 response when the caller is over the
 * limit, or null when the request may proceed. Never throws.
 */
export async function enforceRateLimit(
  req: Request,
  policy: RouteLimit,
): Promise<NextResponse | null> {
  const limited = await rateLimit({
    bucket: policy.bucket,
    subject: clientIp(req),
    limit: policy.limit,
    windowMs: policy.windowMs,
  });
  if (limited.ok) return null;
  const { body, headers } = tooManyResponse(limited.resetAt);
  return NextResponse.json(body, { status: 429, headers });
}

/**
 * Read a JSON body with a hard size cap. Returns `{ ok: false }` when the payload
 * is missing, malformed, or larger than `maxBytes`, so a caller can never make the
 * server buffer an unbounded body. A declared `Content-Length` over the cap is
 * rejected without reading; otherwise the text is measured before parsing.
 */
export async function readJsonBody<T = unknown>(
  req: Request,
  maxBytes: number = MAX_JSON_BODY_BYTES,
): Promise<{ ok: true; body: T } | { ok: false }> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false };
  let text: string;
  try {
    text = await req.text();
  } catch {
    return { ok: false };
  }
  if (text.length > maxBytes) return { ok: false };
  if (!text.trim()) return { ok: false };
  try {
    return { ok: true, body: JSON.parse(text) as T };
  } catch {
    return { ok: false };
  }
}

/** Bound an untrusted array to a sane maximum before it is processed. */
export function capArray<T>(value: unknown, max: number): T[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, max) as T[];
}
