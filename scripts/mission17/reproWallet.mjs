// Mission 17 — Defect A empirical reproduction.
//
// Trust Wallet's Android in-app browser is a legacy-only provider: no EIP-6963,
// it sets `window.ethereum` + `window.trustwallet.ethereum` after the page has
// booted. This script injects such a provider at a controlled delay and checks
// whether the app ever offers it.
//
//   node scripts/mission17/reproWallet.mjs <url> <delayMs> [outDir]
//
// A delay beyond the discovery poll window is the reported "detected late /
// never detected" mobile case.

import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const base = process.argv[2] ?? "https://intent-pay-roan.vercel.app";
const delayMs = Number(process.argv[3] ?? 9000);
const outDir = process.argv[4] ?? "/tmp/mission17wallet";
fs.mkdirSync(outDir, { recursive: true });

const ACCOUNT = "0x1111111111111111111111111111111111111111";

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const ctx = await browser.newContext({
  viewport: { width: 420, height: 900 },
  userAgent:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Mobile Safari/537.36",
});

const consoleLines = [];

// A Trust-Wallet-style legacy provider. Deliberately does NOT implement
// EIP-6963 and does NOT dispatch `ethereum#initialized` — the strictest case.
await ctx.addInitScript(
  ({ account, delay }) => {
    const provider = {
      isTrust: true,
      isTrustWallet: true,
      isMetaMask: true, // Trust sets this for dapp compatibility
      request: async ({ method }) => {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [account];
        if (method === "eth_chainId") return "0x8f"; // 143
        return null;
      },
      on: () => {},
      removeListener: () => {},
    };
    window.__injectedAt = null;
    setTimeout(() => {
      window.ethereum = provider;
      window.trustwallet = { ethereum: provider };
      window.__injectedAt = Date.now();
    }, delay);
  },
  { account: ACCOUNT, delay: delayMs },
);

const page = await ctx.newPage();
page.on("console", (m) => consoleLines.push(`${m.type()}: ${m.text()}`.slice(0, 300)));
page.on("pageerror", (e) => consoleLines.push(`pageerror: ${String(e).slice(0, 300)}`));

const result = { base, delayMs, steps: [] };
try {
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(delayMs + 3000);

  const injectedAt = await page.evaluate(() => window.__injectedAt ?? null);
  const hasGlobals = await page.evaluate(() => ({
    ethereum: typeof window.ethereum !== "undefined",
    trustwallet: typeof window.trustwallet?.ethereum !== "undefined",
  }));
  result.injectedAt = injectedAt;
  result.globals = hasGlobals;

  // Open the wallet picker (the connect control).
  const connect = page.locator("button.btn-primary").first();
  await connect.dispatchEvent("click", undefined, { timeout: 8000 }).catch((e) => {
    result.steps.push(`connect-click-failed: ${e.message.split("\n")[0]}`);
  });
  await page.waitForTimeout(2500);

  const text = await page.evaluate(() => document.body.innerText);
  result.pickerText = text.slice(0, 1800);
  result.detectedTrust = /Trust Wallet/i.test(text);
  result.detectedAny = /Detected in this browser/i.test(text);
  result.noWalletNote = /No browser wallet detected/i.test(text);
  await page.screenshot({ path: path.join(outDir, "picker.png"), fullPage: true });

  // Now exercise the explicit "Rescan" affordance and re-check.
  const rescan = page.getByRole("button", { name: /rescan/i }).first();
  if (await rescan.isVisible().catch(() => false)) {
    await rescan.dispatchEvent("click", undefined, { timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(2000);
    const after = await page.evaluate(() => document.body.innerText);
    result.detectedTrustAfterRescan = /Trust Wallet/i.test(after);
    result.pickerTextAfterRescan = after.slice(0, 1200);
  } else {
    result.rescanVisible = false;
  }
} catch (e) {
  result.fatal = String(e).slice(0, 400);
}

result.consoleTail = consoleLines.slice(-25);
fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(result, null, 2));
await browser.close();

console.log(JSON.stringify(
  {
    delayMs,
    injectedAt: result.injectedAt,
    globals: result.globals,
    detectedTrust: result.detectedTrust,
    detectedTrustAfterRescan: result.detectedTrustAfterRescan,
    noWalletNote: result.noWalletNote,
    steps: result.steps,
    fatal: result.fatal,
  },
  null,
  2,
));
