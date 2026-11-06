// Mission 23 — drive the REAL Trust provider bundle through the app's full
// payment flow and record, per app operation, which wallet method is called and
// whether it answered natively or was proxied to monad.twnodes.com (failing).
//
// The real Trust bundle answers eth_chainId/eth_accounts/net_version LOCALLY and
// proxies every generic read (eth_call, eth_estimateGas,
// eth_getTransactionCount, eth_getBalance, eth_blockNumber) to its own node via
// page-context fetch. We register a native adapter that answers the
// signing/account methods the way Trust's Android bridge does, so the ONLY
// failures are the proxied reads — exactly as on a device with twnodes blocked.
import fs from "node:fs";
import { chromium } from "playwright";

const base = process.argv[2] ?? "https://intent-pay-roan.vercel.app";
const bundlePath = process.env.TRUST_MIN ?? "/tmp/trust_min.js";
const bundle = fs.readFileSync(bundlePath, "utf8");
const ADDR = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4";
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const HASH = "0x" + "ab".repeat(32);

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const ctx = await browser.newContext({ viewport: { width: 430, height: 980 } });
const net = [];
ctx.on("request", (r) => {
  const u = r.url();
  if (/twnodes/.test(u)) net.push(`${r.method()} ${u}`);
});

// Inject the real bundle, then wrap the provider's request to record every call
// the app makes and whether it reached the network.
await ctx.addInitScript(
  ({ bundle, addr, hash, recipient }) => {
    window.__probe = { calls: [], approvals: 0 };
    // Load the real Trust bundle in the page world (it self-installs
    // `window.trustwallet`). `eval` avoids depending on document.head existing.
    (0, eval)(bundle);
    const T = window.trustwallet;
    const provider = T.ethereum({ chainId: 143, rpcUrl: "http://monad.twnodes.com/" });
    // Native bridge stub: account + signing methods answered on-device.
    provider.setAdapter({
      getStrategy: () => undefined,
      request: async (e) => {
        const name = e && (e.name || e.method);
        if (name === "requestAccounts") return [addr];
        if (name === "signTransaction") {
          window.__probe.approvals++;
          return hash;
        }
        if (name === "wallet_requestPermissions") return JSON.stringify([{ caveats: [{ value: [addr] }] }]);
        if (name === "switchEthereumChain" || name === "addEthereumChain") return null;
        throw Object.assign(new Error("native adapter: unsupported " + name), { code: 4200 });
      },
    });
    const orig = provider.request.bind(provider);
    provider.request = async (args) => {
      const started = performance.now();
      try {
        const r = await orig(args);
        window.__probe.calls.push({ method: args.method, ok: true, ms: Math.round(performance.now() - started) });
        return r;
      } catch (err) {
        window.__probe.calls.push({
          method: args.method,
          ok: false,
          ms: Math.round(performance.now() - started),
          error: String(err && err.message).slice(0, 120),
          code: err && err.code,
        });
        throw err;
      }
    };
    window.ethereum = provider;
    const info = { uuid: "trust", name: "Trust Wallet", icon: "", rdns: "com.trustwallet.app" };
    const announce = () =>
      window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info, provider } }));
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
  },
  { bundle, addr: ADDR, hash: HASH, recipient: RECIPIENT },
);

const page = await ctx.newPage();
const pageErrors = [];
const consoleErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 220)));
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text().slice(0, 220));
});

async function clickText(re, wait = 1200) {
  const loc = page.getByRole("button", { name: re }).first();
  if ((await loc.count()) === 0) return false;
  await loc.click({ timeout: 4000 }).catch(async () => {
    await loc.dispatchEvent("click").catch(() => {});
  });
  await page.waitForTimeout(wait);
  return true;
}

const steps = {};
await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(2500);
steps.connect = await clickText(/Connect wallet/i, 1500);
steps.pick = await clickText(/Trust Wallet|MetaMask|Browser wallet/i, 2500);
const connected = await page.getByText(/0x7A91|0x7a91/).first().isVisible().catch(() => false);

const recipient = page.locator("#recipient");
if (await recipient.count()) {
  await recipient.fill(RECIPIENT);
  await page.waitForTimeout(400);
}
const amount = page.locator('input[aria-label="Recipient receives"], input[inputmode="decimal"]').first();
if (await amount.count()) {
  await amount.fill("0.01");
  await page.waitForTimeout(2500);
}
steps.review = await clickText(/Review payment/i, 3000);
steps.confirm = await clickText(/^Confirm|Confirm & send|Confirm and send|Confirm payment/i, 6000);

const out = await page.evaluate(() => ({
  calls: window.__probe.calls,
  approvals: window.__probe.approvals,
  bodyText: document.body.innerText.replace(/\s+/g, " ").slice(0, 800),
}));

const rawVisible = await page.getByText(/twnodes|Failed to fetch/i).first().isVisible().catch(() => false);
console.log(
  JSON.stringify(
    {
      base,
      steps,
      connected,
      rawRpcErrorVisible: rawVisible,
      pageErrors,
      consoleErrors: consoleErrors.slice(0, 6),
      providerCalls: out.calls,
      approvals: out.approvals,
      twnodesRequests: net,
      bodyText: out.bodyText,
    },
    null,
    2,
  ),
);
await browser.close();
