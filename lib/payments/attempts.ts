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

/** Start an attempt. Returns the id, or null if correlation is unavailable. */
export async function beginAttempt(input: BeginAttemptInput): Promise<string | null> {
  try {
    const res = await fetch("/api/payments/attempts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const json = await res.json();
    return json?.ok && typeof json.id === "string" ? json.id : null;
  } catch {
    return null;
  }
}

/** Advance an attempt's stage. Never throws. */
export async function reportAttempt(
  id: string | null,
  event: AttemptStageEvent,
  extra?: { code?: string; txHash?: string; userOpHash?: string; diagnostic?: string },
): Promise<void> {
  if (!id) return;
  try {
    await fetch("/api/payments/attempts/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, event, ...extra }),
    });
  } catch {
    /* correlation is best-effort */
  }
}
