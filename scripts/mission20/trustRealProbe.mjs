// Mission 20 Gate 2/5 — faithful reproduction of Trust Wallet's REAL in-app
// browser surface (from github.com/trustwallet/trust-web3-provider):
//   * window.trustwallet.ethereum is a FACTORY FUNCTION (not a provider)
//   * window.ethereum is the real EIP-1193 provider
//   * chain reads are proxied via page-context fetch() to the wallet's rpcUrl
// We then (a) check discovery, (b) connect, (c) observe every method the app
// calls through the provider, and (d) see whether the wallet-RPC fetch is
// allowed by the production CSP. No signature, no transaction.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const base = process.argv[2] ?? "https://intent-pay-roan.vercel.app";
const scheme = process.argv[3] ?? "http"; // wallet's configured rpcUrl scheme
const outDir = process.argv[4] ?? "/tmp/m20trust";
fs.mkdirSync(outDir, { recursive: true });
const ACCOUNT = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4";

const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox","--disable-dev-shm-usage"] });
const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
const logs = [];
await ctx.addInitScript(({ account, scheme }) => {
  const RPC = `${scheme}://monad.twnodes.com/`;
  window.__calls = [];
  const provider = {
    isTrust: true, isTrustWallet: true, isMetaMask: true,
    request: async ({ method, params }) => {
      window.__calls.push(method);
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [account];
      if (method === "eth_chainId") {
        // Trust proxies chain reads to its own node from the page context.
        const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }) });
        const j = await res.json();
        return j.result;
      }
      // Everything else (eth_call, eth_estimateGas, eth_sendTransaction…) is
      // wallet-side / node-proxied; emulate a successful read.
      return "0x0";
    },
    on: () => {}, removeListener: () => {},
  };
  // REAL Trust shape: a factory function, not a provider.
  window.trustwallet = { ethereum: function EthereumProviderFactory(config) { return provider; }, Provider: function(){} };
  window.ethereum = provider;
}, { account: ACCOUNT, scheme });

const page = await ctx.newPage();
page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`.slice(0, 400)));
page.on("pageerror", (e) => logs.push(`pageerror: ${String(e).slice(0, 300)}`));
const result = { base, scheme, steps: [] };
try {
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  await page.locator("button.btn-primary").first().dispatchEvent("click", undefined, { timeout: 8000 }).catch((e)=>result.steps.push("click:"+e.message.split("\n")[0]));
  await page.waitForTimeout(2000);
  const pickerText = await page.evaluate(() => document.body.innerText);
  result.noWalletNote = /No browser wallet detected/i.test(pickerText);
  result.listedTrust = /Trust Wallet/i.test(pickerText);
  result.listedMetaMask = /MetaMask/i.test(pickerText);
  const trust = page.getByRole("button", { name: /Trust Wallet|MetaMask|Browser wallet/i }).first();
  if (await trust.isVisible().catch(()=>false)) {
    await trust.dispatchEvent("click", undefined, { timeout: 6000 }).catch((e)=>result.steps.push("choose:"+e.message.split("\n")[0]));
    await page.waitForTimeout(3500);
  }
  const after = await page.evaluate(() => document.body.innerText);
  result.connectedAddressShown = /0x7A91/i.test(after);
  result.walletErrorShown = /Couldn't connect|rejected|not configured|couldn't reach/i.test(after);
  result.errorText = (after.match(/(Couldn't[^\n]{0,140}|couldn't[^\n]{0,140}|No browser wallet[^\n]{0,80})/)||[""])[0];
  result.providerCalls = await page.evaluate(() => window.__calls || []);
  result.afterText = after.slice(0, 900);
  await page.screenshot({ path: path.join(outDir, `after-${scheme}.png`), fullPage: true });
} catch (e) { result.fatal = String(e).slice(0, 300); }
result.cspViolations = logs.filter((l) => /content security policy|refused to connect/i.test(l)).slice(0, 3);
fs.writeFileSync(path.join(outDir, `report-${scheme}.json`), JSON.stringify(result, null, 2));
await browser.close();
console.log(JSON.stringify({ scheme: result.scheme, noWalletNote: result.noWalletNote, listedTrust: result.listedTrust, listedMetaMask: result.listedMetaMask, connectedAddressShown: result.connectedAddressShown, walletErrorShown: result.walletErrorShown, errorText: result.errorText, providerCalls: result.providerCalls, cspViolations: result.cspViolations.length, steps: result.steps, fatal: result.fatal }, null, 2));
