import { createHmac, timingSafeEqual } from "node:crypto";
import { getStore } from "@/lib/store";
import type { ApiWebhookDeliveryRecord, ApiWebhookRecord } from "@/lib/store/types";
import { fetchWithTimeout } from "@/lib/server/http";
import { newDeliveryId, newEventId, newWebhookId, newWebhookSecret } from "./ids";
import { isWebhookEvent, type WebhookEvent } from "./intentLifecycle";

/**
 * Secure webhook delivery.
 *
 * Every delivery is signed with the destination's own secret:
 *
 *     X-IntentPay-Signature: t=<unix-seconds>,v1=<hex HMAC-SHA256>
 *
 * where the signed message is `${t}.${rawBody}`. A receiver verifies the HMAC
 * **and** rejects a `t` outside a small tolerance, which is what prevents a
 * captured payload from being replayed later. The `eventId` is stable across a
 * delivery's retries and is also the duplicate-delivery guard (a unique
 * (webhook, event) constraint), so a retried attempt is recognisable as the same
 * event, and a duplicate enqueue is dropped rather than delivered twice.
 *
 * Only `data` the caller passes is sent; the routes build it from public intent
 * fields, so no secret, key or signature ever appears in a payload.
 */

const SIGNATURE_TOLERANCE_SECONDS = 300;
const ATTEMPT_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 2_048;

/**
 * The retry schedule, in seconds, between attempts. Five retries after the
 * first attempt (six total), spanning roughly two hours, which is enough for a
 * transient receiver outage without hammering a dead endpoint forever.
 */
export const RETRY_SCHEDULE_SECONDS = [10, 60, 300, 1_800, 7_200];
export const MAX_ATTEMPTS = RETRY_SCHEDULE_SECONDS.length + 1;

/** The signed header value for a body at a given time. */
export function signatureHeader(secret: string, body: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const mac = createHmac("sha256", secret).update(`${nowSeconds}.${body}`).digest("hex");
  return `t=${nowSeconds},v1=${mac}`;
}

/**
 * Verify a signature header against a raw body. Exposed so the documentation's
 * example and the tests share the exact production rule (timestamp tolerance
 * included). Returns a specific reason on failure.
 */
export function verifySignature(input: {
  secret: string;
  header: string;
  body: string;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): { ok: true } | { ok: false; reason: string } {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  const parts = Object.fromEntries(
    input.header.split(",").map((p) => {
      const i = p.indexOf("=");
      return i >= 0 ? [p.slice(0, i), p.slice(i + 1)] : [p, ""];
    }),
  );
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) return { ok: false, reason: "malformed_signature" };
  if (Math.abs(now - t) > tolerance) return { ok: false, reason: "timestamp_out_of_tolerance" };
  const expected = createHmac("sha256", input.secret).update(`${t}.${input.body}`).digest("hex");
  const a = Buffer.from(v1, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "signature_mismatch" };
  return { ok: true };
}

/** A registered webhook, as returned to the developer (never the secret). */
export type PublicWebhook = Omit<ApiWebhookRecord, "secret" | "events"> & { events: string[] };

function toPublic(record: ApiWebhookRecord): PublicWebhook {
  const { secret: _secret, ...rest } = record;
  return { ...rest, events: record.events === "*" ? ["*"] : record.events.split(",").filter(Boolean) };
}

/** Register a webhook. The signing secret is returned ONCE, here. */
export async function createWebhook(input: {
  developerId: string;
  url: string;
  events: string[];
  description?: string | null;
  now?: number;
}): Promise<{ webhook: PublicWebhook; secret: string }> {
  const now = input.now ?? Date.now();
  const events = input.events.includes("*") ? ["*"] : input.events.filter(isWebhookEvent);
  const record: ApiWebhookRecord = {
    id: newWebhookId(),
    developerId: input.developerId,
    url: input.url,
    description: input.description?.slice(0, 200) ?? null,
    events: events.join(","),
    secret: newWebhookSecret(),
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  await getStore().insert("apiWebhooks", record);
  return { webhook: toPublic(record), secret: record.secret };
}

export async function listWebhooks(developerId: string): Promise<PublicWebhook[]> {
  const rows = await getStore().findMany("apiWebhooks", { developerId }, { orderBy: "createdAt", dir: "desc" });
  return rows.map(toPublic);
}

export async function getWebhook(developerId: string, id: string): Promise<PublicWebhook | null> {
  const row = await getStore().findOne("apiWebhooks", { id });
  if (!row || row.developerId !== developerId) return null;
  return toPublic(row);
}

/** Delete a webhook (and stop its deliveries). Returns false when not found. */
export async function deleteWebhook(developerId: string, id: string): Promise<boolean> {
  const store = getStore();
  const row = await store.findOne("apiWebhooks", { id });
  if (!row || row.developerId !== developerId) return false;
  await store.remove("apiWebhookDeliveries", { webhookId: id });
  await store.remove("apiWebhooks", { id });
  return true;
}

/** A delivery attempt's honest outcome. */
export type DeliveryOutcome = { delivered: boolean; statusCode: number | null; error: string | null };

/**
 * Attempt one delivery. Performs the signed POST and reports what actually
 * happened. Never throws: a transport failure is a failed attempt, not a crash.
 */
export async function attemptDelivery(
  webhook: ApiWebhookRecord,
  delivery: ApiWebhookDeliveryRecord,
  now = Date.now(),
): Promise<DeliveryOutcome> {
  const ts = Math.floor(now / 1000);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "IntentPay-Webhooks/1",
    "X-IntentPay-Event": delivery.event,
    "X-IntentPay-Event-Id": delivery.eventId,
    "X-IntentPay-Delivery": delivery.id,
    "X-IntentPay-Timestamp": String(ts),
    "X-IntentPay-Signature": signatureHeader(webhook.secret, delivery.payload, ts),
  };
  try {
    const res = await fetchWithTimeout(webhook.url, {
      method: "POST",
      headers,
      body: delivery.payload,
      timeoutMs: ATTEMPT_TIMEOUT_MS,
      redirect: "error", // never follow a redirect to an internal address
    });
    // Drain a bounded amount of the body so the connection can be reused.
    try {
      const text = await res.text();
      void text.slice(0, MAX_RESPONSE_BYTES);
    } catch {
      /* ignore */
    }
    if (res.status >= 200 && res.status < 300) {
      return { delivered: true, statusCode: res.status, error: null };
    }
    return { delivered: false, statusCode: res.status, error: `Endpoint returned ${res.status}.` };
  } catch (err) {
    return { delivered: false, statusCode: null, error: (err as Error)?.name === "AbortError" ? "Delivery timed out." : "Delivery failed." };
  }
}

