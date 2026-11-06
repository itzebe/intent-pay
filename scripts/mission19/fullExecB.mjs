// Mission 19 — Failure B: exercise the FULL post-broadcast pipeline on the real
// deployed app WITHOUT signing anything. The stub wallet answers
// eth_sendTransaction with a REAL, already-mined Monad transaction hash, so the
// app's own waitForTransactionReceipt + verifyDelivery + success path all run
// against the real chain. No signature, no approval, no new transaction.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const base = process.argv[2] ?? "https://intent-pay-roan.vercel.app";
const outDir = process.argv[3] ?? "/tmp/m19-exec";
fs.mkdirSync(outDir, { recursive: true });
const ACCOUNT = process.argv[4] ?? "0x28f64a62ab3b284d667115cf66782b094f412eec";
const RECIPIENT = "0x1234567890AbcdEF1234567890aBcdef12345678";
const REAL_HASH = process.env.FAKE_HASH ?? "0x209c13872f077d7801b0a70bf4166289e44b8a3934c76b0b39be2292ee88383e";

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const ctx = await browser.newContext({ viewport: { width: 430, height: 940 } });
const logs = [];
await ctx.addInitScript(
  ({ account, realHash }) => {
    const listeners = {};
    const provider = {
      isMetaMask: true,
      request: async ({ method }) => {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [account];
        if (method === "eth_chainId") return "0x8f";
        if (method === "eth_sendTransaction") return realHash;
        if (method === "wallet_switchEthereumChain") return null;
        return null;
      },
      on: (ev, fn) => ((listeners[ev] ??= []).push(fn)),
      removeListener: () => {},
    };
    window.ethereum = provider;
    const announce = () =>
      window.dispatchEvent(
        new CustomEvent("eip6963:announceProvider", {
          detail: { info: { uuid: "u-mm", name: "MetaMask", icon: "", rdns: "io.metamask" }, provider },
        }),
      );
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
  },
  { account: ACCOUNT, realHash: REAL_HASH },
);

const page = await ctx.newPage();
page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`.slice(0, 300)));
page.on("pageerror", (e) => logs.push(`PAGEERROR: ${String(e.stack ?? e).slice(0, 500)}`));
page.on("requestfailed", (req) => { if (/\/api\/balances/.test(req.url())) logs.push(`REQFAIL ${req.failure()?.errorText} ${req.url().slice(0,90)}`); });
page.on("requestfinished", async (req) => { if (/\/api\/balances/.test(req.url())) { const r = await req.response(); logs.push(`REQFIN ${req.url().slice(0,90)} status=${r?.status()}`); } });
const api = [];
page.on("request", (req) => { if (/\/api\//.test(req.url())) api.push({ req: req.url().slice(0, 140) }); });
page.on("response", async (res) => {
  if (!/\/api\//.test(res.url())) return;
  let body = null; try { body = await res.json(); } catch {}
  api.push({ res: res.url().slice(0, 140), status: res.status(), ok: body?.ok, n: body?.balances?.length, code: body?.code, msg: body?.message });
});
const out = { base, steps: [] };
try {
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  await page.locator("button.btn-primary", { hasText: /Connect wallet/i }).first().dispatchEvent("click").catch(() => {});
  await page.waitForTimeout(1200);
  await page.locator("button", { hasText: /Detected in this browser/i }).first().dispatchEvent("click").catch(() => {});
  await page.waitForTimeout(3000);
  out.connected = /0x28f6/i.test(await page.evaluate(() => document.body.innerText));
  out.balancesResponse = await page.waitForResponse((r) => r.url().includes("/api/balances"), { timeout: 30000 }).then((r) => r.status()).catch((e) => "TIMEOUT:" + e.message.split("\n")[0]);
  await page.waitForTimeout(2000);

  // Natural-language prefill drives the same composer the manual form does.
  const nl = page.locator('input[aria-label="Describe a payment in plain English"]');
  await nl.fill(`Send $5 worth of USDC to ${RECIPIENT}`, { timeout: 6000 }).catch((e) => out.steps.push("nl:" + e.message.split("\n")[0]));
  await page.locator("button.btn-primary", { hasText: /^Ask$/ }).first().dispatchEvent("click").catch(() => {});
  await page.waitForTimeout(2500);
  out.handoff = (await page.evaluate(() => document.body.innerText)).match(/Ready[^\n]*/)?.[0] ?? null;
  await page.locator("button.btn-primary", { hasText: /Continue to payment/i }).first().dispatchEvent("click").catch((e) => out.steps.push("cont:" + e.message.split("\n")[0]));
  await page.waitForTimeout(6000);

  const cta = page.locator("button.btn-primary").filter({ hasText: /Review payment|No executable|Choose payment|Enter a valid|Fix amount|Refreshing|Couldn't get|Not enough|No route|Can't use/i }).first();
  out.ctaLabel = (await cta.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  out.ctaDisabled = await cta.isDisabled().catch(() => null);
  if (out.ctaDisabled) {
    out.blockedText = (await page.evaluate(() => document.body.innerText)).slice(0, 1200);
  }
  await cta.dispatchEvent("click", undefined, { timeout: 8000 }).catch((e) => out.steps.push("cta:" + e.message.split("\n")[0]));
  await page.waitForTimeout(2500);
  const reviewText = await page.evaluate(() => document.body.innerText);
  out.reviewReached = /Confirm & Send|Confirm and send/i.test(reviewText);
  out.reviewText = reviewText.slice(0, 1400);
  await page.screenshot({ path: path.join(outDir, "review.png"), fullPage: true });

  if (out.reviewReached) {
    await page.locator("button", { hasText: /Confirm & Send|Confirm and send/i }).first().dispatchEvent("click", undefined, { timeout: 8000 }).catch((e) => out.steps.push("confirm:" + e.message.split("\n")[0]));
    out.samples = [];
    for (let i = 0; i < 100; i++) {
      await page.waitForTimeout(1500);
      const t = await page.evaluate(() => document.body.innerText);
      const stepEls = await page.evaluate(() => Array.from(document.querySelectorAll("div.flex.items-center.gap-2.text-xs")).map((e) => e.innerText.replace(/\n/g, " ")));
      out.samples.push({
        stepEls,
        t: (i + 1) * 1.5,
        len: t.trim().length,
        blank: t.trim().length < 40,
        waiting: /Waiting for confirmation/i.test(t),
        success: /delivered|sent|View on explorer/i.test(t),
        unresolved: /Transaction status unknown/i.test(t),
        wrapLabel: (t.match(/Wrap MON for the route/) || [null])[0],
        err: (t.match(/[^\n]*(error|couldn't|failed|unavailable|revert)[^\n]*/i) || [null])[0],
      });
    }
    await page.screenshot({ path: path.join(outDir, "after-confirm.png"), fullPage: true });
  }
} catch (e) {
  out.fatal = String(e).slice(0, 500);
}
out.api = api.slice(0, 20);
out.pageErrors = logs.filter((l) => l.startsWith("PAGEERROR")).slice(0, 8);
out.consoleErrors = logs.filter((l) => /error|Refused|CSP/i.test(l)).slice(0, 12);
fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await browser.close();
process.exit(0);
