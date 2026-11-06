// Mission 19 — late-injection matrix. Tests the exact shapes a Trust Wallet
// in-app browser may use, injected AFTER the app has loaded:
//   ethereum       — only window.ethereum
//   trust-only     — only window.trustwallet.ethereum (the native layer sets it first)
//   trust-then-eth — window.trustwallet.ethereum at T, window.ethereum at T+1500
// Records whether the picker ever offers the wallet, and how many rows appear.
import fs from "node:fs";
import { chromium } from "playwright";

const base = process.argv[2] ?? "https://intent-pay-roan.vercel.app";
const injectMs = Number(process.argv[3] ?? 9000);
const shapes = ["ethereum", "trust-only", "trust-then-eth", "trust-announce"];

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

const results = {};
for (const shape of shapes) {
  const ctx = await browser.newContext({ viewport: { width: 430, height: 940 } });
  await ctx.addInitScript(
    ({ injectMs, shape }) => {
      const mk = () => ({
        isMetaMask: true, // Trust sets this for dapp compatibility
        isTrust: true,
        request: async ({ method }) =>
          method === "eth_requestAccounts" || method === "eth_accounts"
            ? ["0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4"]
            : method === "eth_chainId"
              ? "0x8f"
              : null,
        on: () => {},
        removeListener: () => {},
      });
      const inject = () => {
        const p = mk();
        if (shape === "ethereum") {
          window.ethereum = p;
        } else if (shape === "trust-only") {
          window.trustwallet = { ethereum: p };
        } else if (shape === "trust-announce") {
          // Trust Wallet on newer Android injects the SAME provider on
          // window.trustwallet.ethereum and window.ethereum AND announces it
          // via EIP-6963 (rdns com.trustwallet.app).
          window.trustwallet = { ethereum: p };
          window.ethereum = p;
          const info = { uuid: "trust-uuid", name: "Trust Wallet", icon: "", rdns: "com.trustwallet.app" };
          const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info, provider: p } }));
          window.addEventListener("eip6963:requestProvider", announce);
          announce();
        } else {
          window.trustwallet = { ethereum: p };
          setTimeout(() => {
            window.ethereum = p;
          }, 1500);
        }
        window.__injectedAt = Date.now();
      };
      setTimeout(inject, injectMs);
    },
    { injectMs, shape },
  );
  const page = await ctx.newPage();
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1000);
  await page.locator("button.btn-primary", { hasText: /Connect wallet/i }).first().dispatchEvent("click").catch(() => {});
  const t0 = Date.now();
  let discoveredAt = null;
  let rows = 0;
  for (let i = 0; i < 30; i++) {
    const snap = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button")).filter((b) => /Detected in this browser/i.test(b.innerText));
      return { names: btns.map((b) => b.innerText.split("\n")[0].trim()), noWallet: /No browser wallet detected/i.test(document.body.innerText) };
    });
    if (snap.names.length > 0) {
      discoveredAt = Date.now() - t0;
      rows = snap.names.length;
      results[shape] = { discoveredAt, rows, names: snap.names, noWallet: snap.noWallet };
      break;
    }
    await page.waitForTimeout(1000);
  }
  if (!results[shape]) results[shape] = { discoveredAt: null, rows: 0, names: [], noWallet: true };
  await ctx.close();
}
console.log(JSON.stringify({ base, injectMs, results }, null, 2));
fs.writeFileSync("/tmp/m19-late-matrix.json", JSON.stringify({ base, injectMs, results }, null, 2));
await browser.close();
process.exit(0);
