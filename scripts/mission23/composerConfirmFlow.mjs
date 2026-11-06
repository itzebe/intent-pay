// Mission 23 — drive the REAL composer all the way to Confirm with a funded
// wallet and a genuinely routable intent, to reproduce the reported
// "Confirm → loading → back to the previous screen" loop and any blank.
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:3100";
const RECV = process.argv[3] ?? "USDT";
const ADDR = "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A";
const RECIPIENT = "0x1111111111111111111111111111111111111111";

const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox","--disable-dev-shm-usage"] });
const ctx = await browser.newContext({ viewport: { width: 430, height: 980 } });
await ctx.addInitScript(({ addr }) => {
  window.__probe = { methods: [] };
  window.ethereum = { isMetaMask: true, request: async ({ method }) => { window.__probe.methods.push(method);
    if (method === "eth_requestAccounts" || method === "eth_accounts") return [addr];
    if (method === "eth_chainId") return "0x8f";
    if (method === "eth_sendTransaction") return "0x" + "ab".repeat(32);
    if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
    return null; }, on: () => {}, removeListener: () => {} };
}, { addr: ADDR });

const page = await ctx.newPage();
const errs = []; page.on("pageerror", e => errs.push(String(e).slice(0,240)));
page.on("console", m => { if (m.type()==="error") errs.push("C:"+m.text().slice(0,200)); });
const t = async () => page.evaluate(()=>document.body.innerText.replace(/\s+/g," "));

await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(2500);
await page.getByRole("button", { name: /Connect wallet/i }).first().click();
await page.waitForTimeout(1500);
await page.getByRole("button", { name: /Detected in this browser|MetaMask|Browser wallet/i }).first().click();
await page.waitForTimeout(2500);
await page.locator("#recipient").fill(RECIPIENT);
await page.waitForTimeout(600);
// Choose the receive token by its dialog row (accessible name includes the name).
await page.getByRole("button", { name: /Choose receive token/i }).first().click({ timeout: 5000 }).catch(()=>{});
await page.waitForTimeout(1000);
const row = page.getByRole("dialog").getByRole("button", { name: new RegExp(RECV) }).first();
await row.click({ timeout: 5000 }).catch((e)=>console.log("row click err", e.message.split("\n")[0]));
await page.waitForTimeout(1000);
await page.locator('input[aria-label="Recipient receives"], input[inputmode="decimal"]').first().fill("0.5");
await page.waitForTimeout(9000);
const cta = await page.evaluate(() => { const b=[...document.querySelectorAll("button")].find(x=>/Review payment|No executable|Choose payment|Pricing|No route|Not enough|Enter a valid|Fix amount/i.test(x.innerText||"")); return b? (b.disabled?"[D] ":"")+b.innerText.replace(/\s+/g," ").trim() : null; });
console.log("CTA:", JSON.stringify(cta));

const rv = page.getByRole("button", { name: /Review payment/i }).first();
if (await rv.count() && !(await rv.isDisabled())) {
  await rv.click(); await page.waitForTimeout(2500);
  console.log("REVIEW reached:", /Confirm/i.test(await t()));
  const cf = page.getByRole("button", { name: /^Confirm|Confirm & send|Confirm and send/i }).first();
  console.log("confirm button count", await cf.count(), "disabled", await cf.isDisabled().catch(()=>null));
  if (await cf.count()) {
    await cf.click().catch(()=>{});
    let minLen=1e9, samples=[];
    for (let i=0;i<10;i++){ await page.waitForTimeout(1500); const l=(await page.evaluate(()=>document.body.innerText.trim().length)); minLen=Math.min(minLen,l); samples.push(l); }
    console.log("after-confirm minLen", minLen, "lens", JSON.stringify(samples));
    console.log("after-confirm text:", (await t()).slice(0,240));
  }
}
console.log("probe", JSON.stringify(await page.evaluate(()=>window.__probe.methods)));
console.log("errors", JSON.stringify(errs.slice(0,6)));
await browser.close();
