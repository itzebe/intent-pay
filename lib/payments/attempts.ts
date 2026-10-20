"use client";

import { displayKey } from "@/lib/domain/canonicalIntent";

/**
 * Payment-attempt correlation, client side.
 *
 * The attempt id is a *correlation handle*, not a security boundary: the wallet
 * signs and broadcasts directly, so the server cannot gate a transaction. The
 * value here is operational — one id ties preparation, signing, submission and
 * receipt handling together for support and reconciliation.
 *
 * Every call is best-effort and must never throw: a telemetry outage cannot be
 * allowed to break a payment. All functions swallow their own errors.
 */

export type AttemptStageEvent =
  | "prepared"
  | "signing"
  | "submitted"
  | "confirmed"
  | "reverted"
  | "failed"
  | "rejected"
  | "unknown";

/**
 * Hard bounds on correlation calls. The wallet confirmation must never wait on
 * telemetry: a slow attempt endpoint is treated exactly like an unavailable one
 * (id = null, correlation simply skipped).
 */
const BEGIN_TIMEOUT_MS = 3000;
const REPORT_TIMEOUT_MS = 4000;

export type BeginAttemptInput = {
  account?: string | null;
  intentKey: string;
  receiveToken?: string | null;
  payToken?: string | null;
  gasMode?: string | null;
  provider?: string | null;
  idempotencyKey?: string | null;
};

/** Stable intent fingerprint used as the server-side correlation key. */
export function attemptIntentKey(intent: Parameters<typeof displayKey>[0]): string {
  return displayKey(intent);
}

/**
 * A stable idempotency key for one account + intent version. Retrying the same
 * payment reuses the same server-side attempt instead of creating a new one, so
 * a retry never shows up as a second, distinct payment attempt.
 */
export function attemptIdempotencyKey(account: string, intent: Parameters<typeof displayKey>[0]): string {
  const version = (intent as { version?: number }).version ?? 0;
  return `${account.toLowerCase()}:${version}:${displayKey(intent)}`;
}

/** Start an attempt. Returns the id, or null if correlation is unavailable. */
export async function beginAttempt(
  input: BeginAttemptInput,
  opts?: { timeoutMs?: number },
): Promise<string | null> {
  // Correlation must never gate a payment. A slow or hanging telemetry call
  // would otherwise delay the wallet confirmation indefinitely, so bound it.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? BEGIN_TIMEOUT_MS);
  try {
    const res = await fetch("/api/payments/attempts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
    const json = await res.json();
    return json?.ok && typeof json.id === "string" ? json.id : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Advance an attempt's stage. Never throws and never blocks: a telemetry write
 * must not sit between the user and their wallet, so it is bounded and
 * fire-and-forget.
 */
export async function reportAttempt(
  id: string | null,
  event: AttemptStageEvent,
  extra?: { code?: string; txHash?: string; userOpHash?: string; diagnostic?: string },
  opts?: { timeoutMs?: number },
): Promise<void> {
  if (!id) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? REPORT_TIMEOUT_MS);
  try {
    await fetch("/api/payments/attempts/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, event, ...extra }),
      signal: controller.signal,
    });
  } catch {
    /* correlation is best-effort */
  } finally {
    clearTimeout(timer);
  }
}
