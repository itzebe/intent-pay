import { randomUUID } from "node:crypto";
import { getStore } from "@/lib/store";
import { estimateCostUsd, monthlyBudgetUsd, recordUsage, checkBudgetAlert, utcDay } from "@/lib/server/cost";
import { recordOpsEvent } from "@/lib/server/ops";
import {
  llmConfig,
  extractIntentHint,
  LLM_MAX_INPUT_TOKENS_ESTIMATE,
  LLM_MAX_OUTPUT_TOKENS,
} from "@/lib/nlp/llm";
import type { ParseHint } from "@/lib/nlp/parser";
import { HELD_PREFIX, SPENT_PREFIX } from "./aiBudgetKeys";

// Re-exported so callers (and tests) get the counter namespaces from one place.
export { HELD_PREFIX, SPENT_PREFIX } from "./aiBudgetKeys";

/**
 * A hard, concurrency-safe spending limit for the optional intent LLM.
 *
 * The advisory budget check (`budgetState`) reads a rollup that lags reality, so
 * concurrent requests all see "under budget" and all proceed — that is a soft
 * alert, not a limit. This module is the limit.
 *
 * The mechanism is an atomic *reservation* against the worst-case cost of a call,
 * reconciled to the actual cost when the call returns:
 *
 *   1. Before the call, atomically add the worst-case cost to a per-month
 *      `held` counter (`Store.incrementInt`, a single statement). No two callers
 *      can read the same value, so a burst cannot all pass a stale check.
 *   2. Admission is `spent + held <= budget`, where `spent` is a *separate*
 *      atomic counter incremented only by settled actual cost. Because every
 *      in-flight call holds its worst case and the counters are monotonic, the
 *      number of simultaneous calls is bounded by `budget / worstCase` and total
 *      spend can never exceed the budget.
 *   3. On return, add the actual cost to `spent` and release the difference from
 *      `held` (a no-op increment when actual == reserved). On failure or an
 *      abandoned call, release the whole reservation.
 *
 * Reservations are keyed by a short time window, so a reservation leaked by a
 * crashed process ages out of the lookback instead of consuming budget forever;
 * the maintenance sweep also removes the dead rows. Every exit path (success,
 * failure, throw) settles or releases, so nothing is held on a normal request.
 *
 * Failure policy: the LLM is optional, so a budget or store failure *skips the
 * paid call* and the deterministic parser continues — it never fails open and it
 * never blocks a payment. A store outage therefore means "no LLM", not "no limit".
 */

/** USD is stored as integer micro-dollars (1e-6) so the counters stay integral. */
const MICRO = 1_000_000;
/**
 * The window a reservation lives in. A leaked reservation is counted for this
 * window and the next, then forgotten; settlements normally happen within the
 * LLM timeout (a few seconds), so two windows is ample.
 */
export const RESERVATION_WINDOW_MS = 5 * 60 * 1000;

/** The held-counter key for a month + window index. */
export function heldKey(month: string, windowIndex: number): string {
  return `${HELD_PREFIX}:${month}:${windowIndex}`;
}
/** The spent-counter key for a month. */
export function spentKey(month: string): string {
  return `${SPENT_PREFIX}:${month}`;
}

/** The worst-case cost of one intent-extraction call, in micro-USD (>= 1). */
export function reservationMicro(model: string): number {
  const worst = estimateCostUsd(model, LLM_MAX_INPUT_TOKENS_ESTIMATE, LLM_MAX_OUTPUT_TOKENS);
  return Math.max(1, Math.round(worst * MICRO));
}

export type BudgetReservation = {
  id: string;
  /** Reserved worst case, micro-USD. 0 when no budget is configured. */
  amountMicro: number;
  heldKey: string;
  spentKey: string;
  /** False when no budget is configured — nothing was held. */
  enforced: boolean;
};

export type ReserveOutcome =
  | { ok: true; reservation: BudgetReservation }
  | { ok: false; reason: "budget_exhausted" | "store_unavailable" };

