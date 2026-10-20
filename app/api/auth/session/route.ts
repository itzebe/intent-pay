import { NextResponse } from "next/server";
import { recoverMessageAddress } from "viem";
import {
  SESSION_COOKIE,
  createChallenge,
  issueSession,
  verifyChallenge,
  verifySession,
} from "@/lib/server/auth";
import { rateLimit, clientIp } from "@/lib/server/rateLimit";
import { isEvmAddress } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * GET /api/auth/session — is there a valid session? Returns the authenticated
 * address only (never a token), so the client can render the right state.
 */
export async function GET(req: Request) {
  const token = readSessionCookie(req);
  const session = await verifySession(token);
  if (!session) return NextResponse.json({ ok: true, authenticated: false });
  return NextResponse.json({ ok: true, authenticated: true, address: session.address });
}

/**
 * POST /api/auth/session — wallet login.
 *
 * Body: { address } requests a challenge; { address, nonce, message, signature }
 * verifies it. A valid EIP-191 signature issues an HMAC-signed session token in
 * an httpOnly cookie bound to that address.
 */
export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, message: "Invalid request." }, { status: 400 });
  }

  const address = typeof body?.address === "string" ? body.address : "";
  if (!isEvmAddress(address)) {
    return NextResponse.json({ ok: false, message: "A valid wallet address is required." }, { status: 400 });
  }

  // Challenge request.
  if (!body?.signature) {
    const limited = await rateLimit({ bucket: "auth_challenge", subject: clientIp(req), limit: 30, windowMs: 60_000 });
    if (!limited.ok) return tooMany(limited.resetAt);
    const challenge = await createChallenge(address);
    return NextResponse.json({ ok: true, ...challenge });
  }

  // Verification request.
  const limited = await rateLimit({ bucket: "auth_verify", subject: clientIp(req), limit: 30, windowMs: 60_000 });
  if (!limited.ok) return tooMany(limited.resetAt);

  const verified = await verifyChallenge({
    address,
    nonce: String(body?.nonce ?? ""),
    message: String(body?.message ?? ""),
    signature: String(body?.signature ?? ""),
    recover: ({ message, signature }) =>
      recoverMessageAddress({ message, signature: signature as `0x${string}` }),
  });
  if (!verified.ok) {
    return NextResponse.json(
      { ok: false, reason: verified.reason, message: "Sign-in could not be verified." },
      { status: verified.reason === "bad_signature" ? 401 : 400 },
    );
  }

  const token = await issueSession(address);
  const res = NextResponse.json({ ok: true, authenticated: true, address: address.toLowerCase() });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 24 * 60 * 60,
  });
  return res;
}

/** DELETE /api/auth/session — log out. */
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}

function readSessionCookie(req: Request): string | null {
  const cookie = req.headers.get("cookie") ?? "";
  const match = cookie.split(/;\s*/).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!match) return null;
  return decodeURIComponent(match.slice(SESSION_COOKIE.length + 1));
}

function tooMany(resetAt: number) {
  const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
  return NextResponse.json(
    { ok: false, message: "Too many attempts. Please wait and try again." },
    { status: 429, headers: { "Retry-After": String(retryAfter) } },
  );
}
