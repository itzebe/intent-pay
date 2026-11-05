import { getStore } from "@/lib/store";
import type { ApiIntentEventRecord, ApiIntentRecord } from "@/lib/store/types";
import { newIntentEventId, newIntentId } from "./ids";
import {
  canTransition,
  isAuthorizedOrBeyond,
  isTerminal,
  STATE_EVENT,
  type IntentState,
} from "./intentLifecycle";
import { enqueueEvent } from "./webhooks";

/**
 * Durable payment-intent storage and lifecycle transitions.
 *
 * The current state is *derived* from the append-only event rows, so the history
 * cannot be rewritten and the state can never be set without a corresponding
 * transition. Every read is scoped by `developerId`, so one tenant can never see
 * or mutate another's intent (tenant isolation is enforced here, at the data
 * layer, not only in the route).
 */

/**
 * How long an intent may sit in a pre-submission state before it expires. After
 * this window a prepared transaction is no longer safe to submit (the quote it
 * was built from is long stale), so the intent is `expired` rather than silently
 * usable.
 */
export const INTENT_TTL_MS = 30 * 60 * 1000;

/** The canonical, order-stable parameter string an intent is bound to. */
export function canonicalParams(intent: Pick<ApiIntentRecord, "chainId" | "recipient" | "receiveToken" | "receiveTokenAddress" | "amountMode" | "amount" | "payToken">): string {
  return JSON.stringify({
    chainId: intent.chainId,
    recipient: intent.recipient.toLowerCase(),
    receiveToken: intent.receiveToken,
    receiveTokenAddress: intent.receiveTokenAddress.toLowerCase(),
    amountMode: intent.amountMode,
    amount: intent.amount,
    payToken: intent.payToken ?? null,
  });
}