function monthOf(now: number): string {
  return utcDay(now).slice(0, 7);
}

/**
 * Atomically reserve the worst-case cost of one call. Returns a reservation, or
 * a refusal (`budget_exhausted` / `store_unavailable`). Never throws.
 */
export async function reserveLlmBudget(opts: { model: string; now?: number }): Promise<ReserveOutcome> {
  const now = opts.now ?? Date.now();
  const month = monthOf(now);
  const skey = spentKey(month);
  const windowIndex = Math.floor(now / RESERVATION_WINDOW_MS);
  const hkey = heldKey(month, windowIndex);
  const amountMicro = reservationMicro(opts.model);

  let budget: number | null;
  try {
    budget = await monthlyBudgetUsd();
  } catch {
    return { ok: false, reason: "store_unavailable" };
  }

  // No budget configured: enforcement is off (preserves the prior behaviour).
  // Nothing is held, but the reservation still settles usage for reporting.
  if (budget === null) {
    return { ok: true, reservation: { id: randomUUID(), amountMicro: 0, heldKey: hkey, spentKey: skey, enforced: false } };
  }

  const budgetMicro = Math.round(budget * MICRO);
  const store = getStore();
  try {
    // The previous window's hold is closed (no new increments) and only ever
    // decreases, so its snapshot is a safe upper bound. The current window's
    // value comes back exact from the atomic increment.
    const prev = await store.findOne("counters", { key: heldKey(month, windowIndex - 1) });
    const prevMicro = prev?.value ?? 0;
    const curAfter = await store.incrementInt("counters", { key: hkey }, "value", amountMicro, {
      key: hkey,
      value: amountMicro,
      updatedAt: now,
    });
    const spent = await store.findOne("counters", { key: skey });
    const spentMicro = spent?.value ?? 0;
    // Over-estimates the true effective spend (monotonic counters), so admission
    // is conservative: it can refuse a borderline call but never overspends.
    const effectiveMicro = spentMicro + prevMicro + curAfter;
    if (effectiveMicro > budgetMicro) {
      await store.incrementInt("counters", { key: hkey }, "value", -amountMicro, {
        key: hkey,
        value: 0,
        updatedAt: now,
      });
      return { ok: false, reason: "budget_exhausted" };
    }
    return { ok: true, reservation: { id: randomUUID(), amountMicro, heldKey: hkey, spentKey: skey, enforced: true } };
  } catch {
    return { ok: false, reason: "store_unavailable" };
  }
}

/** Release a reservation that produced no usage (failure / abandonment). */
export async function releaseLlmBudget(reservation: BudgetReservation, now = Date.now()): Promise<void> {
  if (reservation.amountMicro === 0) return;
  try {
    await getStore().incrementInt("counters", { key: reservation.heldKey }, "value", -reservation.amountMicro, {
      key: reservation.heldKey,
      value: 0,
      updatedAt: now,
    });
  } catch {
    // The window ages out; nothing else to do.
  }
}

/**
 * Reconcile a reservation with the actual usage: record the true cost into the
 * atomic spent counter (the enforcement source of truth) and the reporting
 * rollup, then release the reserved-vs-actual difference.
 */
export async function settleLlmBudget(
  reservation: BudgetReservation,
  usage: { model: string; inputTokens: number; outputTokens: number },
  now = Date.now(),
): Promise<void> {
  const actualUsd = estimateCostUsd(usage.model, usage.inputTokens, usage.outputTokens);
  const actualMicro = Math.max(0, Math.round(actualUsd * MICRO));
  const store = getStore();
  await store.incrementInt("counters", { key: reservation.spentKey }, "value", actualMicro, {
    key: reservation.spentKey,
    value: actualMicro,
    updatedAt: now,
  });
  await recordUsage({
    provider: "intent-llm",
    kind: "intent_extract",
    model: usage.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    estimatedCostUsd: actualUsd,
    at: now,
  });
  // Release the *whole* reservation: `held` tracks only outstanding reservations,
  // while the actual cost now lives in `spent`. Releasing merely the difference
  // would leave `actual` held *and* counted as spent — a double count that would
  // ratchet the effective spend up on every call.
  if (reservation.amountMicro !== 0) {
    await store.incrementInt("counters", { key: reservation.heldKey }, "value", -reservation.amountMicro, {
      key: reservation.heldKey,
      value: 0,
      updatedAt: now,
    });
  }
}

