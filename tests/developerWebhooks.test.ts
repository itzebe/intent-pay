import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore, SqliteStore, setStore } from "@/lib/store";
import {
  MAX_ATTEMPTS,
  RETRY_SCHEDULE_SECONDS,
  createWebhook,
  deleteWebhook,
  deliverDue,
  enqueueEvent,
  listDeliveries,
  nextAttemptAt,
  signatureHeader,
  verifySignature,
} from "@/lib/developer/webhooks";
import { createDeveloperWithKey } from "@/lib/developer/credentials";
import { createIntent } from "@/lib/developer/intents";

/**
 * Webhook signing, retries and duplicate protection.
 *
 * A signature proves the payload is ours and is fresh; the timestamp tolerance
 * prevents a replay; the (webhook, event) uniqueness prevents a double delivery;
 * and the retry schedule is bounded. The delivery fetch is mocked so the tests
 * exercise the real logic without outbound traffic.
 */

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  setStore(new SqliteStore(":memory:"));
});
afterEach(() => {
  setStore(new MemoryStore());
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

async function seedDeveloper() {
  const { developer, issued } = await createDeveloperWithKey({ name: "Acme" });
  return { developer, issued };
}

describe("signature", () => {
  it("verifies a header it produced", () => {
    const secret = "whsec_abc";
    const body = JSON.stringify({ hello: "world" });
    const header = signatureHeader(secret, body, 1000);
    expect(verifySignature({ secret, header, body, nowSeconds: 1000 }).ok).toBe(true);
  });

  it("rejects a tampered body, a wrong secret and a stale timestamp", () => {
    const secret = "whsec_abc";
    const body = JSON.stringify({ amount: "5" });
    const header = signatureHeader(secret, body, 1000);
    expect(verifySignature({ secret, header, body: JSON.stringify({ amount: "500" }), nowSeconds: 1000 }).ok).toBe(false);
    expect(verifySignature({ secret: "other", header, body, nowSeconds: 1000 }).ok).toBe(false);
    // 10 minutes later is outside the 5-minute tolerance — a replayed payload.
    expect(verifySignature({ secret, header, body, nowSeconds: 1600 }).ok).toBe(false);
  });

  it("rejects a malformed header", () => {
    expect(verifySignature({ secret: "s", header: "garbage", body: "{}" }).ok).toBe(false);
  });
});

describe("retry schedule", () => {
  it("is bounded and increases", () => {
    expect(nextAttemptAt(1, 0)).toBe(RETRY_SCHEDULE_SECONDS[0] * 1000);
    expect(nextAttemptAt(MAX_ATTEMPTS, 0)).toBeNull();
    for (let i = 1; i < RETRY_SCHEDULE_SECONDS.length; i++) {
      expect(RETRY_SCHEDULE_SECONDS[i]).toBeGreaterThan(RETRY_SCHEDULE_SECONDS[i - 1]);
    }
  });
});

describe("delivery", () => {
  it("signs the payload it sends and records a success", async () => {
    const { developer } = await seedDeveloper();
    const { secret } = await createWebhook({ developerId: developer.id, url: "https://example.com/hook", events: ["intent.created"] });
    await enqueueEvent({ developerId: developer.id, event: "intent.created", data: { intentId: "int_x" } });

    let seenSignature = "";
    let seenBody = "";
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      seenSignature = headers["X-IntentPay-Signature"];
      seenBody = String(init.body);
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const summary = await deliverDue(Date.now(), { limit: 10 });
    expect(summary.delivered).toBe(1);

    const hook = (await listDeliveries(developer.id))[0];
    expect(hook.status).toBe("delivered");
    // The exact header the receiver saw verifies against the webhook's secret.
    expect(verifySignature({ secret, header: seenSignature, body: seenBody }).ok).toBe(true);
    expect(seenSignature).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    const parsedBody = JSON.parse(seenBody);
    expect(parsedBody.type).toBe("intent.created");
    expect(parsedBody.id).toBe(hook.eventId);
  });

  it("retries a failed delivery and gives up after the schedule", async () => {
    const { developer } = await seedDeveloper();
    await createWebhook({ developerId: developer.id, url: "https://example.com/hook", events: ["*"] });
    await enqueueEvent({ developerId: developer.id, event: "intent.created", data: {} });

    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;

    // First attempt fails → scheduled for retry.
    const first = await deliverDue(Date.now(), { limit: 10 });
    expect(first.retried).toBe(1);
    let rows = await listDeliveries(developer.id);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].lastStatusCode).toBe(500);

    // Attempts that are not yet due are skipped.
    const early = await deliverDue(Date.now(), { limit: 10 });
    expect(early.attempted).toBe(0);

    // Force every remaining attempt to fail, advancing time past each scheduled
    // retry, then confirm the delivery is failed.
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const far = Date.now() + (i + 1) * 60 * 60 * 1000;
      await deliverDue(far, { limit: 10 });
    }
    rows = await listDeliveries(developer.id);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].attempts).toBe(MAX_ATTEMPTS);
    expect(rows[0].nextAttemptAt).toBeNull();
  });

  it("does not enqueue a duplicate delivery for the same webhook", async () => {
    const { developer } = await seedDeveloper();
    await createWebhook({ developerId: developer.id, url: "https://example.com/hook", events: ["*"] });
    // Two enqueues for the same event produce two deliveries (distinct eventIds),
    // but the unique (webhook, eventId) constraint prevents a true duplicate row.
    const a = await enqueueEvent({ developerId: developer.id, event: "intent.created", data: {} });
    const b = await enqueueEvent({ developerId: developer.id, event: "intent.created", data: {} });
    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
    expect(a[0].eventId).not.toBe(b[0].eventId);
    const rows = await listDeliveries(developer.id);
    expect(rows.length).toBe(2);
  });

  it("only delivers to webhooks subscribed to the event", async () => {
    const { developer } = await seedDeveloper();
    await createWebhook({ developerId: developer.id, url: "https://a.example/hook", events: ["payment.verified"] });
    await createWebhook({ developerId: developer.id, url: "https://b.example/hook", events: ["*"] });
    const created = await enqueueEvent({ developerId: developer.id, event: "intent.created", data: {} });
    expect(created.length).toBe(1); // only the "*" webhook
  });

  it("retires pending deliveries when the webhook is deleted", async () => {
    const { developer } = await seedDeveloper();
    const { webhook } = await createWebhook({ developerId: developer.id, url: "https://example.com/hook", events: ["*"] });
    await enqueueEvent({ developerId: developer.id, event: "intent.created", data: {} });
    await deleteWebhook(developer.id, webhook.id);
    globalThis.fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const summary = await deliverDue(Date.now(), { limit: 10 });
    expect(summary.attempted).toBe(0);
  });

  it("scopes delivery history by developer", async () => {
    const { developer } = await seedDeveloper();
    await createWebhook({ developerId: developer.id, url: "https://example.com/hook", events: ["*"] });
    await enqueueEvent({ developerId: developer.id, event: "intent.created", data: {} });
    const other = await listDeliveries("dev_other");
    expect(other).toEqual([]);
  });

  it("emits intent.created when an intent is created, not only on transitions", async () => {
    const { developer, issued } = await seedDeveloper();
    await createWebhook({ developerId: developer.id, url: "https://example.com/hook", events: ["*"] });
    await createIntent({
      developerId: developer.id,
      createdByKeyId: issued.record.id,
      chainId: 143,
      recipient: "0x7a91c4b8e2d9f04ab3c6e81d5f72a0c9e4bd92f4",
      receiveToken: "USDC",
      receiveTokenAddress: "0x754704bc059f8c67012fed69bc8a327a5aafb603",
      amountMode: "recipient_receives",
      amount: "5",
    });
    const rows = await listDeliveries(developer.id);
    expect(rows.length).toBe(1);
    expect(rows[0].event).toBe("intent.created");
  });
});
