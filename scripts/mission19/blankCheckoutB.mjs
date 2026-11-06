// Mission 19 — Failure B: drive the real composer to Review and press Confirm
// with a wallet that is on the right chain but whose transactions we DO NOT
// actually broadcast (we never sign). We only want to see whether the UI reaches
// Review and whether the executing screen or the checkout blanks.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const base = process.argv[2] ?? "https://intent-pay-roan.vercel.app";
const outDir = process.argv[3] ?? "/tmp/m19-blank";
fs.mkdirSync(outDir, { recursive: true });
const ACCOUNT = process.argv[4] ?? "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4";
const RECIPIENT = "0x1234567890AbcdEF1234567890aBcdef12345678";

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const ctx = await browser.newContext({ viewport: { width: 430, height: 940 } });
const logs = [];
await ctx.addInitScript(
  ({ account }) => {
    const listeners = {};
    const provider = {
      isMetaMask: true,
      request: async ({ method }) => {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [account];
        if (method === "eth_chainId") return "0x8f";
        if (method === "eth_sendTransaction") {
          // We NEVER sign or broadcast. The wallet rejects the request (4001),
          // which is exactly what a user tapping "Reject" produces — no
          // signature, no token approval, no transaction.
          const e = new Error("User rejected the request.");
          e.code = 4001;
          throw e;
        }
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
page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`.slice(0, 300)));
page.on("pageerror", (e) => logs.push(`PAGEERROR: ${String(e.stack ?? e).slice(0, 400)}`));
const out = { base, steps: [] };
try {
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  // Connect
  await page.locator("button.btn-primary", { hasText: /Connect wallet/i }).first().dispatchEvent("click").catch(() => {});
  await page.waitForTimeout(1500);
  await page.locator("button", { hasText: /Detected in this browser/i }).first().dispatchEvent("click").catch(() => {});
  await page.waitForTimeout(2500);
  out.connected = /0x7A91|0x28f6/i.test(await page.evaluate(() => document.body.innerText));
  out.afterConnectText = (await page.evaluate(() => document.body.innerText)).slice(0, 500);

  // Fill recipient + amount
  const inputs = page.locator("input");
  await inputs.nth(0).fill(RECIPIENT, { timeout: 6000 }).catch((e) => out.steps.push("recip:" + e.message.split("\n")[0]));
  await page.waitForTimeout(400);
  const amt = page.locator('input[inputmode="decimal"]').last();
  await amt.fill("5", { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(4000);

  const cta = page.locator("button.btn-primary").filter({ hasText: /Review payment|No executable|Choose payment|Enter a valid|Fix amount|Refreshing|Couldn't get|Not enough|No route|Can't use/i }).first();
  out.ctaLabel = (await cta.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  out.ctaDisabled = await cta.isDisabled().catch(() => null);
  out.bodyBefore = (await page.evaluate(() => document.body.innerText)).length;
  await cta.dispatchEvent("click", undefined, { timeout: 8000 }).catch((e) => out.steps.push("cta:" + e.message.split("\n")[0]));
  await page.waitForTimeout(2500);
  const reviewText = await page.evaluate(() => document.body.innerText);
  out.reviewReached = /Confirm & Send|Confirm and send/i.test(reviewText);
  out.reviewBodyLen = reviewText.length;
  await page.screenshot({ path: path.join(outDir, "review.png"), fullPage: true });

  if (out.reviewReached) {
    const confirm = page.locator("button", { hasText: /Confirm & Send|Confirm and send/i }).first();
    await confirm.dispatchEvent("click", undefined, { timeout: 8000 }).catch((e) => out.steps.push("confirm:" + e.message.split("\n")[0]));
    // Sample the screen every 1.5s for 15s to catch a blank.
    out.samples = [];
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(1500);
      const t = await page.evaluate(() => document.body.innerText);
      out.samples.push({ t: (i + 1) * 1.5, len: t.trim().length, blank: t.trim().length < 40, exec: /Waiting for confirmation/i.test(t), unresolved: /Transaction status unknown/i.test(t), err: (t.match(/[^\n]*(error|couldn't|failed|unavailable)[^\n]*/i) || [null])[0] });
    }
    await page.screenshot({ path: path.join(outDir, "after-confirm.png"), fullPage: true });
  }
} catch (e) {
  out.fatal = String(e).slice(0, 400);
}
out.pageErrors = logs.filter((l) => l.startsWith("PAGEERROR")).slice(0, 8);
out.consoleErrors = logs.filter((l) => /error|Error|Refused|CSP/i.test(l)).slice(0, 12);
fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await browser.close();
process.exit(0);
