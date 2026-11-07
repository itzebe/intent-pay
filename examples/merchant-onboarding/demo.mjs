#!/usr/bin/env node
/**
 * Merchant onboarding demonstration — headless.
 *
 * Runs the real merchant lifecycle against a deployment and stops exactly where a
 * customer's wallet would take over. It proves the integration surface end to
 * end — capabilities → intent → checkout → payment link → prepare → submit →
 * verify — without a browser and **without any signature**, so it is safe to run
 * at any time and moves no funds.
 *
 * Usage:
 *
 *   INTENTPAY_API_KEY=ipk_… node examples/merchant-onboarding/demo.mjs
 *
 * Env:
 *   INTENTPAY_API_KEY       required — your merchant API key
 *   INTENTPAY_BASE_URL      default https://intent-pay-roan.vercel.app
 *   MERCHANT_RECIPIENT      default a documented placeholder address
 *   DEMO_AMOUNT_USD         default 1
 *   DEMO_TX_HASH            optional — a real hash a customer's wallet produced;
 *                           when set, the demo records and verifies it
 *
 * Honesty rule: it never signs, never broadcasts, and never reports a payment
 * unless the server's independent verification returns `verified`. With no real
 * hash it exits 0 once the merchant half is proven and says plainly that
 * settlement still requires a customer's wallet.
 */
import { IntentPay } from "../../packages/sdk/dist/index.js";

const apiKey = process.env.INTENTPAY_API_KEY;
if (!apiKey) {
  console.error("Set INTENTPAY_API_KEY (create one at /docs/quickstart).");
  process.exit(2);
}

const baseUrl = (process.env.INTENTPAY_BASE_URL ?? "https://intent-pay-roan.vercel.app").replace(/\/+$/, "");
const recipient = process.env.MERCHANT_RECIPIENT ?? "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4";
const amountUsd = process.env.DEMO_AMOUNT_USD ?? "1";
const txHash = process.env.DEMO_TX_HASH;
// A fixed sender is only used to *build* calldata; nothing is signed with it.
const demoSender = process.env.DEMO_SENDER ?? "0x1234567890aBcDeF1234567890aBcDeF12345678";

const pay = new IntentPay({ apiKey, baseUrl, timeoutMs: 30_000 });
const line = (label, value) => console.log(`${label.padEnd(20)} ${value}`);

try {
  // 1. What the API actually supports on this deployment.
  const caps = await pay.getCapabilities();
  line("base", baseUrl);
  line("network", `${caps.network.name} (chain ${caps.network.chainId})`);
  line("assets", caps.assets.map((a) => a.symbol).join(", "));

  // 2. The merchant account behind the key (never a secret).
  const account = await pay.getAccount();
  line("account", `${account.developer.name} (${account.developer.status})`);

  // 3. Create the payment intent — what the recipient receives.
  const created = await pay.createIntent({
    recipient,
    receiveToken: "USDC",
    amount: amountUsd,
    amountMode: "recipient_receives",
    reference: `DEMO-${Date.now()}`,
  });
  const intentId = created.intent.id;
  line("intent", intentId);
  line("receives", `${created.intent.amount} ${created.intent.receiveToken} (${created.intent.amountMode})`);

  // 4. Validate it against real chain state (recipient, asset, route, amount).
  const validation = await pay.validateIntent(intentId);
  line("valid", String(validation.valid));

  // 5. Wrap it in a checkout — the payable order and its payment link.
  const checkout = await pay.createCheckout({ intentId, orderReference: `DEMO-${intentId.slice(-6)}` });
  const id = checkout.checkout.id;
  const link = `${baseUrl}/checkout/${checkout.token}`;
  line("checkout", id);
  line("status", checkout.checkout.status);
  line("link", link);
  line("attribution", checkout.checkout.attribution?.mode ?? "shared_recipient");

  // 6. Build the customer's calls (real calldata). Nothing is signed here.
  const prepared = await pay.prepareCheckout(id, { sender: demoSender });
  line("pay asset", prepared.quote.payToken);
  line("pay amount", prepared.quote.payAmount);
  line("min received", prepared.quote.minimumReceived);
  line("calls", prepared.calls.length);
  for (const step of prepared.steps) line("  step", step);

  console.log(
    "\nThe customer opens the link, connects a wallet and authorizes. This demo\n" +
      "holds no wallet, so it stops here — a broadcast is not a payment anyway.",
  );

  if (txHash) {
    // A real hash from a customer's wallet: record it, then verify independently.
    await pay.submitCheckout(id, { txHashes: [txHash] });
    const { verdict } = await pay.verifyCheckout(id);
    line("verdict", verdict);
    if (verdict === "verified") {
      console.log("\nDelivered and proven on chain.");
      process.exitCode = 0;
    } else {
      console.log(`\nNot proven (${verdict}). Do not treat this as paid.`);
      process.exitCode = 1;
    }
  } else {
    // No real transaction was made; the merchant half is complete and proven.
    console.log("\nMerchant half complete. Settlement requires a real customer payment.");
    process.exitCode = 0;
  }
} catch (err) {
  // The typed SDK error, never a raw upstream message.
  console.error(`Failed: ${err?.code ?? "error"} — ${err?.message ?? "Request failed."}`);
  process.exitCode = 3;
}
