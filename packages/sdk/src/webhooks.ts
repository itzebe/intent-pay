/**
 * Webhook signature verification.
 *
 * A delivery carries:
 *
 *     X-IntentPay-Signature: t=<unix-seconds>,v1=<hex HMAC-SHA256>
 *
 * where the signed message is `${t}.${rawBody}` and the key is the webhook's
 * signing secret (returned once at registration). Verifying the HMAC *and*
 * rejecting a `t` outside a small tolerance is what stops a captured payload
 * from being replayed later.
 *
 * This module is deliberately dependency-free and uses only the Web Crypto API,
 * so it runs unchanged in Node, in an edge function, in Bun, and in Deno. Pass
 * the **raw** request body (the exact bytes received), never a re-serialized
 * object — re-encoding changes the bytes and breaks the signature.
 */

export type VerifyWebhookInput = {
  /** The webhook's signing secret (the `whsec_…` value). */
  secret: string;
  /** The full `X-IntentPay-Signature` header value. */
  signature: string;
  /** The exact raw request body as a string. */
  body: string;
  /** Current time in seconds. Defaults to `Date.now()/1000`. */
  nowSeconds?: number;
  /** Allowed clock skew in seconds. Default 300. */
  toleranceSeconds?: number;
};

export type VerifyWebhookResult = { ok: true } | { ok: false; reason: WebhookVerifyFailure };

export type WebhookVerifyFailure =
  | "missing_signature"
  | "malformed_signature"
  | "timestamp_out_of_tolerance"
  | "signature_mismatch";

/** The default clock-skew tolerance, matching the server's 5 minutes. */
export const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 300;

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Constant-time string comparison that does not leak length via early return. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Compute the expected `v1` hex digest for a body at a given time. */
export async function computeWebhookSignature(secret: string, body: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${nowSeconds}.${body}`));
  return toHex(mac);
}

/** Parse a `t=…,v1=…` header into its parts. */
export function parseSignatureHeader(header: string): { t?: number | undefined; v1?: string | undefined } {
  const parts: Record<string, string> = {};
  for (const piece of (header ?? "").split(",")) {
    const i = piece.indexOf("=");
    if (i >= 0) parts[piece.slice(0, i).trim()] = piece.slice(i + 1).trim();
  }
  const t = parts.t !== undefined ? Number(parts.t) : undefined;
  return { ...(Number.isFinite(t) ? { t } : {}), ...(parts.v1 ? { v1: parts.v1 } : {}) };
}

/**
 * Verify a webhook signature.
 *
 * Returns a specific reason on failure so a receiver can log *why* a delivery
 * was rejected — never a bare boolean.
 */
export async function verifyWebhookSignature(input: VerifyWebhookInput): Promise<VerifyWebhookResult> {
  if (!input.signature) return { ok: false, reason: "missing_signature" };
  const { t, v1 } = parseSignatureHeader(input.signature);
  if (t === undefined || !v1) return { ok: false, reason: "malformed_signature" };

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? DEFAULT_SIGNATURE_TOLERANCE_SECONDS;
  if (Math.abs(now - t) > tolerance) return { ok: false, reason: "timestamp_out_of_tolerance" };

  const expected = await computeWebhookSignature(input.secret, input.body, t);
  if (!constantTimeEqual(v1, expected)) return { ok: false, reason: "signature_mismatch" };
  return { ok: true };
}
