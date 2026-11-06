/**
 * Drives the real deployed composer with a stub EIP-6963 wallet.
 *
 * Every network call (balances, quote, optimize) hits the live app, so this
 * exercises the real Continue-Payment path. The wallet is a stub only because a
 * harness cannot hold a key — no signature, no approval, no transaction.
 */
import { chromium } from "playwright";
const base = process.argv[2] ?? "https://intent-pay-roan.vercel.app";
const ACCOUNT = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4";
const RECIPIENT = "0x1234567890AbcdEF1234567890aBcdef12345678";

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext({ viewport: { width: 430, height: 940 } });
const logs = [];
await ctx.addInitScript(({ account }) => {
  const provider = {
    isMetaMask: true,
    request: async ({ method }) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [account];
      if (method === "eth_chainId") return "0x8f";
      if (method === "wallet_switchEthereumChain") return null;
      return null;
    },
    on: () => {}, removeListener: () => {},
  };
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
    detail: { info: { uuid: "m1", name: "MetaMask", icon: "", rdns: "io.metamask" }, provider } }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
  window.ethereum = provider;
}, { account: ACCOUNT });

const page = await ctx.newPage();
page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`.slice(0, 240)));
page.on("pageerror", (e) => logs.push(`pageerror: ${String(e).slice(0, 240)}`));
await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(2500);

const out = { base, connected: false, reviewReached: false, blankAfterContinue: false, bodyLenBefore: 0, bodyLenAfter: 0, errorText: null, pageErrors: [] };

// Connect the stub wallet.
try {
  await page.locator("button.btn-primary").first().dispatchEvent("click", undefined, { timeout: 8000 });
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: /MetaMask/i }).first().dispatchEvent("click", undefined, { timeout: 6000 });
  await page.waitForTimeout(2500);
  out.connected = /0x7A91/i.test(await page.evaluate(() => document.body.innerText));
} catch (e) { out.connectError = String(e).slice(0, 120); }

// Fill recipient + amount on the composer.
try {
  const inputs = page.locator("input");
  await inputs.nth(0).fill(RECIPIENT, { timeout: 6000 });
  await page.waitForTimeout(500);
  const amt = page.locator('input[inputmode="decimal"], input[type="text"]').last();
  await amt.fill("5", { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(3000);
} catch (e) { out.fillError = String(e).slice(0, 120); }

out.bodyLenBefore = (await page.evaluate(() => document.body.innerText)).length;

// Locate the composer's own CTA (the review button), not any other primary
// button on the page. Its label is the readiness CTA.
out.primaryButtons = await page.locator("button.btn-primary").allInnerTexts();
const review = page.locator("button.btn-primary", { hasText: /Review payment|Continue|Fix amount|No executable|Choose payment|Enter a valid/i }).first();
try {
  out.ctaLabel = (await review.innerText({ timeout: 4000 })).trim().replace(/\s+/g, " ");
  out.ctaDisabled = await review.isDisabled().catch(() => null);
  await review.dispatchEvent("click", undefined, { timeout: 8000 });
  await page.waitForTimeout(5000);
} catch (e) { out.continueError = String(e).slice(0, 140); }

const after = await page.evaluate(() => document.body.innerText);
out.bodyLenAfter = after.length;
out.blankAfterContinue = after.trim().length < 40;
out.reviewReached = /Minimum received|You pay|Network fee|Confirm and send|Review payment/i.test(after);
out.reviewMarkers = (after.match(/Minimum received|You pay|Network fee|Confirm and send|Review payment/gi) || []);
out.errorText = (after.match(/[^\n]*(error|failed|couldn't|unavailable|no route)[^\n]*/i) || [null])[0];
out.pageErrors = logs.filter((l) => l.startsWith("pageerror")).slice(0, 5);
console.log(JSON.stringify(out, null, 2));
console.log("--- console (filtered) ---");
console.log(logs.filter((l) => /error|CSP|refused|Failed/i.test(l)).slice(0, 8).join("\n"));
await browser.close();
