/**
 * Mission 17 reproduction harness (temporary; not shipped).
 *
 * Drives the real production bundle in a headless Chromium with a synthetic
 * injected EIP-1193 wallet, records every /api/quote request and response, and
 * reports the client quote state across the expiry -> refresh boundary.
 *
 * Usage: node scripts/mission17/repro.mjs <baseUrl> [outDir]
 */
import { chromium } from "playwright";
import fs from "node:fs";

const base = process.argv[2] ?? "https://intent-pay-roan.vercel.app";
const outDir = process.argv[3] ?? "/tmp/mission17";
fs.mkdirSync(outDir, { recursive: true });

const RECIPIENT = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4";

const PROVIDER_INIT = () => {
  const ADDRESS = "0x1111111111111111111111111111111111111111";
  const listeners = {};
  const provider = {
    isMetaMask: true,
    chainId: "0x8f",
    request: async ({ method }) => {
      switch (method) {
        case "eth_chainId":
          return "0x8f";
        case "eth_accounts":
        case "eth_requestAccounts":
          return [ADDRESS];
        case "wallet_switchEthereumChain":
        case "wallet_addEthereumChain":
          return null;
        case "eth_getBalance":
          return "0x21e19e0c9bab2400000";
        case "eth_call":
          return "0x";
        case "eth_getCode":
          return "0x";
        default:
          return null;
      }
    },
    on: (ev, fn) => {
      (listeners[ev] ||= []).push(fn);
    },
    removeListener: (ev, fn) => {
      listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn);
    },
  };
  window.ethereum = provider;
  const info = {
    uuid: "00000000-0000-4000-8000-0000000000aa",
    name: "MetaMask",
    icon: "",
    rdns: "io.metamask",
  };
  const announce = () =>
    window.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", { detail: { info, provider } }),
    );
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
};

function safeJson(s) {
  try {
    const j = JSON.parse(s);
    return {
      recipient: j.recipient,
      receiveToken: j.receiveToken,
      receiveTokenAddress: j.receiveTokenAddress,
      receiveAmount: j.receiveAmount,
      amountMode: j.amountMode,
      payToken: j.payToken,
      payTokenAddress: j.payTokenAddress,
      network: j.network,
    };
  } catch {
    return s;
  }
}

const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
await ctx.addInitScript(PROVIDER_INIT);
const page = await ctx.newPage();

const events = [];
const consoleLines = [];
page.on("console", (m) => consoleLines.push(`${m.type()}: ${m.text()}`));
page.on("pageerror", (e) => consoleLines.push(`pageerror: ${e.message}`));

page.on("request", (req) => {
  if (!req.url().includes("/api/quote")) return;
  events.push({ kind: "request", at: Date.now(), body: safeJson(req.postData()) });
});
page.on("response", async (res) => {
  if (!res.url().includes("/api/quote")) return;
  let body = null;
  try {
    body = await res.json();
  } catch {}
  events.push({
    kind: "response",
    at: Date.now(),
    status: res.status(),
    ok: body?.ok,
    code: body?.code,
    payAmount: body?.quote?.payAmount,
    message: body?.message,
  });
});

const errors = [];

// Optional fault injection: fail /api/quote with a transient provider error for a
// window of wall-clock time after Review is reached. Set FAIL_FROM_MS / FAIL_TO_MS
// (ms after the review snapshot) to simulate the owner's intermittent outage.
const failFrom = process.env.FAIL_FROM_MS ? Number(process.env.FAIL_FROM_MS) : null;
const failTo = process.env.FAIL_TO_MS ? Number(process.env.FAIL_TO_MS) : null;
let reviewReachedAt = null;
let failMode = process.env.FAIL_MODE ?? "provider_error";
let injectedFailures = 0;

if (failFrom !== null) {
  await ctx.route("**/api/quote", async (route) => {
    const since = reviewReachedAt === null ? -1 : Date.now() - reviewReachedAt;
    if (since >= failFrom && since <= failTo) {
      injectedFailures++;
      const code = failMode;
      await route.fulfill({
        status: code === "http_502" ? 502 : 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          code: code === "http_502" ? "provider_error" : code,
          message: "We couldn't reach the Monad network just now. Retrying…",
        }),
      });
      return;
    }
    await route.continue();
  });
}