/** The current budget state for reporting: spent + held against the configured budget. */
export async function llmBudgetSnapshot(now = Date.now()): Promise<{
  budgetUsd: number | null;
  spentUsd: number;
  heldUsd: number;
  remainingUsd: number | null;
  enforced: boolean;
}> {
  const month = monthOf(now);
  const budget = await monthlyBudgetUsd();
  const store = getStore();
  const windowIndex = Math.floor(now / RESERVATION_WINDOW_MS);
  const spent = await store.findOne("counters", { key: spentKey(month) });
  const heldCur = await store.findOne("counters", { key: heldKey(month, windowIndex) });
  const heldPrev = await store.findOne("counters", { key: heldKey(month, windowIndex - 1) });
  const spentUsd = (spent?.value ?? 0) / MICRO;
  const heldUsd = ((heldCur?.value ?? 0) + (heldPrev?.value ?? 0)) / MICRO;
  return {
    budgetUsd: budget,
    spentUsd,
    heldUsd,
    remainingUsd: budget === null ? null : Math.max(0, budget - spentUsd - heldUsd),
    enforced: budget !== null,
  };
}

/** The injectable LLM caller, so tests can drive success/failure deterministically. */
export type IntentHintCaller = (
  text: string,
  symbols: string[],
  onUsage?: (usage: { model: string; inputTokens: number; outputTokens: number }) => void | Promise<void>,
) => Promise<ParseHint | null>;

/**
 * Run the optional LLM extraction behind the hard budget. Returns the hint, or
 * null when there is no LLM configured, the budget is exhausted, the store is
 * unavailable, or the provider fails — in every one of those cases the caller's
 * deterministic parse proceeds unchanged.
 */
export async function runBudgetedIntentHint(
  text: string,
  symbols: string[],
  opts?: { now?: number; caller?: IntentHintCaller },
): Promise<ParseHint | null> {
  const cfg = llmConfig();
  if (!cfg) return null;
  const now = opts?.now ?? Date.now();
  const outcome = await reserveLlmBudget({ model: cfg.model, now });
  if (!outcome.ok) {
    // The paid call is skipped, not failed open. The payment flow is unaffected.
    await safeOps(
      outcome.reason === "budget_exhausted"
        ? "AI budget exhausted; skipped optional LLM inference."
        : "AI budget store unavailable; skipped optional LLM inference.",
    );
    return null;
  }

  const reservation = outcome.reservation;
  const caller = opts?.caller ?? extractIntentHint;
  let settled = false;
  try {
    const hint = await caller(text, symbols, async (usage) => {
      settled = true;
      await settleLlmBudget(reservation, usage, now);
      const alert = await checkBudgetAlert(now);
      if (alert) {
        await safeOps(
          `AI budget threshold reached: ${alert.level} (${Math.round(alert.fraction * 100)}% of $${alert.budgetUsd}).`,
          alert.level === "critical" ? "critical" : "warning",
        );
      }
    });
    // A success that never reported usage (e.g. a provider that omits it) must
    // still release the hold so it cannot linger.
    if (!settled) await releaseLlmBudget(reservation, now);
    return hint;
  } catch {
    if (!settled) await releaseLlmBudget(reservation, now);
    return null;
  }
}

async function safeOps(message: string, severity: "warning" | "critical" = "warning"): Promise<void> {
  try {
    await recordOpsEvent({ category: "unknown_error", service: "api/nlp", message, severity, unresolved: true });
  } catch {
    // Telemetry must never affect the flow.
  }
}
