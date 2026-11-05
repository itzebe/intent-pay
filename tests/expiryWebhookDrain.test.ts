import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore, SqliteStore, getStore, setStore } from "@/lib/store";
import { createDeveloperWithKey } from "@/lib/developer/credentials";
import { createIntent } from "@/lib/developer/intents";
import { bindIntentForCheckout, createCheckout } from "@/lib/developer/checkouts";
import { createWebhook, listDeliveries } from "@/lib/developer/webhooks";

import { GET as publicCheckoutGET } from "@/app/api/checkout/[token]/route";
import { POST as publicPreparePOST } from "@/app/api/checkout/[token]/prepare/route";
import { GET as merchantCheckoutGET } from "@/app/api/v1/checkouts/[id]/route";
import { GET as evidenceGET } from "@/app/api/v1/checkouts/[id]/evidence/route";
import { GET as intentGET } from "@/app/api/v1/intents/[id]/route";

/**
 * Expiring an order is a *read-time* side effect: a stale checkout ages into
 * `expired` when someone reads it, and that emits `checkout.expired`. Delivery is
 * request-driven (there is no scheduler on this deployment), so the read that
 * caused the expiry must also trigger the drain — otherwise the merchant's expiry
 * webhook sits `pending` until unrelated traffic happens to arrive.
 *
 * `drainDueSoon` itself is a no-op outside a Next.js request scope, so the
 * regression is asserted at the call site: every read path that can expire an
 * order must invoke the drain trigger.
 */

const { drainSpy } = vi.hoisted(() => ({ drainSpy: vi.fn(async () => {}) }));
vi.mock("@/lib/developer/webhooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/developer/webhooks")>()),
  drainDueSoon: drainSpy,
}));

const RECIPIENT = "0x7a91c4b8e2d9f04ab3c6e81d5f72a0c9e4bd92f4";
const USDC_ADDRESS = "0x754704bc059f8c67012fed69bc8a327a5aafb603";

function req(url: string, opts: { method?: string; token?: string } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  return new Request(url, { method: opts.method ?? "GET", headers });
}

/** An order whose checkout and intent are both past their TTL (unsubmitted). */
async function seedExpiredOrder() {
  const { developer, issued } = await createDeveloperWithKey({ name: "Acme" });
  await createWebhook({ developerId: developer.id, url: "https://example.com/hook", events: ["checkout.expired", "intent.expired"] });

  const created = await createIntent({
    developerId: developer.id,
    createdByKeyId: issued.record.id,
    chainId: 143,
    recipient: RECIPIENT,
    receiveToken: "USDC",
    receiveTokenAddress: USDC_ADDRESS,
    amountMode: "recipient_receives",
    amount: "5",
  });
  if (!created.ok) throw new Error("intent create failed");
  const intent = created.intent;

  const co = await createCheckout(intent, { developerId: developer.id, intentId: intent.id });
  if (!co.ok) throw new Error("checkout create failed");
  await bindIntentForCheckout(intent, co.checkout.attributionAddress);

  // Push both TTLs into the past without waiting.
  await getStore().update("apiIntents", { id: intent.id }, { createdAt: Date.now() - 31 * 60 * 1000 });
  await getStore().update("apiCheckouts", { id: co.checkout.id }, { expiresAt: Date.now() - 1000 });

  return { developer, key: issued.key, intentId: intent.id, checkoutId: co.checkout.id, token: co.token };
}

async function expiredDeliveries(developerId: string) {
  return (await listDeliveries(developerId)).filter((d) => d.event === "checkout.expired");
}

beforeEach(() => {
  setStore(new SqliteStore(":memory:"));
  drainSpy.mockClear();
});
afterEach(() => {
  setStore(new MemoryStore());
  vi.clearAllMocks();
});

describe("expiry on read triggers a webhook drain", () => {
  it("public checkout read (customer link)", async () => {
    const { developer, token } = await seedExpiredOrder();
    const res = await publicCheckoutGET(req(`http://localhost/api/checkout/${token}`), { params: Promise.resolve({ token }) });
    expect(res.status).toBe(200);
    expect(drainSpy).toHaveBeenCalled();
    expect(await expiredDeliveries(developer.id)).toHaveLength(1);
  });

  it("public prepare read (customer about to pay an expired order)", async () => {
    const { developer, token } = await seedExpiredOrder();
    const res = await publicPreparePOST(req(`http://localhost/api/checkout/${token}/prepare`, { method: "POST" }), { params: Promise.resolve({ token }) });
    expect(res.status).toBe(409);
    expect(drainSpy).toHaveBeenCalled();
    expect(await expiredDeliveries(developer.id)).toHaveLength(1);
  });

  it("merchant checkout read", async () => {
    const { developer, key, checkoutId } = await seedExpiredOrder();
    const res = await merchantCheckoutGET(req(`http://localhost/api/v1/checkouts/${checkoutId}`, { token: key }), { params: Promise.resolve({ id: checkoutId }) });
    expect(res.status).toBe(200);
    expect(drainSpy).toHaveBeenCalled();
    expect(await expiredDeliveries(developer.id)).toHaveLength(1);
  });

  it("merchant evidence read", async () => {
    const { developer, key, checkoutId } = await seedExpiredOrder();
    const res = await evidenceGET(req(`http://localhost/api/v1/checkouts/${checkoutId}/evidence`, { token: key }), { params: Promise.resolve({ id: checkoutId }) });
    expect(res.status).toBe(200);
    expect(drainSpy).toHaveBeenCalled();
    expect(await expiredDeliveries(developer.id)).toHaveLength(1);
  });

  it("merchant intent read", async () => {
    const { developer, key, intentId } = await seedExpiredOrder();
    const res = await intentGET(req(`http://localhost/api/v1/intents/${intentId}`, { token: key }), { params: Promise.resolve({ id: intentId }) });
    expect(res.status).toBe(200);
    expect(drainSpy).toHaveBeenCalled();
    const events = (await listDeliveries(developer.id)).map((d) => d.event);
    expect(events).toContain("intent.expired");
  });
});
