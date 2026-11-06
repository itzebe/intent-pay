// Mission 20 Gate 3 — does production CSP allow the wallet's own RPC fetch?
// Loads the REAL production page (https + real CSP), then performs page-context
// fetches to monad.twnodes.com over http:// and https:// exactly as a page-world
// injected provider (Trust Wallet) would, and records CSP violations + outcome.
import fs from "node:fs";
import { chromium } from "playwright";

const base = process.argv[2] ?? "https://intent-pay-roan.vercel.app";
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox","--disable-dev-shm-usage"] });
const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
const page = await ctx.newPage();
const console_ = [];
page.on("console", (m) => console_.push(`${m.type()}: ${m.text()}`.slice(0, 400)));
page.on("pageerror", (e) => console_.push(`pageerror: ${String(e).slice(0, 300)}`));

await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(1500);

const out = await page.evaluate(async () => {
  const post = (url) => fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
  }).then(async (r) => ({ ok: r.ok, status: r.status, body: (await r.text()).slice(0, 120) }))
    .catch((e) => ({ error: String(e).slice(0, 200) }));
  const https = await post("https://monad.twnodes.com/");
  const http = await post("http://monad.twnodes.com/");
  return { https, http, isSecureContext: window.isSecureContext, origin: location.origin };
});

console.log(JSON.stringify({ base, ...out, cspViolations: console_.filter((l) => /content security policy|refused to connect|failed to connect/i.test(l)) }, null, 2));
await browser.close();
