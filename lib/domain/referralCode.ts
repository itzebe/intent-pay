import { REFERRAL_PREFIX } from "@/lib/config/referral";

/**
 * Referral code generation and validation — pure and dependency-free.
 *
 * Codes use a Crockford-style alphabet that omits look-alike characters (0/O,
 * 1/I/L) so a code read aloud or typed from a screenshot is unambiguous. The
 * alphabet is 31 symbols, so 6 characters carry ~29.7 bits of entropy — enough
 * that codes are not enumerable, and short enough to share.
 *
 * A code reveals nothing: it is not derived from a wallet address, a database
 * row id, or any user data. Uniqueness is enforced by the database (the code is
 * the primary key of `referral_codes`), and `generateUniqueCode` retries on
 * collision rather than trusting a pre-check.
 */

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const BODY_LENGTH = 6;

/**
 * A cryptographically secure random body (never Math.random).
 *
 * The alphabet is 31 symbols, so a 5-bit draw (0–31) is not uniform and index 31
 * is out of range — that produced `undefined` inside a code and an intermittently
 * invalid referral link. We draw a byte and reject any value >= the alphabet
 * length, so every symbol is equally likely and every code is valid.
 */
function randomBody(): string {
  const alphabetSize = ALPHABET.length;
  let out = "";
  while (out.length < BODY_LENGTH) {
    const bytes = new Uint8Array(BODY_LENGTH * 2);
    globalThis.crypto.getRandomValues(bytes);
    for (let i = 0; i < bytes.length && out.length < BODY_LENGTH; i++) {
      const draw = bytes[i];
      // Reject the tail that would bias the distribution (and can't index the
      // alphabet): 256 is not a multiple of 31, so 256 % 31 values are dropped.
      if (draw >= Math.floor(256 / alphabetSize) * alphabetSize) continue;
      out += ALPHABET[draw % alphabetSize];
    }
  }
  return out;
}

/** A fresh code of the form INTENT-XXXXXX. */
export function generateCode(): string {
  return `${REFERRAL_PREFIX}-${randomBody()}`;
}

/** Normalise user input to the canonical code form (upper-case, trimmed). */
export function normalizeCode(input: string | undefined | null): string | null {
  if (!input || typeof input !== "string") return null;
  const trimmed = input.trim().toUpperCase();
  if (!trimmed) return null;
  // Accept with or without the prefix separator; re-add it canonically.
  const body = trimmed.startsWith(`${REFERRAL_PREFIX}-`)
    ? trimmed.slice(REFERRAL_PREFIX.length + 1)
    : trimmed.startsWith(REFERRAL_PREFIX)
      ? trimmed.slice(REFERRAL_PREFIX.length)
      : trimmed;
  if (body.length !== BODY_LENGTH) return null;
  for (const ch of body) {
    if (!ALPHABET.includes(ch)) return null;
  }
  return `${REFERRAL_PREFIX}-${body}`;
}

export function isValidCode(input: string | undefined | null): boolean {
  return normalizeCode(input) !== null;
}

/** Build the shareable URL for a code from a trusted origin. */
export function referralUrl(origin: string, code: string): string {
  const base = origin.replace(/\/$/, "");
  return `${base}/?ref=${encodeURIComponent(code)}`;
}

/**
 * Generate a code that the `isTaken` probe says is free, retrying on collision.
 * `isTaken` is expected to hit the database's unique index; a race that slips
 * through is caught by the insert itself (the caller handles the conflict).
 */
export function generateUniqueCode(isTaken: (code: string) => boolean, maxTries = 8): string {
  for (let i = 0; i < maxTries; i++) {
    const code = generateCode();
    if (!isTaken(code)) return code;
  }
  throw new Error("Could not allocate a unique referral code.");
}
