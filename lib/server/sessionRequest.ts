import { SESSION_COOKIE, verifySession, type Session } from "@/lib/server/auth";

/**
 * Extract the authenticated session from a request's httpOnly cookie.
 *
 * This is the ONLY way routes learn a caller's wallet address for protected
 * operations. A client-supplied `address` is never trusted as identity — it is
 * at most a hint, and the authoritative value always comes from the verified
 * session.
 */
export function sessionFromRequest(req: Request): Session | null {
  const cookie = req.headers.get("cookie") ?? "";
  const match = cookie.split(/;\s*/).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!match) return null;
  const token = decodeURIComponent(match.slice(SESSION_COOKIE.length + 1));
  return verifySession(token);
}
