// Mission 23 — drive the REAL checkout page with the REAL Trust Wallet provider
// bundle (trust-web3-provider), whose generic reads proxy to its own node. This
// is how the Android in-app browser behaves. Proves whether the customer's
// "Pay" hits Trust's RPC and whether the page stays usable.
import fs from "node:fs";
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:3200";
const token = process.argv[3];
const ADDR = "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A";
const bundle = fs.readFileSync("/tmp/trust_min.js", "utf8");

const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox","--disable-dev-shm-usage"] });
const ctx = await browser.newContext({ viewport: { width: 430, height: 940 } });
await ctx.addInitScript(({ bundle, addr }) => {
  window.__probe = { methods: [], fetches: [], errors: [] };
  const origFetch = window.fetch.bind(window);
  window.fetch = async (u, i) => {
    const url = typeof u === "string" ? u : (u?.url ?? String(u));
    if (/twnodes|monad\.rpc/.test(url)) window.__probe.fetches.push(url);
    return origFetch(u, i);
  };
  (0, eval)(bundle);
  const p = window.trustwallet.ethereum({ chainId: 143, rpcUrl: "http://monad.twnodes.com/" });
  p.setAdapter({ getStrategy: () => undefined, request: async (e) => {
    const n = e && (e.name || e.method);
    if (n === "requestAccounts") return [addr];
    if (n === "signTransaction") return "0x" + "ab".repeat(32);
    if (n === "wallet_requestPermissions") return JSON.stringify([{ caveats: [{ value: [addr] }] }]);
    if (n === "switchEthereumChain" || n === "addEthereumChain") return null;
    throw Object.assign(new Error("native"), { code: 4200 });
  } });
  const orig = p.request.bind(p);
  p.request = async (args) => { window.__probe.methods.push(args?.method); try { return await orig(args); } catch (e) { window.__probe.errors.push(`${args?.method}: ${String(e?.message ?? e).slice(0,120)}`); throw e; } };
  window.ethereum = p;
  const info = { uuid: "trust", name: "Trust Wallet", icon: "", rdns: "com.trustwallet.app" };
  const ann = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info, provider: p } }));
  window.addEventListener("eip6963:requestProvider", ann); ann();
}, { bundle, addr: ADDR });

const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", e => pageErrors.push(String(e).slice(0,240)));
await page.goto(`${base}/checkout/${token}`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(3500);
await page.getByRole("button", { name: /Connect wallet/i }).first().click({ timeout: 5000 }).catch(() => {});
await page.waitForTimeout(1200);
await page.getByRole("button", { name: /Trust Wallet|MetaMask|Browser wallet|Detected/i }).first().click({ timeout: 5000 }).catch(() => {});
await page.waitForTimeout(2500);
const connected = /Ready to pay|YOUR WALLET|Pay \$/i.test(await page.evaluate(()=>document.body.innerText));
await page.getByRole("button", { name: /^Pay \$|^Pay / }).first().click({ timeout: 6000 }).catch(() => {});
let minLen = 1e9;
for (let i=0;i<8;i++){ await page.waitForTimeout(1500); const l=(await page.evaluate(()=>document.body.innerText.trim().length)); minLen=Math.min(minLen,l); }
const probe = await page.evaluate(() => window.__probe);
console.log(JSON.stringify({ connected, minLen, pageErrors, probe, final: (await page.evaluate(()=>document.body.innerText.replace(/\s+/g," ").slice(0,240))) }, null, 2));
await browser.close();
