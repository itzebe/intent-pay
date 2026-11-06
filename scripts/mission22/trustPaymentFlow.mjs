// Mission 22 — Trust Wallet payment flow against a running dev/prod server.
//
// Drives the real composer with a Trust-faithful injected provider whose own
// RPC (monad.twnodes.com) is unreachable: `eth_chainId` throws `Failed to
// fetch`, while `eth_sendTransaction` is answered natively. Records the wallet
// methods requested, whether the app ever asked the wallet for a chain read,
// and the final on-screen state.
//
// Usage: node scripts/mission22/trustPaymentFlow.mjs [baseUrl]
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:3000";
const ADDR = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4";
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const HASH = "0x" + "ab".repeat(32);

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const ctx = await browser.newContext({ viewport: { width: 430, height: 960 } });

await ctx.addInitScript(
  ({ addr, hash }) => {
    window.__probe = { methods: [], proxied: [], approvals: 0, rpcFailures: [] };
    const TRUST_RPC = "http://monad.twnodes.com/";
    const provider = {
      isTrust: true,
      isMetaMask: true,
      request: async ({ method }) => {
        window.__probe.methods.push(method);
        if (method === "eth_accounts" || method === "eth_requestAccounts") return [addr];
        if (method === "eth_sendTransaction") {
          window.__probe.approvals++;
          return hash;
        }
        if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
        // Anything else is proxied to Trust's own node — which the page cannot
        // reach (CSP + unreachable host), exactly as reported on device.
        window.__probe.proxied.push(method);
        try {
          await fetch(TRUST_RPC, { method: "POST" });
          return "0x0";
        } catch (e) {
          window.__probe.rpcFailures.push(`${method}: ${String(e).slice(0, 40)}`);
          throw new TypeError("Failed to fetch");
        }
      },
      on: () => {},
      removeListener: () => {},
    };
    window.ethereum = provider;
    const info = { uuid: "trust", name: "Trust Wallet", icon: "", rdns: "com.trustwallet.app" };
    const announce = () =>
      window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info, provider } }));
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
  },
  { addr: ADDR, hash: HASH },
);

const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));

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

// The gateway to the reported failure: the wallet's own chain read fails, yet
// the app must still be connected and usable (not stuck on a raw RPC error).
const connected = await page
  .getByText(/0x7A91|0x7a91/)
  .first()
  .isVisible()
  .catch(() => false);
const rawRpcErrorVisible = await page
  .getByText(/twnodes|Failed to fetch/i)
  .first()
  .isVisible()
  .catch(() => false);

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
  ...window.__probe,
  bodyText: document.body.innerText.replace(/\s+/g, " ").slice(0, 700),
}));

console.log(
  JSON.stringify(
    {
      base,
      steps,
      connected,
      rawRpcErrorVisible,
      pageErrors,
      providerMethods: out.methods,
      proxiedToWalletRpc: out.proxied,
      rpcFailures: out.rpcFailures,
      approvals: out.approvals,
      bodyText: out.bodyText,
    },
    null,
    2,
  ),
);
await browser.close();
