// Mission 19 — Failure A matrix. Drives the real deployed UI; only the wallet
// is stubbed. Each mode is a real-world injected-provider shape.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const base = process.argv[2] ?? "https://intent-pay-roan.vercel.app";
const mode = process.argv[3] ?? "eip6963";
const outDir = process.argv[4] ?? `/tmp/m19-${mode}`;
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
    const listeners = {};
    const mk = (opts = {}) => {
      const p = {
        ...opts,
        request: async ({ method }) => {
          calls.push(method);
          if (method === "eth_requestAccounts" || method === "eth_accounts") {
            if (base === "emptyfirst" && calls.filter((c) => c === method).length === 1) return [];
            return [account];
          }
          if (method === "eth_chainId") {
            if (base === "proxied") throw new TypeError("Failed to fetch");
            if (base === "wrongchain") return "0x1";
            return "0x8f";
          }
          return null;
        },
        on: (ev, fn) => {
          (listeners[ev] ??= []).push(fn);
        },
        removeListener: () => {},
      };
      return p;
    };
    window.__emit = (ev, val) => (listeners[ev] ?? []).forEach((fn) => fn(val));
    window.__calls = calls;

    const base = mode.replace("+empty", "");
    const provider = mk({ isMetaMask: true });
    const install = () => {
      window.ethereum = provider;
      if (base === "eip6963" || base === "dup") {
        const announce = () =>
          window.dispatchEvent(
            new CustomEvent("eip6963:announceProvider", {
              detail: { info: { uuid: "uuid-meta", name: "MetaMask", icon: "", rdns: "io.metamask" }, provider },
            }),
          );
        window.addEventListener("eip6963:requestProvider", announce);
        announce();
      }
      if (base === "eip6963only") {
        // Not on window.ethereum at all — only EIP-6963.
        delete window.ethereum;
        const announce = () =>
          window.dispatchEvent(
            new CustomEvent("eip6963:announceProvider", {
              detail: { info: { uuid: "uuid-solo", name: "Solo Wallet", icon: "", rdns: "io.solo" }, provider },
            }),
          );
        window.addEventListener("eip6963:requestProvider", announce);
        announce();
      }
      if (base === "providers") {
        window.ethereum = { ...mk(), providers: [provider] };
      }
    };
    if (base === "late") {
      setTimeout(install, 9000);
    } else {
      install();
    }
  },
  { account: ACCOUNT, mode },
);

const page = await ctx.newPage();
page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`.slice(0, 200)));
const out = { base, mode, steps: [] };
try {
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60000 });
  // For the late case, click Connect before the provider exists.
  await page.waitForTimeout(base === "late" ? 1500 : 3000);

  const connect = page.locator("button.btn-primary", { hasText: /Connect wallet/i }).first();
  await connect.dispatchEvent("click", undefined, { timeout: 8000 }).catch((e) => out.steps.push("click:" + e.message.split("\n")[0]));
  await page.waitForTimeout(base === "late" ? 10000 : 2500);

  const pickerText = await page.evaluate(() => document.body.innerText);
  out.noWalletNote = /No browser wallet detected/i.test(pickerText);
  const entries = await page.locator("div[role='dialog'] button").allInnerTexts().catch(() => []);
  out.pickerEntries = entries.map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean);

  const injectedBtn = page.locator("button", { hasText: /Detected in this browser/i }).first();
  out.injectedEntryPresent = await injectedBtn.isVisible().catch(() => false);
  if (out.injectedEntryPresent) {
    await injectedBtn.dispatchEvent("click", undefined, { timeout: 6000 }).catch((e) => out.steps.push("choose:" + e.message.split("\n")[0]));
    await page.waitForTimeout(2500);
    // Some wallets emit accountsChanged([]) then accountsChanged([acct]) right
    // after a connect. Only probe that when asked (mode suffix "+empty").
    if (mode.endsWith("+empty")) {
      await page.evaluate(() => window.__emit && window.__emit("accountsChanged", []));
      await page.waitForTimeout(800);
      out.afterEmptyAccountsChanged = /0x7A91/i.test(await page.evaluate(() => document.body.innerText));
    }
  }

  const after = await page.evaluate(() => document.body.innerText);
  out.connectedAddressShown = /0x7A91/i.test(after);
  out.walletErrorShown = /Couldn't connect|didn't share|rejected|not configured|reach the Monad/i.test(after);
  out.providerCalls = await page.evaluate(() => window.__calls ?? []);
  await page.screenshot({ path: path.join(outDir, "after.png"), fullPage: true });
} catch (e) {
  out.fatal = String(e).slice(0, 300);
}
fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await browser.close();
process.exit(0);
