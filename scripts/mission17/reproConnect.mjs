// Mission 18 — direct injected-wallet connect reproduction.
//
// Injects a Trust-Wallet-style legacy provider whose eth_* calls are proxied to
// the wallet's OWN RPC (monad.twnodes.com) from the page context — exactly how a
// page-world injected provider behaves. Then clicks "Connect wallet" and reports
// whether the app connected the injected wallet directly.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const base = process.argv[2] ?? "https://intent-pay-roan.vercel.app";
const outDir = process.argv[3] ?? "/tmp/mission18connect";
fs.mkdirSync(outDir, { recursive: true });
const ACCOUNT = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4";

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
const logs = [];
await ctx.addInitScript(({ account }) => {
  const RPC = "https://monad.twnodes.com/";
  const provider = {
    isTrust: true, isTrustWallet: true, isMetaMask: true,
    request: async ({ method, params }) => {
      // A real wallet answers account methods locally from its own keystore...
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [account];
      // ...and proxies *chain reads* to its own node (from the page context).
      const res = await fetch(RPC, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }),
      });
      const j = await res.json();
      if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code });
      return j.result;
    },
    on: () => {}, removeListener: () => {},
  };
  window.__rpcProbe = async () => {
    try { await provider.request({ method: "eth_chainId" }); return "ok"; }
    catch (e) { return "error: " + String(e).slice(0, 160); }
  };
  window.ethereum = provider;
  window.trustwallet = { ethereum: provider };
}, { account: ACCOUNT });

const page = await ctx.newPage();
page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`.slice(0, 260)));
page.on("pageerror", (e) => logs.push(`pageerror: ${String(e).slice(0, 260)}`));
const result = { base, steps: [] };
try {
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  result.rpcProbeFromPage = await page.evaluate(() => window.__rpcProbe());
  const connect = page.locator("button.btn-primary").first();
  await connect.dispatchEvent("click", undefined, { timeout: 8000 }).catch((e) => result.steps.push("click:" + e.message.split("\n")[0]));
  await page.waitForTimeout(3000);
  const pickerText = await page.evaluate(() => document.body.innerText);
  result.listedTrust = /Trust Wallet/i.test(pickerText);
  result.noWalletNote = /No browser wallet detected/i.test(pickerText);
  // Choose the injected Trust Wallet entry.
  const trust = page.getByRole("button", { name: /Trust Wallet/i }).first();
  if (await trust.isVisible().catch(() => false)) {
    await trust.dispatchEvent("click", undefined, { timeout: 6000 }).catch((e) => result.steps.push("choose:" + e.message.split("\n")[0]));
    await page.waitForTimeout(3500);
  }
  const after = await page.evaluate(() => document.body.innerText);
  result.connectedAddressShown = /0x7A91/i.test(after);
  result.connectedMenu = /Connected/i.test(after);
  result.walletErrorShown = /Couldn't connect|rejected|WalletConnect is not configured/i.test(after);
  result.afterText = after.slice(0, 1400);
  await page.screenshot({ path: path.join(outDir, "after-connect.png"), fullPage: true });
} catch (e) { result.fatal = String(e).slice(0, 400); }
result.consoleTail = logs.slice(-30);
fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(result, null, 2));
await browser.close();
console.log(JSON.stringify({
  rpcProbeFromPage: result.rpcProbeFromPage,
  listedTrust: result.listedTrust,
  noWalletNote: result.noWalletNote,
  connectedAddressShown: result.connectedAddressShown,
  connectedMenu: result.connectedMenu,
  walletErrorShown: result.walletErrorShown,
  steps: result.steps, fatal: result.fatal,
}, null, 2));
