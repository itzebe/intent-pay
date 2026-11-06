// Mission 23 — prove the app stays usable when the *preferred* RPC endpoint
// accepts the connection but never replies (the production outage).
//
// On the deployed build the keyed endpoint stalled with no response. viem's
// `fallback` only moves on when a call *throws*, so every read paid that
// endpoint's 20 s timeout: `/api/balances` hung past the serverless limit,
// `/api/tokens` and `/api/quote` stalled, balances looked empty and a payment
// could never be prepared.
//
// This harness runs a local "blackhole" server (accepts, never answers), points
// MONAD_RPC_URL at it, and times the real API routes. On the pre-fix build each
// route blocks for the endpoint timeout (>=20 s, or the route's own limit);
// after the fix the short per-endpoint timeout plus the ordered failover lets
// every route answer in a couple of seconds from the public Monad RPC.
//
//   node scripts/mission23/rpcStallProbe.mjs http://localhost:3400
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

const base = process.argv[2] ?? "http://localhost:3400";
const STALL_PORT = Number(process.env.STALL_PORT ?? 4599);

const stall = createServer(() => {
  /* accept the connection and never respond */
});
await new Promise((resolve) => stall.listen(STALL_PORT, "127.0.0.1", resolve));
console.log(`blackhole RPC listening on http://127.0.0.1:${STALL_PORT}`);

const ADDR = "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A";
const routes = [
  { name: "/api/tokens", url: `${base}/api/tokens?network=mainnet` },
  { name: "/api/balances", url: `${base}/api/balances?address=${ADDR}&network=mainnet` },
];

let worst = 0;
for (const route of routes) {
  const started = Date.now();
  let status = 0;
  try {
    const res = await fetch(route.url, { signal: AbortSignal.timeout(40_000) });
    status = res.status;
  } catch (err) {
    status = -1;
    console.error(`${route.name} threw: ${String(err).slice(0, 120)}`);
  }
  const ms = Date.now() - started;
  worst = Math.max(worst, ms);
  console.log(`${route.name.padEnd(16)} HTTP ${status}  ${ms} ms`);
}

const started = Date.now();
let quoteStatus = 0;
try {
  const res = await fetch(`${base}/api/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      recipient: "0x1111111111111111111111111111111111111111",
      receiveToken: "USDC",
      receiveAmount: "1",
      amountMode: "recipient_receives",
      payToken: "USDT",
      mode: "live",
      network: "mainnet",
    }),
    signal: AbortSignal.timeout(40_000),
  });
  quoteStatus = res.status;
} catch (err) {
  quoteStatus = -1;
  console.error(`/api/quote threw: ${String(err).slice(0, 120)}`);
}
const quoteMs = Date.now() - started;
worst = Math.max(worst, quoteMs);
console.log(`${"/api/quote".padEnd(16)} HTTP ${quoteStatus}  ${quoteMs} ms`);

// Give the event loop a tick so the summary prints after any late log line.
await sleep(50);
console.log(`worst route: ${worst} ms (a route must answer well under the 60 s serverless limit)`);

stall.close();
