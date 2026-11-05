/**
 * Independent merchant integration — server half.
 *
 * This is what a *third-party* application does to accept an Intent Pay payment.
 * It depends only on the published contracts:
 *
 *   - `@intentpay/sdk`          — the keyed API client (this process)
 *   - `@intentpay/sdk/webhooks` — signature verification (this process)
 *   - the public `/api/checkout/:token` routes — the customer's page
 *
 * It imports **no** Intent Pay application component and no Next.js code, so it
 * proves the integration surface another team would actually build against.
 *
 * Run it:
 *
 *     INTENTPAY_API_KEY=ipk_live_… node examples/merchant/server.mjs
 *
 * Env:
 *   INTENTPAY_API_KEY       required — your merchant API key
 *   INTENTPAY_BASE_URL      default https://intent-pay-roan.vercel.app
 *   MERCHANT_PAYMENT_XPUB   optional — an account-level watch-only xpub; when set
 *                           the example registers it so every order gets its own
 *                           destination (checkout-bound attribution)
 *   PORT                    default 8790
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { IntentPay } from "../../packages/sdk/dist/index.js";
import { verifyWebhookSignature } from "../../packages/sdk/dist/webhooks.js";

const apiKey = process.env.INTENTPAY_API_KEY;
if (!apiKey) {
  console.error("Set INTENTPAY_API_KEY (create one at /docs/developers).");
  process.exit(1);
}
const baseUrl = (process.env.INTENTPAY_BASE_URL ?? "https://intent-pay-roan.vercel.app").replace(/\/+$/, "");
const here = dirname(fileURLToPath(import.meta.url));
const sdkDist = join(here, "..", "..", "packages", "sdk", "dist");
const PORT = Number(process.env.PORT ?? 8790);

// The keyed client. One instance, shared across requests; it never holds a
// wallet, a key or a signature — only the merchant credential.
const pay = new IntentPay({ apiKey, baseUrl, timeoutMs: 30_000 });

/** Webhook signing secrets, keyed by webhook id. In production, persist these. */
const webhookSecrets = new Map();
/** Orders this process created, for the dashboard. In production, use your own store. */
const orders = new Map();
/** Received webhook events, for the dashboard. */
const events = [];

