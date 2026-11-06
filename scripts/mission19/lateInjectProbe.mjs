// Mission 19 — late-injection timing probe. A provider injects at T+9s while the
// wallet picker is already open. Records when (if ever) the app discovers it.
import fs from "node:fs";
import { chromium } from "playwright";

const base = process.argv[2] ?? "https://intent-pay-roan.vercel.app";
const injectMs = Number(process.argv[3] ?? 9000);
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const ctx = await browser.newContext({ viewport: { width: 430, height: 940 } });
await ctx.addInitScript(
  ({ injectMs }) => {
    window.__injectedAt = null;
    setTimeout(() => {
      const p = {
        isMetaMask: true,
        request: async ({ method }) =>
          method === "eth_requestAccounts" || method === "eth_accounts"
            ? ["0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4"]
            : method === "eth_chainId"
              ? "0x8f"
              : null,
        on: () => {},
        removeListener: () => {},
      };
      window.ethereum = p;
      window.__injectedAt = Date.now();
    }, injectMs);
  },
  { injectMs },
);
const page = await ctx.newPage();
const out = { base, injectMs, timeline: [] };
await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(1200);
// Open the picker BEFORE the provider exists.
const connect = page.locator("button.btn-primary", { hasText: /Connect wallet/i }).first();
await connect.dispatchEvent("click", undefined, { timeout: 8000 }).catch(() => {});
const t0 = Date.now();
for (let i = 0; i < 30; i++) {
  const snap = await page.evaluate(() => ({
    injected: typeof window.ethereum !== "undefined",
    injectedAt: window.__injectedAt,
    hasTrustEntry: /Detected in this browser/i.test(document.body.innerText),
    noWallet: /No browser wallet detected/i.test(document.body.innerText),
  }));
  out.timeline.push({ t: Date.now() - t0, ...snap });
  if (snap.hasTrustEntry) break;
  await page.waitForTimeout(1000);
}
out.discovered = out.timeline.some((s) => s.hasTrustEntry);
out.discoveredAtMs = (out.timeline.find((s) => s.hasTrustEntry) || {}).t ?? null;
fs.writeFileSync("/tmp/m19-late.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify({ discovered: out.discovered, discoveredAtMs: out.discoveredAtMs, injectMs, last: out.timeline.slice(-4) }, null, 2));
await browser.close();
process.exit(0);
