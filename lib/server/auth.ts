import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isEvmAddress } from "@/lib/format";
import { getStore } from "@/lib/store";

/**
 * Wallet-based authentication.
 *
 * Intent Pay has no user accounts: the connected wallet *is* the identity. That
 * is a fine identity for referrals and per-user data — but only if the server can
 * prove the caller controls the address, and only if it never trusts a
 * client-supplied address as proof of ownership.
 *
 * The scheme is deliberately minimal and uses only Node builtins:
 *
 *   1. The client asks for a nonce (`createChallenge`).
 *   2. The wallet signs a fixed, human-readable message containing that nonce
 *      (EIP-191 `personal_sign`) — `verifyChallenge` recovers the signer and
 *      checks it matches the claimed address, then burns the nonce.
 *   3. The server issues an HMAC-signed session token bound to that address and
 *      an expiry (`issueSession`). The client sends it back on protected calls.
 *
 * The signature check itself (ECDSA recovery) is injected as `recover`, so this
 * module stays pure and unit-testable; the route wires in viem's verifier. The
 * HMAC secret is generated on first use and stored server-side — it never
 * leaves the server and is never logged.
 *
 * Nothing here stores a private key, seed phrase, or raw signature: only the
 * recovered address and a short-lived token.
 */

export const SESSION_COOKIE = "ip_session";
const NONCE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const NONCE_PREFIX = "nonce:";
const SECRET_KEY = "session_secret";

/** The human-readable message a wallet signs. Stable, so it is reproducible. */
export function challengeMessage(address: string, nonce: string, origin: string): string {
  return [
    "Intent Pay wants you to sign in with your Monad wallet:",
    address.toLowerCase(),
    "",
    "This request proves you control this address. It costs no gas and sends no transaction.",
    "",
    `Origin: ${origin}`,
    `Nonce: ${nonce}`,
    "Chain: Monad Mainnet (143)",
  ].join("\n");
}

/** A fresh, cryptographically random nonce (never sequential or guessable). */
export function newNonce(): string {
  return randomBytes(16).toString("hex");
}

export type Session = {
  address: string;
  /** Unix ms expiry. */
  exp: number;
};

/** The HMAC secret, generated once and persisted server-side. */
function sessionSecret(): string {
  const store = getStore();
  const existing = store.findOne("kv", { key: SECRET_KEY });
  if (existing) return existing.value;
  const secret = randomBytes(32).toString("hex");
  store.upsert("kv", { key: SECRET_KEY, value: secret, updatedAt: Date.now() });
  return secret;
}

function sign(payload: string): string {
  return createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
}

/** Issue an opaque, tamper-evident session token for a verified address. */
export function issueSession(address: string, now = Date.now()): string {
  const exp = now + SESSION_TTL_MS;
  const payload = `${address.toLowerCase()}.${exp}`;
  return `${Buffer.from(payload).toString("base64url")}.${sign(payload)}`;
}

/** Verify a session token; returns the session or null. Never throws. */
export function verifySession(token: string | undefined | null, now = Date.now()): Session | null {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [encoded, mac] = parts;
  let payload: string;
  try {
    payload = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const expected = sign(payload);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const [address, expStr] = payload.split(".");
  if (!isEvmAddress(address)) return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < now) return null;
  return { address: address.toLowerCase(), exp };
}

/** Create and persist a nonce challenge for an address. */
export function createChallenge(address: string, now = Date.now()): { nonce: string; message: string } {
  if (!isEvmAddress(address)) throw new Error("A valid wallet address is required.");
  const nonce = newNonce();
  getStore().upsert("kv", {
    key: `${NONCE_PREFIX}${nonce}`,
    value: JSON.stringify({ address: address.toLowerCase(), exp: now + NONCE_TTL_MS }),
    updatedAt: now,
  });
  return { nonce, message: challengeMessage(address, nonce, "intent-pay") };
}

/**
 * Consume a nonce, verifying the signed message. Returns the recovered address
 * when valid. The nonce is single-use: it is removed whether or not the
 * signature matched, so a replay cannot succeed.
 */
export async function verifyChallenge(input: {
  address: string;
  nonce: string;
  message: string;
  signature: string;
  recover: (args: { message: string; signature: string }) => string | null | Promise<string | null>;
  now?: number;
}): Promise<{ ok: true; address: string } | { ok: false; reason: string }> {
  const now = input.now ?? Date.now();
  const store = getStore();
  const key = `${NONCE_PREFIX}${input.nonce}`;
  const stored = store.findOne("kv", { key });
  if (!stored) return { ok: false, reason: "unknown_nonce" };
  // Single-use: burn the nonce whether or not the rest checks out.
  store.remove("kv", { key });
  let parsed: { address: string; exp: number };
  try {
    parsed = JSON.parse(stored.value);
  } catch {
    return { ok: false, reason: "malformed_nonce" };
  }
  if (parsed.exp < now) return { ok: false, reason: "expired_nonce" };
  if (parsed.address !== input.address.toLowerCase()) return { ok: false, reason: "address_mismatch" };
  if (!isEvmAddress(input.address)) return { ok: false, reason: "invalid_address" };
  if (!input.message.includes(input.nonce)) return { ok: false, reason: "nonce_missing" };
  let recovered: string | null = null;
  try {
    recovered = await input.recover({ message: input.message, signature: input.signature });
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
  if (!recovered || recovered.toLowerCase() !== input.address.toLowerCase()) {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true, address: input.address.toLowerCase() };
}

/**
 * Administrative authorization.
 *
 * The ops/cost endpoints are server-only and gated by `INTENT_PAY_ADMIN_TOKEN`.
 * When it is unset the endpoints are *unavailable* (not open) — a missing secret
 * must never mean "no auth required".
 */
export function adminAuthorized(header: string | null | undefined): boolean {
  const expected = process.env.INTENT_PAY_ADMIN_TOKEN;
  if (!expected) return false;
  if (!header) return false;
  const token = header.replace(/^Bearer\s+/i, "").trim();
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Whether admin endpoints are configured at all (for honest reporting). */
export function adminConfigured(): boolean {
  return Boolean(process.env.INTENT_PAY_ADMIN_TOKEN);
}