// A synthetic address has no real on-chain balance, so the composer would never
// offer a pay asset and Continue would stay disabled. To reach the real Review /
// refresh path we simulate a *funded wallet* by answering /api/balances with a
// funded holdings set. This is the ONLY simulated input: /api/quote itself is
// called for real against production, and every quote request/response below is
// the genuine server behaviour.
await ctx.route("**/api/balances**", async (route) => {
  const now = Date.now();
  const tok = (symbol, name, address, decimals, tint) => ({
    symbol, name, address, decimals, tint, source: "seed", seed: true,
  });
  const balances = [
    { token: { ...tok("MON", "Monad", "0x0000000000000000000000000000000000000000", 18, "#836EF9"), native: true }, amount: "10000", usd: 25000, discovered: false },
    { token: tok("USDT", "Tether USD (USDT0)", "0xe7cd86e13AC4309349F30B3435a9d337750fC82D", 6, "#26A17B"), amount: "500", usd: 500, discovered: false },
    { token: tok("USDC", "USD Coin", "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", 6, "#2775CA"), amount: "500", usd: 500, discovered: false },
  ];
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      ok: true,
      address: "0x1111111111111111111111111111111111111111",
      network: "mainnet",
      count: balances.length,
      sources: { onchain: true, zerion: false, zerionConfigured: false, zerionStatus: "disabled" },
      balances,
    }),
  });
  void now;
});

await ctx.route("**/api/optimize**", async (route) => {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      ok: true,
      network: "mainnet",
      best: {
        symbol: "USDT",
        ok: true,
        payAmount: "0.100133",
        payUsd: 0.100133,
        receiveUsd: 0.1,
        routePath: ["USDT", "USDC"],
        totalSenderCostUsd: 0.10061064556245093,
        sufficient: true,
      },
      options: [
        {
          symbol: "USDT",
          ok: true,
          payAmount: "0.100133",
          payUsd: 0.100133,
          receiveUsd: 0.1,
          routePath: ["USDT", "USDC"],
          totalSenderCostUsd: 0.10061064556245093,
          sufficient: true,
        },
        { symbol: "USDC", ok: true, payAmount: "0.1", payUsd: 0.1, receiveUsd: 0.1, routePath: ["USDC"], totalSenderCostUsd: 0.1, sufficient: true },
        { symbol: "MON", ok: false, sufficient: false, reason: "native MON is reserved for gas" },
      ],
    }),
  });
});

await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(1500);

const clickText = async (re, label) => {
  const loc = page.getByRole("button", { name: re }).first();
  try {
    await loc.dispatchEvent("click", undefined, { timeout: 6000 });
    return true;
  } catch (e) {
    errors.push(`${label}: ${e.message.split("\n")[0]}`);
    return false;
  }
};

try {
  await clickText(/connect/i, "connect-open");
  await page.waitForTimeout(1200);
  const mm = page.getByRole("button", { name: /MetaMask/i }).first();
  if (await mm.isVisible().catch(() => false)) {
    await mm.dispatchEvent("click", undefined, { timeout: 6000 }).catch((e) =>
      errors.push(`metamask-click: ${e.message.split("\n")[0]}`),
    );
  } else {
    errors.push("metamask-not-visible");
  }
  await page.waitForTimeout(3500);
} catch (e) {
  errors.push(`connect: ${e.message.split("\n")[0]}`);
}

