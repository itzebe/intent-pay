#!/usr/bin/env node
/**
 * Headless status and settlement check.
 *
 * The smallest possible integration that needs no browser and no wallet: it holds
 * the API key, reads an intent's status, and independently verifies settlement on
 * chain. It is the script a merchant's reconciliation job runs.
 *
 * Usage:
 *
 *     INTENTPAY_API_KEY=ipk_live_… node examples/status-and-verify/check.mjs <intentId> [txHash]
 *
 * With a `txHash`, it records the broadcast (authorize → submit → verify) exactly
 * as a server would after its customer's wallet reported the hash. With no hash it
 * only reads status — a safe, read-only reconciliation call.
 */
import { IntentPay } from "../../packages/sdk/dist/index.js";

const apiKey = process.env.INTENTPAY_API_KEY;
const baseUrl = process.env.INTENTPAY_BASE_URL ?? "https://intent-pay-roan.vercel.app";
const intentId = process.argv[2];
const txHash = process.argv[3];

if (!apiKey) {
  console.error("Set INTENTPAY_API_KEY (create one at /docs/quickstart).");
  process.exit(2);
}
if (!intentId) {
  console.error("Usage: node check.mjs <intentId> [txHash]");
  process.exit(2);
}

const pay = new IntentPay({ apiKey, baseUrl, timeoutMs: 30_000 });

function line(label, value) {
  console.log(`${label.padEnd(22)} ${value}`);
}

try {
  const intent = await pay.getIntent(intentId);
  line("intent", intent.intent.id);
  line("state", intent.intent.state);
  line("recipient", intent.intent.recipient);
  line("receives", `${intent.intent.amount} ${intent.intent.receiveToken} (${intent.intent.amountMode})`);

  const status = await pay.getPaymentStatus(intentId);
  line("settled", String(status.settled));
  line("failed", String(status.failed));

  if (txHash) {
    // The wallet reported a hash: record it and verify the receipt ourselves.
    await pay.authorizeIntent(intentId);
    await pay.submitTransaction(intentId, { txHashes: [txHash] });
    const { verdict } = await pay.verifySettlement(intentId);
    line("verdict", verdict);
    if (verdict === "verified") {
      console.log("\nDelivered and proven on chain.");
    } else {
      // Never report success for anything but "verified".
      console.log(`\nNot proven (${verdict}). Do not treat this as paid.`);
      process.exitCode = 1;
    }
  } else {
    // Read-only: report honestly and exit non-zero unless settled.
    process.exitCode = status.settled ? 0 : 1;
  }
} catch (err) {
  // Surface the typed error the SDK produced, never a raw upstream message.
  console.error(`Failed: ${err?.code ?? "error"} — ${err?.message ?? "Request failed."}`);
  process.exitCode = 3;
}
