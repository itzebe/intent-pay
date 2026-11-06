// Mission 19 — Failure A: multi-wallet picker. Two injected wallets (one
// announced + legacy, one announced-only) plus a legacy providers[] array.
// Clicks each entry in turn and records which actually connect.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const base = process.argv[2] ?? "https://intent-pay-roan.vercel.app";
const outDir = process.argv[3] ?? "/tmp/m19-multi";
fs.mkdirSync(outDir, { recursive: true });
const A1 = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4";
const A2 = "0x2222222222222222222222222222222222222222";

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const ctx = await browser.newContext({ viewport: { width: 430, height: 940 } });
await ctx.addInitScript(
  ({ a1, a2 }) => {
    const mk = (acct, flags) => ({
      ...flags,
      request: async ({ method }) =>
        method === "eth_requestAccounts" || method === "eth_accounts"
          ? [acct]
          : method === "eth_chainId"
            ? "0x8f"
            : null,
      on: () => {},
      removeListener: () => {},
    });
    const mm = mk(a1, { isMetaMask: true });
    const rabby = mk(a2, { isRabby: true });
    window.ethereum = mm;
    const announce = (info, provider) =>
      window.dispatchEvent(
        new CustomEvent("eip6963:announceProvider", { detail: { info, provider } }),
      );
    const all = () => {
      announce({ uuid: "u-mm", name: "MetaMask", icon: "", rdns: "io.metamask" }, mm);
      announce({ uuid: "u-rabby", name: "Rabby", icon: "", rdns: "io.rabby" }, rabby);
    };
    window.addEventListener("eip6963:requestProvider", all);
    all();
  },
  { a1: A1, a2: A2 },
);
const page = await ctx.newPage();
const out = { base, entries: [], connects: [] };
await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(3000);
const connect = page.locator("button.btn-primary", { hasText: /Connect wallet/i }).first();
await connect.dispatchEvent("click", undefined, { timeout: 8000 }).catch(() => {});
await page.waitForTimeout(2500);
out.entries = (await page.locator("div[role='dialog'] button").allInnerTexts().catch(() => [])).map((t) =>
  t.replace(/\s+/g, " ").trim(),
);
await page.screenshot({ path: path.join(outDir, "picker.png"), fullPage: true });
// Click each injected entry, in order, recording the resulting state.
const injected = page.locator("button", { hasText: /Detected in this browser/i });
const n = await injected.count();
out.injectedCount = n;
for (let i = 0; i < n; i++) {
  const btn = injected.nth(i);
  const label = (await btn.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  await btn.dispatchEvent("click", undefined, { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const text = await page.evaluate(() => document.body.innerText);
  out.connects.push({ index: i, label, connected: /0x7A91|0x2222/i.test(text), shown: (text.match(/0x[0-9a-fA-F]{4}/g) || []).slice(0, 3) });
  // reopen the picker for the next entry (disconnect first if connected)
  if (i < n - 1) {
    const menu = page.locator("button[aria-label='Wallet menu']");
    if (await menu.isVisible().catch(() => false)) {
      await menu.dispatchEvent("click", undefined).catch(() => {});
      await page.waitForTimeout(500);
      const disc = page.locator("button", { hasText: /^Disconnect$/ }).first();
      if (await disc.isVisible().catch(() => false)) await disc.dispatchEvent("click", undefined).catch(() => {});
      await page.waitForTimeout(800);
    }
    await page.locator("button.btn-primary", { hasText: /Connect wallet/i }).first().dispatchEvent("click", undefined).catch(() => {});
    await page.waitForTimeout(1500);
  }
}
fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await browser.close();
process.exit(0);