function send(res, status, body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": typeof body === "string" ? "text/html; charset=utf-8" : "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(text);
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** The shareable payment link for a checkout token. */
function paymentLink(token) {
  return `${baseUrl}/checkout/${token}`;
}

/**
 * Read the customer-facing view of an order straight from the public API — the
 * same call the hosted page makes. Token-authenticated; no credential involved.
 */
async function customerView(token) {
  const res = await fetch(`${baseUrl}/api/checkout/${encodeURIComponent(token)}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) return null;
  return res.json();
}

/**
 * Ensure a webhook exists so this merchant is told about settlement. The signing
 * secret is returned once at creation and kept in memory here for the demo.
 */
async function ensureWebhook(publicUrl) {
  const existing = await pay.listWebhooks();
  const found = existing.find((w) => w.url === publicUrl);
  if (found) return { id: found.id, secret: webhookSecrets.get(found.id) ?? null };
  const { webhook, secret } = await pay.createWebhook({
    url: publicUrl,
    events: ["payment.submitted", "payment.confirmed", "payment.verified", "payment.failed"],
    description: "merchant example",
  });
  webhookSecrets.set(webhook.id, secret);
  return { id: webhook.id, secret };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    // ── Dashboard ────────────────────────────────────────────────────────────
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = await readFile(join(here, "public", "index.html"), "utf8");
      return send(res, 200, html);
    }

    // Serve the built SDK wallet entry to the browser (a real app would bundle it).
    if (req.method === "GET" && url.pathname.startsWith("/sdk/")) {
      const rel = url.pathname.slice("/sdk/".length).replace(/\.\./g, "");
      try {
        const js = await readFile(join(sdkDist, rel), "utf8");
        return send(res, 200, js, { "Content-Type": "text/javascript; charset=utf-8" });
      } catch {
        return send(res, 404, { ok: false, error: "not_found" });
      }
    }

    // ── 1 + 2. Authentication + attribution configuration ────────────────────
    // `getAccount()` proves the credential works; `getAttribution()` reports the
    // current mode. Registering an xpub flips every future order to a unique,
    // checkout-bound destination.
    if (req.method === "GET" && url.pathname === "/api/merchant/status") {
      const [account, attribution] = await Promise.all([pay.getAccount(), pay.getAttribution()]);
      return send(res, 200, {
        ok: true,
        merchant: account.developer,
        keys: account.keys.map((k) => ({ prefix: k.prefix, environment: k.environment, status: k.status })),
        attribution,
        baseUrl,
      });
    }

    if (req.method === "POST" && url.pathname === "/api/merchant/attribution") {
      const { paymentXpub } = JSON.parse((await readRawBody(req)) || "{}");
      const attribution = await pay.setAttribution(paymentXpub ?? null);
      return send(res, 200, { ok: true, attribution });
    }

    // ── 3 + 4. Create the order and its payment link ─────────────────────────
    if (req.method === "POST" && url.pathname === "/api/merchant/orders") {
      const body = JSON.parse((await readRawBody(req)) || "{}");
      const amount = String(body.amount ?? "").trim();
      const orderReference = String(body.orderReference ?? "").trim() || `order-${Date.now()}`;
      if (!amount) return send(res, 400, { ok: false, error: "amount (USD) is required" });

      // The recipient is the merchant's own Monad address. With a registered
      // xpub the checkout derives a unique destination from it per order.
      const recipient = body.recipient || process.env.MERCHANT_RECIPIENT;
      if (!recipient) return send(res, 400, { ok: false, error: "recipient (Monad address) is required" });

      const { intent } = await pay.createIntent({
        recipient,
        receiveToken: body.receiveToken || "USDC",
        amount,
        amountMode: "recipient_receives",
        reference: orderReference,
        idempotencyKey: `intent-${orderReference}`,
      });
      const validation = await pay.validateIntent(intent.id);
      if (!validation.valid) return send(res, 422, { ok: false, error: "intent did not validate", validation });

      const { checkout, token } = await pay.createCheckout({
        intentId: intent.id,
        orderReference,
        idempotencyKey: `checkout-${orderReference}`,
      });
      orders.set(checkout.id, { checkout, token, link: paymentLink(token) });
      return send(res, 200, {
        ok: true,
        order: { id: checkout.id, reference: orderReference, status: checkout.status, phase: checkout.phase },
        attribution: checkout.attribution,
        link: paymentLink(token),
      });
    }

    // ── 5 + 7. Customer checkout access + payment status ─────────────────────
    if (req.method === "GET" && url.pathname === "/api/merchant/orders") {
      const list = await pay.listCheckouts();
      const enriched = await Promise.all(
        list.map(async (c) => {
          const cached = orders.get(c.id);
          const view = cached ? await customerView(cached.token) : null;
          return {
            id: c.id,
            reference: c.orderReference,
            status: c.status,
            phase: c.phase,
            attribution: c.attribution,
            link: cached?.link ?? null,
            publicView: view?.checkout ?? null,
          };
        }),
      );
      return send(res, 200, { ok: true, orders: enriched, events });
    }

    // ── 8. Settlement evidence ───────────────────────────────────────────────
    if (req.method === "GET" && url.pathname.startsWith("/api/merchant/orders/") && url.pathname.endsWith("/evidence")) {
      const id = url.pathname.slice("/api/merchant/orders/".length, -"/evidence".length);
      const evidence = await pay.getCheckoutEvidence(decodeURIComponent(id));
      return send(res, 200, { ok: true, evidence });
    }

    // ── 6. Webhook receiver: verify the signature over the RAW body ───────────
    if (req.method === "POST" && url.pathname === "/api/webhook") {
      const raw = await readRawBody(req);
      const webhookId = req.headers["x-intentpay-webhook"] ?? url.searchParams.get("webhook") ?? "";
      // The delivery carries the webhook id only when the endpoint URL includes
      // it; this example registers a single webhook, so the sole known secret is
      // the correct one. A multi-webhook merchant must key by the id.
      const secret =
        webhookSecrets.get(String(webhookId)) ??
        (webhookSecrets.size === 1 ? [...webhookSecrets.values()][0] : undefined);
      if (!secret) return send(res, 401, { ok: false, error: "unknown_webhook" });

      const result = await verifyWebhookSignature({
        secret,
        signature: String(req.headers["x-intentpay-signature"] ?? ""),
        body: raw,
      });
      if (!result.ok) return send(res, 400, { ok: false, error: result.reason });

      const event = JSON.parse(raw);
      events.unshift({ at: new Date().toISOString(), event: event.event ?? event.type ?? "unknown", id: event.id ?? null });
      events.length = Math.min(events.length, 50);
      return send(res, 200, { ok: true });
    }

    // ── Register the webhook so events reach this process ────────────────────
    if (req.method === "POST" && url.pathname === "/api/merchant/webhook") {
      const body = JSON.parse((await readRawBody(req)) || "{}");
      const publicUrl = body.url;
      if (!publicUrl) return send(res, 400, { ok: false, error: "url is required" });
      const { id, secret } = await ensureWebhook(publicUrl);
      return send(res, 200, { ok: true, webhookId: id, secretPresent: Boolean(secret) });
    }

    return send(res, 404, { ok: false, error: "not_found" });
  } catch (err) {
    // Surface the SDK's typed error; never leak a raw upstream message.
    return send(res, 500, { ok: false, error: { code: err?.code ?? "error", message: err?.message ?? "Request failed." } });
  }
});

server.listen(PORT, () => {
  console.log(`Merchant example on http://localhost:${PORT}`);
  console.log(`  API base: ${baseUrl}`);
  console.log("  Register a webhook URL pointing at this process (e.g. a tunnel) to receive events.");
});
