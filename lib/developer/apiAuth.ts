import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { authenticateApiKey, type AuthenticatedDeveloper } from "./credentials";
import { errorBody, statusForCode, type ApiErrorCode } from "./errors";

/**
 * Request authentication for `/api/v1/*`.
 *
 * The API key is read from the `Authorization: Bearer <key>` header (the
 * standard, and the only place we look — never a query string, which would leak
 * into logs and referrers). Authentication is a hard gate: a route that needs an
 * authenticated developer must call `requireDeveloper` and return its failure
 * response unchanged.
 */

/** The correlation id for this request, echoed to the client and used in logs. */
export function requestId(req: Request): string {
  const header = req.headers.get("x-request-id");
  if (header && /^[A-Za-z0-9._-]{8,128}$/.test(header)) return header;
  return randomUUID();
}

/** Extract the bearer token from the Authorization header, if present. */
export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

export type RequireDeveloperResult =
  | { ok: true; auth: AuthenticatedDeveloper; requestId: string }
  | { ok: false; response: NextResponse };

/** Authenticate the request or produce the 401/403 response to return. */
export async function requireDeveloper(req: Request): Promise<RequireDeveloperResult> {
  const rid = requestId(req);
  const result = await authenticateApiKey(bearerToken(req));
  if (!result.ok) {
    const code: ApiErrorCode = result.code === "forbidden" ? "forbidden" : "unauthorized";
    return {
      ok: false,
      response: NextResponse.json(errorBody(code, result.message, undefined, rid), {
        status: statusForCode(code),
        headers: { "WWW-Authenticate": 'Bearer realm="intent-pay"' },
      }),
    };
  }
  return { ok: true, auth: result.value, requestId: rid };
}

/** A uniform JSON error response for a route. */
export function apiError(code: ApiErrorCode, message: string, rid?: string, detail?: string): NextResponse {
  return NextResponse.json(errorBody(code, message, detail, rid), { status: statusForCode(code) });
}

/** A uniform JSON success response. */
export function apiOk(data: Record<string, unknown>, init?: { status?: number }): NextResponse {
  return NextResponse.json({ ok: true, ...data }, { status: init?.status ?? 200 });
}

/** Parse a JSON body, returning null on malformed input (never throwing). */
export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
