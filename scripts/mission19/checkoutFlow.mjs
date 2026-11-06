// Mission 19 — drive the REAL local checkout page (`/checkout/:token`) through
// "Pay $X" with a stub wallet that returns a REAL mined Monad tx hash, so the
// page's own waitForTransactionReceipt → submit → verify → success path runs
// against the real chain. No signature, no approval, no new transaction.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:3210";
const token = process.argv[3];
const outDir = process.argv[4] ?? "/tmp/m19-checkout";
fs.mkdirSync(outDir, { recursive: true });
const ACCOUNT = process.argv[5] ?? "0x28f64a62ab3b284d667115cf66782b094f412eec";
const REAL_HASH = "0x209c13872f077d7801b0a70bf4166289e44b8a3934c76b0b39be2292ee88383e";

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
page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`.slice(0, 400)));
page.on("pageerror", (e) => logs.push(`PAGEERROR: ${String(e.stack ?? e).slice(0, 600)}`));
const api = [];
page.on("response", async (res) => {
  if (!/\/api\//.test(res.url())) return;
  let body = null; try { body = await res.json(); } catch {}
  api.push({ res: res.url().replace(base, "").slice(0, 90), status: res.status(), ok: body?.ok, code: body?.error?.code ?? body?.code, msg: body?.error?.message });
});

const out = { base, token, steps: [] };
try {
  await page.goto(`${base}/checkout/${token}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  out.initialText = (await page.evaluate(() => document.body.innerText)).slice(0, 700);

  // Connect the injected wallet from the checkout page's own ConnectButton.
  await page.locator("button", { hasText: /Connect/i }).first().dispatchEvent("click").catch((e) => out.steps.push("connect:" + e.message.split("\n")[0]));
  await page.waitForTimeout(1200);
  await page.locator("button", { hasText: /Detected in this browser/i }).first().dispatchEvent("click").catch((e) => out.steps.push("pick:" + e.message.split("\n")[0]));
  await page.waitForTimeout(3000);
  out.connected = /0x28f6/i.test(await page.evaluate(() => document.body.innerText));

  const pay = page.locator("button", { hasText: /^Pay \$/ }).first();
  out.payLabel = (await pay.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  await pay.dispatchEvent("click", undefined, { timeout: 8000 }).catch((e) => out.steps.push("pay:" + e.message.split("\n")[0]));
  out.samples = [];
  for (let i = 0; i < 16; i++) {
    await page.waitForTimeout(1500);
    const t = await page.evaluate(() => document.body.innerText);
    out.samples.push({
      t: (i + 1) * 1.5,
      len: t.trim().length,
      blank: t.trim().length < 40,
      waiting: /Waiting for your wallet/i.test(t),
      confirming: /confirming on-chain/i.test(t),
      verified: /Payment complete/i.test(t),
      err: (t.match(/[^\n]*(error|couldn't|failed|unavailable|revert|declined)[^\n]*/i) || [null])[0],
    });
    if (out.samples[i].verified || out.samples[i].err) break;
  }
  await page.screenshot({ path: path.join(outDir, "checkout-after-pay.png"), fullPage: true });
  out.finalText = (await page.evaluate(() => document.body.innerText)).slice(0, 900);
} catch (e) {
  out.fatal = String(e).slice(0, 600);
}
out.api = api.slice(0, 30);
out.pageErrors = logs.filter((l) => l.startsWith("PAGEERROR")).slice(0, 8);
out.consoleErrors = logs.filter((l) => /error/i.test(l)).slice(0, 10);
fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await browser.close();
process.exit(0);
