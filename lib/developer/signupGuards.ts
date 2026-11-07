import { NextResponse } from "next/server";
import { clientIp, rateLimit } from "@/lib/server/rateLimit";
import { errorBody, statusForCode, type ApiErrorCode } from "./errors";

/**
 * Shared guards for the public self-service signup endpoints.
 *
 * These are the only `/api/v1` routes an unauthenticated visitor may call, so
 * they carry the abuse controls the rest of the API does not need: a persistent
 * (store-backed) rate limit, and a same-origin check on state-changing requests.
 *
 * The rate limit lives in the shared store, **not** process memory, so it holds
 * across serverless instances — a per-process counter would reset on every cold
 * start and bound nothing in production.
 */

export type SignupGuardFailure = { ok: false; response: NextResponse };

/** A uniform JSON error for the public signup surface. */
export function signupError(code: ApiErrorCode, message: string, status?: number, detail?: string): NextResponse {
  return NextResponse.json(errorBody(code, message, detail), { status: status ?? statusForCode(code) });
}

/**
 * Enforce a persistent rate limit for one bucket/subject. Returns the failure
 * response when the limit is exceeded, or null when the request may proceed.
 */
export async function signupRateLimit(input: {
  bucket: string;
  req: Request;
  limit: number;
  windowMs: number;
  /** An additional subject (e.g. the target email) so one address cannot be spammed. */
  subject?: string;
}): Promise<SignupGuardFailure | null> {
  const ip = clientIp(input.req);
  const subjects = [ip];
  if (input.subject) subjects.push(`${ip}|${input.subject.toLowerCase()}`);
  for (const subject of subjects) {
    const res = await rateLimit({ bucket: input.bucket, subject, limit: input.limit, windowMs: input.windowMs });
    if (!res.ok) {
      const retryAfter = Math.max(1, Math.ceil((res.resetAt - Date.now()) / 1000));
      const response = NextResponse.json(
        errorBody("rate_limited", "Too many attempts. Please wait and try again."),
        { status: 429, headers: { "Retry-After": String(retryAfter) } },
      );
      return { ok: false, response };
    }
  }
  return null;
}

/**
 * Reject a state-changing request whose `Origin` is present and not this host.
 *
 * There is no ambient cookie authority on these endpoints (they take a JSON body
 * and return a token), so this is not a classic CSRF defence — it is a cheap
 * same-origin check that stops a third-party page from driving signup traffic on
 * a visitor's behalf. A missing `Origin` (a server-to-server caller, curl) is
 * allowed, since no browser context is implied.
 */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  let host: string | null = null;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const target = req.headers.get("host");
  if (target && host === target) return true;
  // Behind a proxy the Host header can differ; compare against the configured
  // public origin as a fallback so a correct deployment is never blocked.
  const configured = process.env.INTENT_PAY_PUBLIC_ORIGIN;
  if (configured) {
    try {
      if (new URL(configured).host === host) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}