/** A short, stable fingerprint of the frozen parameters (for wallet approval). */
export function intentFingerprint(intent: ApiIntentRecord): string {
  const params = intent.authorizedParams ?? canonicalParams(intent);
  let h = 2166136261;
  for (let i = 0; i < params.length; i++) {
    h ^= params.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `int_${(h >>> 0).toString(16).padStart(8, "0")}`;
}

export type CreateIntentInput = {
  developerId: string;
  createdByKeyId: string;
  chainId: number;
  recipient: string;
  receiveToken: string;
  receiveTokenAddress: string;
  amountMode: string;
  amount: string;
  payToken?: string | null;
  reference?: string | null;
  idempotencyKey?: string | null;
};

export type CreateIntentResult =
  | { ok: true; intent: ApiIntentRecord; state: IntentState; created: boolean }
  | { ok: false; code: "idempotency_conflict" };

/**
 * Create an intent (or return the existing one for a repeated idempotency key).
 *
 * The idempotency key is unique per developer at the database level, so two
 * concurrent identical creates cannot both insert — the loser adopts the
 * winner's intent, and the response is byte-identical.
 */
export async function createIntent(input: CreateIntentInput, now = Date.now()): Promise<CreateIntentResult> {
  const store = getStore();
  const key = input.idempotencyKey?.trim() || null;

  if (key) {
    const existing = await store.findOne("apiIntents", { developerId: input.developerId, idempotencyKey: key });
    if (existing) {
      // A reused key must describe the same request; a different body is a
      // conflict, not a silent overwrite.
      if (canonicalParams(existing) !== canonicalParams({ ...input, payToken: input.payToken ?? null } as ApiIntentRecord)) {
        return { ok: false, code: "idempotency_conflict" };
      }
      return { ok: true, intent: existing, state: await currentState(existing.id), created: false };
    }
  }

  const intent: ApiIntentRecord = {
    id: newIntentId(),
    developerId: input.developerId,
    createdByKeyId: input.createdByKeyId,
    chainId: input.chainId,
    recipient: input.recipient.toLowerCase(),
    receiveToken: input.receiveToken,
    receiveTokenAddress: input.receiveTokenAddress.toLowerCase(),
    amountMode: input.amountMode,
    amount: input.amount,
    payToken: input.payToken ?? null,
    reference: input.reference ?? null,
    authorizedParams: null,
    idempotencyKey: key,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await store.insert("apiIntents", intent);
  } catch {
    // Lost a race on the idempotency key — adopt the winner's intent.
    if (key) {
      const winner = await store.findOne("apiIntents", { developerId: input.developerId, idempotencyKey: key });
      if (winner) return { ok: true, intent: winner, state: await currentState(winner.id), created: false };
    }
    throw new Error("Could not create the intent.");
  }

  await appendEvent(intent, "created", null, now);
  // `createIntent` appends the event directly rather than through `transition`,
  // so it must enqueue the webhook itself — otherwise the documented
  // `intent.created` event would never reach a subscriber.
  const createdEvent = STATE_EVENT.created;
  if (createdEvent) {
    await enqueueEvent({
      developerId: intent.developerId,
      event: createdEvent as Parameters<typeof enqueueEvent>[0]["event"],
      data: intentEventData(intent, "created"),
      now,
    });
  }
  return { ok: true, intent, state: "created", created: true };
}

/** The ordered event history for an intent. */
export async function intentEvents(intentId: string): Promise<ApiIntentEventRecord[]> {
  return getStore().findMany("apiIntentEvents", { intentId }, { orderBy: "at", dir: "asc" });
}

/** The current state = the last appended event's state, or `created`. */
export async function currentState(intentId: string): Promise<IntentState> {
  const events = await getStore().findMany("apiIntentEvents", { intentId }, { orderBy: "at", dir: "desc", limit: 1 });
  const last = events[0];
  return (last?.state as IntentState) ?? "created";
}

/** Fetch an intent, scoped to its owner. Returns null when not found/owned. */
export async function getIntent(developerId: string, id: string): Promise<ApiIntentRecord | null> {
  const row = await getStore().findOne("apiIntents", { id });
  if (!row || row.developerId !== developerId) return null;
  return row;
}

/** List a developer's intents, newest first. */
export async function listIntents(developerId: string, limit = 50): Promise<ApiIntentRecord[]> {
  return getStore().findMany("apiIntents", { developerId }, { orderBy: "createdAt", dir: "desc", limit });
}

/**
 * Append a lifecycle event, enforcing the state machine. Returns the new state,
 * or a specific failure so a route can map it to an HTTP status.
 */
export type TransitionResult =
  | { ok: true; state: IntentState }
  | { ok: false; code: "invalid_state" | "expired"; message: string };

export async function transition(
  intent: ApiIntentRecord,
  to: IntentState,
  detail: string | null = null,
  now = Date.now(),
  opts: { silent?: boolean } = {},
): Promise<TransitionResult> {
  const from = await currentState(intent.id);
  if (!canTransition(from, to)) {
    return {
      ok: false,
      code: "invalid_state",
      message: `Cannot move from ${from} to ${to}.`,
    };
  }
  await appendEvent(intent, to, detail, now);
  // Only emit a webhook for a state that has a public event. `silent` is used by
  // the merchant checkout flow, which emits its own order-scoped events
  // (`payment.submitted`, …) instead of the intent-level ones, so a merchant
  // receives exactly one event per fact rather than two.
  const event = STATE_EVENT[to];
  if (event && !opts.silent) {
    await enqueueEvent({
      developerId: intent.developerId,
      event: event as Parameters<typeof enqueueEvent>[0]["event"],
      data: intentEventData(intent, to),
      now,
    });
  }
  return { ok: true, state: to };
}

/** The transaction hashes recorded by `submit`, oldest first. */
export async function submittedTxHashes(intentId: string): Promise<string[]> {
  const events = await getStore().findMany("apiIntentEvents", { intentId }, { orderBy: "at", dir: "asc" });
  const out: string[] = [];
  for (const e of events) {
    if (e.detail?.startsWith("tx:")) {
      for (const h of e.detail.slice(3).split(",")) if (h) out.push(h);
    }
  }
  return out;
}

/** The public data payload for an intent's state-change event. */
export function intentEventData(intent: ApiIntentRecord, state: IntentState): Record<string, unknown> {
  return {
    intentId: intent.id,
    state,
    chainId: intent.chainId,
    recipient: intent.recipient,
    receiveToken: intent.receiveToken,
    receiveTokenAddress: intent.receiveTokenAddress,
    amountMode: intent.amountMode,
    amount: intent.amount,
    payToken: intent.payToken,
    reference: intent.reference,
    fingerprint: intentFingerprint(intent),
  };
}

async function appendEvent(intent: ApiIntentRecord, state: IntentState, detail: string | null, now: number): Promise<void> {
  const store = getStore();
  // Event ordering must be deterministic even when several transitions happen
  // within the same millisecond (a create→validate→validate burst), so the
  // timestamp is made strictly increasing per intent. Without this, two events
  // with an equal `at` sort ambiguously and the derived current state can be
  // wrong.
  const last = await store.findMany("apiIntentEvents", { intentId: intent.id }, { orderBy: "at", dir: "desc", limit: 1 });
  const at = last[0] ? Math.max(now, last[0].at + 1) : now;
  const record: ApiIntentEventRecord = {
    id: newIntentEventId(),
    intentId: intent.id,
    developerId: intent.developerId,
    state,
    at,
    detail,
  };
  await store.insert("apiIntentEvents", record);
  await store.update("apiIntents", { id: intent.id }, { updatedAt: now });
}

/**
 * Freeze the authorized parameters at `awaiting_authorization`. Once set, they
 * are immutable, so a recipient or amount can never change after authorization.
 */
export async function freezeParams(intent: ApiIntentRecord, now = Date.now()): Promise<void> {
  if (intent.authorizedParams) return;
  await getStore().update(
    "apiIntents",
    { id: intent.id },
    { authorizedParams: canonicalParams(intent), updatedAt: now },
  );
  intent.authorizedParams = canonicalParams(intent);
}

/** True when the intent has aged past its TTL while still pre-submission. */
export function isExpired(intent: ApiIntentRecord, now = Date.now()): boolean {
  return now - intent.createdAt > INTENT_TTL_MS;
}

/**
 * Expire an intent that has aged out and is not yet submitted. Idempotent, and
 * a no-op for an already-terminal or already-submitted intent.
 */
export async function expireIfStale(intent: ApiIntentRecord, now = Date.now()): Promise<IntentState> {
  const state = await currentState(intent.id);
  if (isTerminal(state)) return state;
  if (state === "submitted" || state === "confirmed") return state;
  if (!isExpired(intent, now)) return state;
  const result = await transition(intent, "expired", "Intent expired before authorization.", now);
  return result.ok ? result.state : state;
}

export { isAuthorizedOrBeyond };
