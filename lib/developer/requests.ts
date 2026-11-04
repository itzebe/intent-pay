import { isEvmAddress } from "@/lib/format";
import type { ApiIntentRecord, ApiWebhookDeliveryRecord } from "@/lib/store/types";
import type { IntentState } from "./intentLifecycle";

/**
 * Request parsing and public serialization for the developer API.
 *
 * Parsing is strict and explicit: an unexpected type is a 400, never a coercion.
 * Serialization is deliberately narrow — a record is mapped to exactly the
 * fields an integrator needs, so a future internal column can never leak into an
 * API response by accident, and a secret is never in the shape to begin with.
 */

export const MAX_AMOUNT_LEN = 40;
export const MAX_REFERENCE_LEN = 120;
export const MAX_IDEMPOTENCY_LEN = 200;
export const MAX_URL_LEN = 2_048;

/** A validated create-intent request. */
export type ParsedCreateIntent = {
  recipient: string;
  receiveToken: string;
  amount: string;
  amountMode: "recipient_receives" | "i_spend";
  chainId: number;
  payToken: string | null;
  reference: string | null;
  idempotencyKey: string | null;
};

export type ParseError = { ok: false; code: "invalid_request" | "invalid_chain"; message: string; detail?: string };

export function parseCreateIntent(body: Record<string, unknown>, headerIdempotencyKey?: string | null): ParsedCreateIntent | ParseError {
  const recipient = typeof body.recipient === "string" ? body.recipient.trim() : "";
  const receiveToken = typeof body.receiveToken === "string" ? body.receiveToken.trim() : "";
  const amount = typeof body.amount === "string" ? body.amount.trim() : "";
  const amountMode = body.amountMode;

  if (!isEvmAddress(recipient)) {
    return { ok: false, code: "invalid_request", message: "`recipient` must be a valid Monad address.", detail: "recipient" };
  }
  if (!receiveToken) {
    return { ok: false, code: "invalid_request", message: "`receiveToken` is required.", detail: "receiveToken" };
  }
  if (!amount) {
    return { ok: false, code: "invalid_request", message: "`amount` is required.", detail: "amount" };
  }
  if (amount.length > MAX_AMOUNT_LEN) {
    return { ok: false, code: "invalid_request", message: "`amount` is too long.", detail: "amount" };
  }
  if (amountMode !== "recipient_receives" && amountMode !== "i_spend") {
    return { ok: false, code: "invalid_request", message: "`amountMode` must be `recipient_receives` or `i_spend`.", detail: "amountMode" };
  }

  // The chain is explicit and fixed: an unknown chain is refused, never assumed.
  const chainId = body.chainId === undefined ? 143 : Number(body.chainId);
  if (chainId !== 143) {
    return { ok: false, code: "invalid_chain", message: "Only Monad Mainnet (chainId 143) is supported.", detail: "chainId" };
  }

  const payToken = typeof body.payToken === "string" && body.payToken.trim() ? body.payToken.trim() : null;
  const reference = typeof body.reference === "string" && body.reference.trim() ? body.reference.trim().slice(0, MAX_REFERENCE_LEN) : null;
  const bodyKey = typeof body.idempotencyKey === "string" && body.idempotencyKey.trim() ? body.idempotencyKey.trim().slice(0, MAX_IDEMPOTENCY_LEN) : null;
  const idempotencyKey = (headerIdempotencyKey?.trim().slice(0, MAX_IDEMPOTENCY_LEN) || bodyKey) ?? null;

  return { recipient, receiveToken, amount, amountMode, chainId, payToken, reference, idempotencyKey };
}

/** The public representation of an intent. */
export function publicIntent(record: ApiIntentRecord, state: IntentState) {
  return {
    id: record.id,
    object: "intent",
    state,
    chainId: record.chainId,
    recipient: record.recipient,
    receiveToken: record.receiveToken,
    receiveTokenAddress: record.receiveTokenAddress,
    amountMode: record.amountMode,
    amount: record.amount,
    payToken: record.payToken,
    reference: record.reference,
    authorized: record.authorizedParams !== null,
    createdAt: new Date(record.createdAt).toISOString(),
    updatedAt: new Date(record.updatedAt).toISOString(),
  };
}

/** The public representation of a webhook (never the secret). */
export function publicWebhook(record: { id: string; url: string; description: string | null; events: string[]; status: string; createdAt: number }) {
  return {
    id: record.id,
    object: "webhook",
    url: record.url,
    description: record.description,
    events: record.events,
    status: record.status,
    createdAt: new Date(record.createdAt).toISOString(),
  };
}

/** The public representation of a delivery attempt. */
export function publicDelivery(record: ApiWebhookDeliveryRecord) {
  return {
    id: record.id,
    object: "webhook_delivery",
    webhookId: record.webhookId,
    event: record.event,
    eventId: record.eventId,
    status: record.status,
    attempts: record.attempts,
    lastStatusCode: record.lastStatusCode,
    lastError: record.lastError,
    nextAttemptAt: record.nextAttemptAt ? new Date(record.nextAttemptAt).toISOString() : null,
    createdAt: new Date(record.createdAt).toISOString(),
  };
}

/**
 * Validate a webhook URL. HTTPS only (a signature over plain HTTP proves
 * nothing), and a well-formed absolute URL. Private/loopback hosts are not
 * blocked here — an integrator may legitimately run a receiver on a private
 * network behind their own gateway — but the delivery fetch never follows a
 * redirect, so a public URL cannot be bounced to an internal one.
 */
export function validateWebhookUrl(url: string): { ok: true; url: string } | { ok: false; message: string } {
  const value = (url ?? "").trim();
  if (!value || value.length > MAX_URL_LEN) return { ok: false, message: "A webhook URL is required." };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, message: "That isn't a valid URL." };
  }
  if (parsed.protocol !== "https:") return { ok: false, message: "A webhook URL must use HTTPS." };
  return { ok: true, url: parsed.toString() };
}
