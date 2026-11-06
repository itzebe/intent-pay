// Mission 19 — Failure A: the accountsChanged race.
//
// A real pattern (Trust Wallet's in-app browser, some mobile wallets): the FIRST
// eth_requestAccounts resolves with an EMPTY list and the wallet then emits
// accountsChanged([account]) once the user approves. Does the app connect, or
// does connect()'s own success/failure write overwrite the event?
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const base = process.argv[2] ?? "https://intent-pay-roan.vercel.app";
const outDir = process.argv[3] ?? "/tmp/m19-race";
fs.mkdirSync(outDir, { recursive: true });
const ACCOUNT = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4";

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const ctx = await browser.newContext({ viewport: { width: 430, height: 940 } });
await ctx.addInitScript(
  ({ account }) => {
    const listeners = {};
    const emit = (ev, v) => (listeners[ev] ?? []).forEach((fn) => fn(v));
    let asked = 0;
    const provider = {
      isMetaMask: true,
      request: async ({ method }) => {
        if (method === "eth_requestAccounts") {
          asked += 1;
          // First call: the wallet hasn't opened yet -> empty, then the user
          // approves and the wallet announces the account via the event.
          if (asked === 1) {
            setTimeout(() => emit("accountsChanged", [account]), 700);
            return [];
          }
          return [account];
        }
        if (method === "eth_accounts") return [account];
        if (method === "eth_chainId") return "0x8f";
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
  { account: ACCOUNT },
);

const page = await ctx.newPage();
const out = { base, samples: [] };
await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(3000);
const connect = page.locator("button.btn-primary", { hasText: /Connect wallet/i }).first();
await connect.dispatchEvent("click", undefined, { timeout: 8000 }).catch(() => {});
await page.waitForTimeout(2500);
const injectedBtn = page.locator("button", { hasText: /Detected in this browser/i }).first();
await injectedBtn.dispatchEvent("click", undefined, { timeout: 6000 }).catch(() => {});
const t0 = Date.now();
for (let i = 0; i < 8; i++) {
  const text = await page.evaluate(() => document.body.innerText);
  out.samples.push({
    t: Date.now() - t0,
    connected: /0x7A91/i.test(text),
    error: (text.match(/[^\n]*(didn't share|Couldn't connect)[^\n]*/i) || [null])[0],
  });
  await page.waitForTimeout(600);
}
out.finalConnected = out.samples[out.samples.length - 1].connected;
out.sawError = out.samples.some((s) => s.error);
await page.screenshot({ path: path.join(outDir, "after.png"), fullPage: true });
fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await browser.close();
process.exit(0);
