import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getStore } from "@/lib/store";
import type { ApiDeveloperRecord, ApiEmailVerificationRecord } from "@/lib/store/types";
import { StoreConflictError } from "@/lib/store/types";
import { issueApiKey, type IssuedApiKey } from "./credentials";
import { newApiKeyId, newDeveloperId, newId } from "./ids";

/**
 * Self-service developer registration.
 *
 * The public signup flow is deliberately two-step, so a credential is only ever
 * issued to an address its owner has proven they control:
 *
 *   1. `registerDeveloper` creates a **pending** account (`email_verified_at`
 *      null) and a single-use verification token. It issues **no key**.
 *   2. `verifyEmailToken` consumes the token and issues the first API key.
 *
 * The plaintext token is never stored — only its SHA-256 hash — so a database
 * read cannot yield a working verification link. The token expires and is
 * single-use; a second use of the same link fails. Registering an address that
 * already has a pending account re-sends (a fresh token) rather than creating a
 * duplicate, and a verified address can never be claimed twice (enforced by the
 * unique email constraint, not by a read-then-write race).
 */

/** How long a verification link stays valid. */
export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

/** The public token scheme marker (mirrors `ipk_` for keys). */
const TOKEN_SCHEME = "ipv";

/**
 * A pragmatic email check: one `@`, a dotted domain, no whitespace, bounded
 * length. It deliberately does not try to be RFC 5322 complete — the only real
 * proof an address exists is the verification email itself, which is why an
 * unverified account gets no credential.
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) return null;
  return email;
}

/** A fresh, high-entropy verification token (shown once, only its hash stored). */
export function newVerificationToken(): string {
  return `${TOKEN_SCHEME}_${randomBytes(32).toString("hex")}`;
}

/** The stored representation of a token: a plain SHA-256 (tokens are random). */
export function hashVerificationToken(token: string): string {
  return createHash("sha256").update(token.trim()).digest("hex");
}

/** Constant-time compare of two hex digests. */
function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
}

export type RegistrationResult =
  | { ok: true; developer: ApiDeveloperRecord; token: string; resent: boolean }
  | { ok: false; code: "invalid_email" | "already_registered" };

/**
 * Create (or re-arm) a pending developer account for an email address.
 *
 * Returns the plaintext token exactly once so the caller can email it; it is
 * never persisted and never returned by any route.
 */
export async function registerDeveloper(input: {
  name?: string;
  email: string;
  now?: number;
}): Promise<RegistrationResult> {
  const now = input.now ?? Date.now();
  const email = normalizeEmail(input.email);
  if (!email) return { ok: false, code: "invalid_email" };

  const store = getStore();
  const existing = await store.findOne("apiDevelopers", { email });

  // A verified account already owns this address: never hand out a second one.
  if (existing && existing.emailVerifiedAt !== null) {
    return { ok: false, code: "already_registered" };
  }

  let developer = existing;
  if (!developer) {
    developer = {
      id: newDeveloperId(),
      name: (input.name ?? "").trim().slice(0, 120) || email.split("@")[0].slice(0, 120) || "developer",
      email,
      emailVerifiedAt: null,
      status: "active",
      paymentXpub: null,
      nextDerivationIndex: 0,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await store.insert("apiDevelopers", developer);
    } catch (err) {
      // Lost a concurrent registration race: the winner's row exists now. Treat
      // it as a resend against the winner (never a duplicate account).
      if (!(err instanceof StoreConflictError)) throw err;
      const winner = await store.findOne("apiDevelopers", { email });
      if (!winner) throw err;
      developer = winner;
    }
  } else {
    await store.update("apiDevelopers", { id: developer.id }, { updatedAt: now });
  }

  const token = newVerificationToken();
  // One live challenge per developer: replace any previous row so an old link
  // stops working the moment a new one is issued.
  await store.remove("apiEmailVerifications", { developerId: developer.id });
  const row: ApiEmailVerificationRecord = {
    id: newId("evf"),
    developerId: developer.id,
    email,
    tokenHash: hashVerificationToken(token),
    createdAt: now,
    expiresAt: now + EMAIL_VERIFICATION_TTL_MS,
    consumedAt: null,
  };
  await store.insert("apiEmailVerifications", row);

  return { ok: true, developer, token, resent: Boolean(existing) };
}

