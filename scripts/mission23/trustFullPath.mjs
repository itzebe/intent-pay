// Mission 23 — drive the REAL Trust provider bundle through the FULL composer
// flow (connect → amount → Review → Confirm) with a FUNDED Monad address, and
// record every wallet method, every twnodes fetch, every app API call, and the
// exact screen state after each step. No signature, no approval, no tx: the
// native adapter answers eth_sendTransaction with a stub hash.
import fs from "node:fs";
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:3000";
const ADDR = process.argv[3] ?? "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A";
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const HASH = "0x" + "ab".repeat(32);
const bundle = fs.readFileSync(process.env.TRUST_MIN ?? "/tmp/trust_min.js", "utf8");

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const ctx = await browser.newContext({ viewport: { width: 430, height: 980 } });
const net = [];
ctx.on("request", (r) => {
  const u = r.url();
  if (/twnodes/.test(u)) net.push(`${r.method()} ${u}`);
});
const api = [];
ctx.on("response", async (r) => {
  const u = r.url();
  if (/\/api\//.test(u) && !/balances\?|capabilities|tokens\?/.test(u)) {
    api.push(`${r.status()} ${r.request().method()} ${u.replace(base, "")}`);
  }
});

await ctx.addInitScript(
  ({ bundle, addr, hash }) => {
    window.__probe = { calls: [], approvals: 0 };
    (0, eval)(bundle);
    const provider = window.trustwallet.ethereum({ chainId: 143, rpcUrl: "http://monad.twnodes.com/" });
    provider.setAdapter({
      getStrategy: () => undefined,
      request: async (e) => {
        const name = e && (e.name || e.method);
        if (name === "requestAccounts") return [addr];
        if (name === "signTransaction") { window.__probe.approvals++; return hash; }
        if (name === "wallet_requestPermissions") return JSON.stringify([{ caveats: [{ value: [addr] }] }]);
        if (name === "switchEthereumChain" || name === "addEthereumChain") return null;
        throw Object.assign(new Error("native: unsupported " + name), { code: 4200 });
      },
    });
    const orig = provider.request.bind(provider);
    provider.request = async (a) => {
      try {
        const r = await orig(a);
        window.__probe.calls.push({ method: a.method, ok: true });
        return r;
      } catch (e) {
        window.__probe.calls.push({ method: a.method, ok: false, error: String(e && e.message).slice(0, 100), code: e && e.code });
        throw e;
      }
    };
    window.ethereum = provider;
    const info = { uuid: "trust", name: "Trust Wallet", icon: "", rdns: "com.trustwallet.app" };
    const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info, provider } }));
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
  },
  { bundle, addr: ADDR, hash: HASH },
);

const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 260)));

async function clickText(re, wait = 1500) {
  const loc = page.getByRole("button", { name: re }).first();
  if ((await loc.count()) === 0) return false;
  await loc.click({ timeout: 5000 }).catch(async () => { await loc.dispatchEvent("click").catch(() => {}); });
  await page.waitForTimeout(wait);
  return true;
}
const snap = async () => (await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ")));

const out = { base, addr: ADDR, steps: {} };
await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(2500);
out.steps.connect = await clickText(/Connect wallet/i);
out.steps.pick = await clickText(/Trust Wallet|MetaMask|Browser wallet/i, 2500);
out.connected = /0x3bd3|0x3BD3/i.test(await snap());

// Recipient
const rec = page.locator("#recipient");
if (await rec.count()) { await rec.fill(RECIPIENT); await page.waitForTimeout(500); }
// Pick the receive token (the composer needs one before it can quote).
const choose = page.getByRole("button", { name: /Choose receive token/i }).first();
if (await choose.count()) {
  await choose.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(800);
  const usdc = page.getByRole("button", { name: /USDC/i }).first();
  if (await usdc.count()) await usdc.click({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(800);
}
// Amount (USD, "recipient receives")
const amt = page.locator('input[aria-label="Recipient receives"], input[inputmode="decimal"]').first();
if (await amt.count()) { await amt.fill("1"); await page.waitForTimeout(5000); }
out.afterAmount = (await snap()).slice(0, 260);
out.reviewCta = await page.getByRole("button", { name: /Review payment|No route|Not enough|Enter a valid|Choose|Couldn't|Fix|Refreshing|No executable/i }).first().innerText().catch(() => "");
out.reviewCtaDisabled = await page.getByRole("button", { name: /Review payment/i }).first().isDisabled().catch(() => null);
out.steps.review = await clickText(/Review payment/i, 3500);
out.reviewReached = /Confirm/i.test(await snap());
out.afterReview = (await snap()).slice(0, 300);
out.steps.confirm = await clickText(/^Confirm|Confirm & send|Confirm and send|Confirm payment/i, 8000);
out.afterConfirm = (await snap()).slice(0, 400);

const evald = await page.evaluate(() => ({ calls: window.__probe.calls, approvals: window.__probe.approvals }));
out.providerCalls = evald.calls;
out.approvals = evald.approvals;
out.twnodesRequests = net;
out.apiCalls = api.slice(0, 30);
out.pageErrors = pageErrors;
console.log(JSON.stringify(out, null, 2));
await browser.close();
