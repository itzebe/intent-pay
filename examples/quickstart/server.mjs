/**
 * The server half of the split.
 *
 * Holds the API key, and does every credential-bearing call. The browser never
 * talks to Intent Pay directly — it talks to this server, which forwards the
 * calls the wallet must sign. Run it with:
 *
 *     INTENTPAY_API_KEY=ipk_live_… node server.mjs
 *
 * Then open http://localhost:8787.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { IntentPay } from "../../packages/sdk/dist/index.js";

const apiKey = process.env.INTENTPAY_API_KEY;
if (!apiKey) {
  console.error("Set INTENTPAY_API_KEY (create one at /docs/developers).");
  process.exit(1);
}
const baseUrl = process.env.INTENTPAY_BASE_URL ?? "https://intent-pay-roan.vercel.app";
const pay = new IntentPay({ apiKey, baseUrl, timeoutMs: 30_000 });

const here = dirname(fileURLToPath(import.meta.url));
const sdkDist = join(here, "..", "..", "packages", "sdk", "dist");
const PORT = Number(process.env.PORT ?? 8787);

/** Per-intent state kept only for this demo (in production, use your own store). */
const intents = new Map();

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    // Serve the browser page.
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = await readFile(join(here, "public", "index.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    }

    // Serve the built SDK wallet entry to the browser. In a real app you would
    // import "@intentpay/sdk/wallet" through your bundler instead.
    if (req.method === "GET" && url.pathname.startsWith("/sdk/")) {
      const rel = url.pathname.slice("/sdk/".length).replace(/\.\./g, "");
      const file = join(sdkDist, rel);
      try {
        const js = await readFile(file, "utf8");
        res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(js);
      } catch {
        return send(res, 404, { ok: false, error: "not_found" });
      }
    }

    // Create + validate + prepare, in one server-side step.
    if (req.method === "POST" && url.pathname === "/api/pay/create") {
      const { recipient, amount, receiveToken, sender } = await readBody(req);
      if (!sender) return send(res, 400, { ok: false, error: { code: "invalid_request", message: "`sender` (the connected wallet address) is required." } });
      const { intent } = await pay.createIntent({
        recipient,
        receiveToken: receiveToken || "USDC",
        amount,
        idempotencyKey: `demo-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      });
      const validation = await pay.validateIntent(intent.id);
      if (!validation.valid) return send(res, 422, { ok: false, validation });
      // The sender is the user's own connected wallet, never the recipient.
      const prepared = await pay.prepareTransaction(intent.id, { sender });
      intents.set(intent.id, { intent, prepared });
      return send(res, 200, { ok: true, intentId: intent.id, calls: prepared.calls, quote: prepared.quote, steps: prepared.steps });
    }

    // Record the hashes the wallet produced, then verify.
    if (req.method === "POST" && url.pathname === "/api/pay/submit") {
      const { intentId, txHashes } = await readBody(req);
      await pay.authorizeIntent(intentId);
      await pay.submitTransaction(intentId, { txHashes });
      const verification = await pay.verifySettlement(intentId);
      return send(res, 200, { ok: true, verification, status: await pay.getPaymentStatus(intentId) });
    }

    return send(res, 404, { ok: false, error: "not_found" });
  } catch (err) {
    // Surface the typed error the SDK produced, never a raw upstream message.
    return send(res, 500, { ok: false, error: { code: err?.code ?? "error", message: err?.message ?? "Request failed." } });
  }
});

server.listen(PORT, () => console.log(`Quickstart on http://localhost:${PORT}`));
