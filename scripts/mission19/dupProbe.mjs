// Mission 19 — duplicate-entry probe. A wallet that is present on window.ethereum
// BEFORE the app loads (legacy-first) AND announces via EIP-6963. The picker must
// list it once.
import { chromium } from "playwright";
const base = process.argv[2] ?? "https://intent-pay-roan.vercel.app";
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext({ viewport: { width: 430, height: 940 } });
await ctx.addInitScript(() => {
  const p = {
    isMetaMask: true,
    request: async ({ method }) => (method === "eth_requestAccounts" || method === "eth_accounts" ? ["0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4"] : method === "eth_chainId" ? "0x8f" : null),
    on: () => {}, removeListener: () => {},
  };
  // Legacy slot is populated before any app script runs.
  window.ethereum = p;
  const info = { uuid: "mm-uuid", name: "MetaMask", icon: "", rdns: "io.metamask" };
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info, provider: p } }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
});
const page = await ctx.newPage();
await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(1500);
await page.locator("button.btn-primary", { hasText: /Connect wallet/i }).first().dispatchEvent("click").catch(() => {});
await page.waitForTimeout(2000);
const names = await page.evaluate(() => Array.from(document.querySelectorAll("button")).filter((b) => /Detected in this browser/i.test(b.innerText)).map((b) => b.innerText.split("\n")[0].trim()));
console.log(JSON.stringify({ base, rows: names.length, names }, null, 2));
await browser.close();
process.exit(0);
