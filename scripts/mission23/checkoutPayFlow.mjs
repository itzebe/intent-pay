// Mission 23 — drive the REAL hosted checkout page (`/checkout/:token`) through
// "Pay $X". The wallet answers eth_sendTransaction with a REAL mined Monad hash
// (env REAL_HASH) so the page's own receipt wait + verify + success path runs
// against the real chain, or with a never-mined hash to exercise the unresolved
// path. No signature, no approval, no new transaction.
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:3200";
const token = process.argv[3];
const ADDR = process.argv[4] ?? "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A";
const REAL_HASH = process.env.REAL_HASH ?? "0x209c13872f077d7801b0a70bf4166289e44b8a3934c76b0b39be2292ee88383e";
const providerKind = process.argv[5] ?? "legacy";

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const ctx = await browser.newContext({ viewport: { width: 430, height: 940 } });
await ctx.addInitScript(
  ({ addr, hash, kind }) => {
    window.__probe = { methods: [], sends: [] };
    const provider = {
      isMetaMask: true,
      request: async ({ method, params }) => {
        window.__probe.methods.push(method);
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [addr];
        if (method === "eth_chainId") return "0x8f";
        if (method === "eth_sendTransaction") {
          window.__probe.sends.push(params?.[0]?.to ?? "?");
          return hash;
        }
        if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
        return null;
      },
      on: () => {},
      removeListener: () => {},
    };
    window.ethereum = provider;
    if (kind === "eip6963") {
      const info = { uuid: "u-mm", name: "MetaMask", icon: "", rdns: "io.metamask" };
      const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info, provider } }));
      window.addEventListener("eip6963:requestProvider", announce);
      announce();
    }
  },
  { addr: ADDR, hash: REAL_HASH, kind: providerKind },
);

const page = await ctx.newPage();
const errors = [];
const consoleErrors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 220)); });
const snaps = [];
const snap = async (label) => { const t = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ")); snaps.push({ label, len: t.trim().length, text: t.slice(0, 300) }); return t; };

await page.goto(`${base}/checkout/${token}`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(3500);
await snap("loaded");

// Connect
await page.getByRole("button", { name: /Connect wallet/i }).first().click({ timeout: 5000 }).catch(() => {});
await page.waitForTimeout(1200);
await page.getByRole("button", { name: /MetaMask|Trust Wallet|Browser wallet|Detected/i }).first().click({ timeout: 5000 }).catch(() => {});
await page.waitForTimeout(2500);
await snap("connected");

// Pay
const pay = page.getByRole("button", { name: /^Pay \$|^Pay / }).first();
const payLabel = await pay.innerText().catch(() => "");
await pay.click({ timeout: 6000 }).catch(() => {});
for (let i = 0; i < 12; i++) { await page.waitForTimeout(1500); await snap(`t+${(i + 1) * 1.5}s`); }

const probe = await page.evaluate(() => window.__probe);
console.log(JSON.stringify({ base, token, payLabel, errors, consoleErrors: consoleErrors.slice(0, 6), probe, snaps }, null, 2));
await browser.close();
