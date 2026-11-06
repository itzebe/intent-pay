// Mission 23 — exercise the REAL checkout page under failure modes that a
// customer actually hits: wallet rejects the send, and a malformed/absent
// prepare. Record whether the page ever goes blank (a blank body) or throws.
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:3200";
const token = process.argv[3];
const ADDR = "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A";

async function run(label, initScript) {
  const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox","--disable-dev-shm-usage"] });
  const ctx = await browser.newContext({ viewport: { width: 430, height: 940 } });
  await ctx.addInitScript(initScript, { addr: ADDR });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await page.goto(`${base}/checkout/${token}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  await page.getByRole("button", { name: /Connect wallet/i }).first().click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: /MetaMask|Trust Wallet|Browser wallet|Detected/i }).first().click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const pay = page.getByRole("button", { name: /^Pay \$|^Pay / }).first();
  await pay.click({ timeout: 6000 }).catch(() => {});
  let blank = false, minLen = 1e9;
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(1200);
    const len = (await page.evaluate(() => document.body.innerText.trim().length));
    minLen = Math.min(minLen, len);
    if (len < 30) blank = true;
  }
  const body = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 300));
  console.log(JSON.stringify({ label, blank, minLen, errors, body }));
  await browser.close();
}

const rejectProvider = ({ addr }) => {
  window.ethereum = { isMetaMask: true, request: async ({ method }) => {
    if (method === "eth_requestAccounts" || method === "eth_accounts") return [addr];
    if (method === "eth_chainId") return "0x8f";
    if (method === "eth_sendTransaction") { const e = new Error("User rejected the request."); e.code = 4001; throw e; }
    return null; }, on: () => {}, removeListener: () => {} };
};
const okProvider = ({ addr }) => {
  window.ethereum = { isMetaMask: true, request: async ({ method }) => {
    if (method === "eth_requestAccounts" || method === "eth_accounts") return [addr];
    if (method === "eth_chainId") return "0x8f";
    if (method === "eth_sendTransaction") return "0x" + "ab".repeat(32);
    return null; }, on: () => {}, removeListener: () => {} };
};

await run("wallet-reject", rejectProvider);
await run("unmined-hash", okProvider);