try {
  await page.locator('input[aria-label="Recipient receives"]').first().fill("0.10", { timeout: 10000 });
  await page.locator("#recipient").first().fill(RECIPIENT, { timeout: 10000 });
  await page.waitForTimeout(1500);

  // The canonical intent is deliberately empty on first load, so the receive
  // token must be chosen explicitly before anything is quotable.
  const chooseReceive = page.getByRole("button", { name: /choose receive token/i }).first();
  if (await chooseReceive.isVisible().catch(() => false)) {
    await chooseReceive.dispatchEvent("click", undefined, { timeout: 6000 });
    await page.waitForTimeout(900);
    const search = page.locator('input[placeholder="Search or paste a Monad token address"]').first();
    if (await search.isVisible().catch(() => false)) {
      await search.fill("USDC", { timeout: 6000 });
      await page.waitForTimeout(700);
    }
    // Pick the exact USDC row (the search input has no role=button; rows do).
    const row = page.locator("button", { hasText: /USD Coin/ }).first();
    if (await row.isVisible().catch(() => false)) {
      await row.dispatchEvent("click", undefined, { timeout: 6000 });
    } else {
      errors.push("receive-token-USDC-row-not-found");
    }
    await page.waitForTimeout(2000);
  } else {
    errors.push("choose-receive-token-not-visible");
  }
} catch (e) {
  errors.push(`fill: ${e.message.split("\n")[0]}`);
}

const shots = {};
const snap = async (name) => {
  try {
    shots[name] = await page.evaluate(() => document.body.innerText.slice(0, 3000));
  } catch (e) {
    shots[name] = `snapshot failed: ${e.message}`;
  }
};
await snap("composer");

// Pick a pay asset explicitly (the auto-pick can settle on a source whose gas
// coverage the composer then flags). USDT is the mocked optimizer's best.
try {
  await page.waitForTimeout(1000);
  const usdtRow = page.locator("button", { hasText: /Pay ~\$0\.10/ }).filter({ hasText: /USDT/ }).first();
  if (await usdtRow.isVisible().catch(() => false)) {
    await usdtRow.dispatchEvent("click", undefined, { timeout: 6000 });
  } else {
    const anyUsdt = page.locator("button", { hasText: /USDT/ }).first();
    if (await anyUsdt.isVisible().catch(() => false)) {
      await anyUsdt.dispatchEvent("click", undefined, { timeout: 6000 });
    }
  }
  await page.waitForTimeout(2500);
} catch (e) {
  errors.push(`payasset: ${e.message.split("\n")[0]}`);
}

try {
  await page.waitForTimeout(1500);
  const cont = page.getByRole("button", { name: /Review payment/i }).first();
  const visible = await cont.isVisible().catch(() => false);
  if (visible) {
    await cont.dispatchEvent("click", undefined, { timeout: 8000 });
  } else {
    const composerBtn = page.locator("button.btn-primary").last();
    const label = await composerBtn.innerText().catch(() => "");
    errors.push(`continue-not-ready: "${label.trim()}"`);
  }
  await page.waitForTimeout(2500);
} catch (e) {
  errors.push(`review: ${e.message.split("\n")[0]}`);
}
await snap("review");

// Poll the Review text across the expiry -> refresh boundary. `reviewReachedAt`
// anchors the fault-injection window.
reviewReachedAt = Date.now();
const timeline = [];
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(5000);
  const text = await page.evaluate(() => document.body.innerText.slice(0, 2500)).catch(() => "");
  timeline.push({ t: Date.now() - reviewReachedAt, text });
}
shots.timeline = timeline.map((x) => `t=${Math.round(x.t / 1000)}s\n${x.text}`).join("\n\n=====\n\n");
await snap("after_expiry");
await page.screenshot({ path: `${outDir}/after_expiry.png`, fullPage: true });

fs.writeFileSync(
  `${outDir}/report.json`,
  JSON.stringify(
    { base, errors, injectedFailures, events, consoleTail: consoleLines.slice(-40), snapshots: shots },
    null,
    2,
  ),
);

const responses = events.filter((e) => e.kind === "response");
console.log(`quote requests: ${events.filter((e) => e.kind === "request").length}, responses: ${responses.length}`);
for (const r of responses) {
  console.log(`  resp ${r.status} ok=${r.ok} code=${r.code ?? "-"} pay=${r.payAmount ?? "-"}`);
}
console.log("--- after_expiry text ---");
console.log(shots.after_expiry);
console.log("--- errors ---", errors);

await browser.close();
