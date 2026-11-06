// Mission 19 — Failure A: does ONE "Connect wallet" action connect an injected
// wallet directly? Drives the real deployed UI. Only the wallet is stubbed.
//
// Variants:
//   eip6963  — a MetaMask-style provider that announces via EIP-6963 AND is on
//              window.ethereum (the common desktop case).
//   legacy   — a Trust-Wallet-style legacy-only provider.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const base = process.argv[2] ?? "https://intent-pay-roan.vercel.app";
const mode = process.argv[3] ?? "eip6963";
const outDir = process.argv[4] ?? `/tmp/mission19-${mode}`;
fs.mkdirSync(outDir, { recursive: true });
const ACCOUNT = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4";

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const ctx = await browser.newContext({ viewport: { width: 430, height: 940 } });
const logs = [];
await ctx.addInitScript(
  ({ account, mode }) => {
    const calls = [];
    const provider = {
      isMetaMask: mode === "eip6963" ? true : undefined,
      isTrust: mode === "legacy" ? true : undefined,
      isTrustWallet: mode === "legacy" ? true : undefined,
      request: async ({ method }) => {
        calls.push(method);
        if (method === "eth_requestAccounts" || method === "eth_accounts") {
          if (mode === "emptyfirst") return calls.filter((c) => c === method).length === 1 ? [] : [account];
          return [account];
        }
        if (method === "eth_chainId") {
          // proxied: the wallet proxies the read to its own node, blocked by CSP
          if (mode === "proxied") throw new TypeError("Failed to fetch");
          if (mode === "wrongchain") return "0x1";
          return "0x8f";
        }
        if (method === "wallet_switchEthereumChain") return null;
        if (method === "wallet_addEthereumChain") return null;
        return null;
      },
      on: () => {},
      removeListener: () => {},
    };
    window.__calls = calls;
    window.ethereum = provider;
    if (mode === "legacy") window.trustwallet = { ethereum: provider };
    if (mode === "eip6963") {
      const announce = () =>
        window.dispatchEvent(
          new CustomEvent("eip6963:announceProvider", {
            detail: { info: { uuid: "uuid-meta", name: "MetaMask", icon: "", rdns: "io.metamask" }, provider },
          }),
        );
      window.addEventListener("eip6963:requestProvider", announce);
      announce();
    }
  },
  { account: ACCOUNT, mode },
);

const page = await ctx.newPage();
page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`.slice(0, 260)));
page.on("pageerror", (e) => logs.push(`pageerror: ${String(e).slice(0, 260)}`));
const out = { base, mode, steps: [] };
try {
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);

  // ONE user action: click Connect wallet.
  const connect = page.locator("button.btn-primary", { hasText: /Connect wallet/i }).first();
  out.connectButtonVisible = await connect.isVisible().catch(() => false);
  await connect
    .dispatchEvent("click", undefined, { timeout: 8000 })
    .catch((e) => out.steps.push("click:" + e.message.split("\n")[0]));
  await page.waitForTimeout(2500);

  const pickerText = await page.evaluate(() => document.body.innerText);
  out.pickerOpened = /Connect a wallet/i.test(pickerText);
  const pickerButtons = await page
    .locator("div[role='dialog'] button, .fixed button")
    .allInnerTexts()
    .catch(() => []);
  out.pickerEntries = pickerButtons.map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean);

  // Select the injected wallet (the entry labelled "Detected in this browser").
  const injectedBtn = page.locator("button", { hasText: /Detected in this browser/i }).first();
  out.injectedEntryPresent = await injectedBtn.isVisible().catch(() => false);
  if (out.injectedEntryPresent) {
    await injectedBtn
      .dispatchEvent("click", undefined, { timeout: 6000 })
      .catch((e) => out.steps.push("choose:" + e.message.split("\n")[0]));
    await page.waitForTimeout(3500);
  }

  const after = await page.evaluate(() => document.body.innerText);
  out.connectedAddressShown = /0x7A91/i.test(after);
  out.connectedMenu = /Connected|Connected via/i.test(after);
  out.walletErrorShown = /Couldn't connect|didn't share|rejected|not configured|reach the Monad network/i.test(after);
  out.errorLine = (after.match(/[^\n]*(Couldn't connect|didn't share|rejected|reach the Monad|not configured)[^\n]*/i) || [null])[0];
  out.providerCalls = await page.evaluate(() => window.__calls ?? []);
  out.afterText = after.slice(0, 1200);
  await page.screenshot({ path: path.join(outDir, "after.png"), fullPage: true });
} catch (e) {
  out.fatal = String(e).slice(0, 400);
}
out.consoleTail = logs.slice(-20);
fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await browser.close();
process.exit(0);