/** Issue a fresh verification token for a pending account (resend). */
export async function resendVerification(
  developerId: string,
  now = Date.now(),
): Promise<{ ok: true; token: string; developer: ApiDeveloperRecord } | { ok: false; code: "not_found" | "already_verified" }> {
  const store = getStore();
  const developer = await store.findOne("apiDevelopers", { id: developerId });
  if (!developer) return { ok: false, code: "not_found" };
  if (developer.emailVerifiedAt !== null) return { ok: false, code: "already_verified" };
  if (!developer.email) return { ok: false, code: "not_found" };

  const token = newVerificationToken();
  await store.remove("apiEmailVerifications", { developerId });
  await store.insert("apiEmailVerifications", {
    id: newId("evf"),
    developerId,
    email: developer.email,
    tokenHash: hashVerificationToken(token),
    createdAt: now,
    expiresAt: now + EMAIL_VERIFICATION_TTL_MS,
    consumedAt: null,
  });
  return { ok: true, token, developer };
}

export type VerifyResult =
  | { ok: true; developer: ApiDeveloperRecord; issued: IssuedApiKey }
  | { ok: false; code: "invalid_token" | "expired_token" | "already_verified" };

/**
 * Consume a verification token and issue the account's first API key.
 *
 * The plaintext key is returned **once**. The token is single-use: it is removed
 * on success and its hash can never be replayed. An already-verified account is
 * reported distinctly so the UI can send the developer to the dashboard rather
 * than showing a confusing error — and crucially it is **not** given a fresh key,
 * because that would issue a credential without proof of email control.
 */
export async function verifyEmailToken(rawToken: string, now = Date.now()): Promise<VerifyResult> {
  const token = (rawToken ?? "").trim();
  if (!token) return { ok: false, code: "invalid_token" };
  const store = getStore();
  const row = await store.findOne("apiEmailVerifications", { tokenHash: hashVerificationToken(token) });
  if (!row) return { ok: false, code: "invalid_token" };

  // Defensive constant-time re-check of the hash before trusting the lookup.
  if (!safeEqualHex(row.tokenHash, hashVerificationToken(token))) {
    return { ok: false, code: "invalid_token" };
  }
  if (row.consumedAt !== null) return { ok: false, code: "already_verified" };
  if (row.expiresAt < now) return { ok: false, code: "expired_token" };

  const developer = await store.findOne("apiDevelopers", { id: row.developerId });
  if (!developer) return { ok: false, code: "invalid_token" };

  // Already verified by another challenge: never mint a second credential here.
  if (developer.emailVerifiedAt !== null) {
    await store.remove("apiEmailVerifications", { id: row.id });
    return { ok: false, code: "already_verified" };
  }

  await store.update("apiDevelopers", { id: developer.id }, { emailVerifiedAt: now, updatedAt: now });
  const issued = await issueApiKey(developer.id, { name: "Default key", environment: "live", now });
  // Single-use: drop the challenge so the link cannot be replayed.
  await store.remove("apiEmailVerifications", { id: row.id });

  const verified = await store.findOne("apiDevelopers", { id: developer.id });
  return { ok: true, developer: verified ?? { ...developer, emailVerifiedAt: now }, issued };
}

/** The pending challenge for a developer, if any (never includes the hash). */
export async function pendingVerification(
  developerId: string,
): Promise<Pick<ApiEmailVerificationRecord, "email" | "createdAt" | "expiresAt"> | null> {
  const row = await getStore().findOne("apiEmailVerifications", { developerId });
  if (!row) return null;
  return { email: row.email, createdAt: row.createdAt, expiresAt: row.expiresAt };
}

/** A public, non-secret id for a key (used by the one-time issuance response). */
export function keyPublicId(): string {
  return newApiKeyId();
}