/** The next attempt time for a delivery that has made `attempts` attempts. */
export function nextAttemptAt(attempts: number, now = Date.now()): number | null {
  const idx = attempts - 1;
  if (idx >= RETRY_SCHEDULE_SECONDS.length) return null;
  return now + RETRY_SCHEDULE_SECONDS[idx] * 1000;
}

/**
 * Enqueue an event for every matching active webhook of a developer.
 *
 * Each webhook gets its own delivery row with a fresh `eventId`; the unique
 * (webhook, event) constraint drops a duplicate enqueue rather than delivering
 * twice. Returns the created deliveries (for tests and for an immediate drain).
 */
export async function enqueueEvent(input: {
  developerId: string;
  event: WebhookEvent;
  data: Record<string, unknown>;
  now?: number;
}): Promise<ApiWebhookDeliveryRecord[]> {
  const now = input.now ?? Date.now();
  const store = getStore();
  const hooks = await store.findMany("apiWebhooks", { developerId: input.developerId, status: "active" });
  const created: ApiWebhookDeliveryRecord[] = [];
  for (const hook of hooks) {
    const subscribed = hook.events === "*" || hook.events.split(",").includes(input.event);
    if (!subscribed) continue;
    const eventId = newEventId();
    const payload = JSON.stringify({
      id: eventId,
      type: input.event,
      createdAt: new Date(now).toISOString(),
      data: input.data,
    });
    const delivery: ApiWebhookDeliveryRecord = {
      id: newDeliveryId(),
      webhookId: hook.id,
      developerId: input.developerId,
      event: input.event,
      eventId,
      payload,
      status: "pending",
      attempts: 0,
      nextAttemptAt: now,
      lastAttemptAt: null,
      lastStatusCode: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await store.insert("apiWebhookDeliveries", delivery);
      created.push(delivery);
    } catch {
      // A duplicate (webhook, event) is dropped — never delivered twice.
    }
  }
  return created;
}

/**
 * Deliver every delivery that is due now. Runs each attempt, updates the row,
 * and schedules a retry (or marks it failed once the schedule is exhausted).
 * Returns a summary; never throws.
 */
export async function deliverDue(
  now = Date.now(),
  opts: { limit?: number } = {},
): Promise<{ attempted: number; delivered: number; failed: number; retried: number }> {
  const store = getStore();
  const limit = opts.limit ?? 25;
  const due = await store.findMany("apiWebhookDeliveries", { status: "pending" }, { orderBy: "nextAttemptAt", dir: "asc", limit });
  let attempted = 0;
  let delivered = 0;
  let failed = 0;
  let retried = 0;
  for (const delivery of due) {
    if (delivery.nextAttemptAt !== null && delivery.nextAttemptAt > now) continue;
    const hook = await store.findOne("apiWebhooks", { id: delivery.webhookId });
    if (!hook || hook.status !== "active") {
      // A deleted/disabled webhook's pending deliveries are retired.
      await store.update("apiWebhookDeliveries", { id: delivery.id }, { status: "failed", nextAttemptAt: null, lastError: "Webhook removed.", updatedAt: now });
      failed++;
      continue;
    }
    attempted++;
    const outcome = await attemptDelivery(hook, delivery, now);
    const attempts = delivery.attempts + 1;
    if (outcome.delivered) {
      delivered++;
      await store.update(
        "apiWebhookDeliveries",
        { id: delivery.id },
        { status: "delivered", attempts, nextAttemptAt: null, lastAttemptAt: now, lastStatusCode: outcome.statusCode, lastError: null, updatedAt: now },
      );
      continue;
    }
    const next = nextAttemptAt(attempts, now);
    if (next === null) {
      failed++;
      await store.update(
        "apiWebhookDeliveries",
        { id: delivery.id },
        { status: "failed", attempts, nextAttemptAt: null, lastAttemptAt: now, lastStatusCode: outcome.statusCode, lastError: outcome.error, updatedAt: now },
      );
    } else {
      retried++;
      await store.update(
        "apiWebhookDeliveries",
        { id: delivery.id },
        { status: "pending", attempts, nextAttemptAt: next, lastAttemptAt: now, lastStatusCode: outcome.statusCode, lastError: outcome.error, updatedAt: now },
      );
    }
  }
  return { attempted, delivered, failed, retried };
}

/** The delivery history for a developer (or a single webhook), newest first. */
export async function listDeliveries(developerId: string, webhookId?: string, limit = 50): Promise<ApiWebhookDeliveryRecord[]> {
  const where = webhookId ? { developerId, webhookId } : { developerId };
  return getStore().findMany("apiWebhookDeliveries", where, { orderBy: "createdAt", dir: "desc", limit });
}
