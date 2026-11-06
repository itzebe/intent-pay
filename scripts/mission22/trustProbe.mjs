// Mission 22 — Trust Wallet provider fidelity probe.
//
// Injects a provider that behaves like Trust Wallet's real in-app-browser
// provider (github.com/trustwallet/trust-web3-provider):
//   * answers eth_accounts / eth_requestAccounts / eth_chainId / net_version
//     LOCALLY (no network),
//   * handles wallet_addEthereumChain / wallet_switchEthereumChain,
//   * answers eth_sendTransaction through the native bridge,
//   * proxies EVERY OTHER method through `fetch(rpcUrl)` — Trust's own RPC.
//
// The proxy fetch targets Trust's NaaS host over plaintext `http://`, which a
// page CSP blocks (`connect-src`), so it throws `TypeError: Failed to fetch` —
// exactly the reported "Failed to connect to http://monad.twnodes.com/".
//
// The probe records every method the app requests from the provider and flags
// any that would reach Trust's RPC, so we can see precisely which app action
// (if any) triggers the failure.
import { chromium } from "playwright";

const base = process.argv[2] ?? "https://intent-pay-roan.vercel.app";
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const ctx = await browser.newContext({ viewport: { width: 430, height: 940 } });

await ctx.addInitScript(() => {
  window.__probe = { methods: [], proxied: [], errors: [] };
  const ADDR = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4";
  const HASH = "0x" + "ab".repeat(32);
  // Trust's own Monad RPC (NaaS), the host in the reported error.
  const TRUST_RPC = "http://monad.twnodes.com/";

  const provider = {
    isTrust: true,
    isTrustWallet: true,
    isMetaMask: true, // Trust sets this for dapp compatibility
    providers: undefined,
    request: async ({ method }) => {
      window.__probe.methods.push(method);
      if (method === "eth_accounts" || method === "eth_requestAccounts" || method === "eth_coinbase") {
        return [ADDR];
      }
      if (method === "eth_chainId") return "0x8f";
      if (method === "net_version") return "143";
      if (method === "wallet_addEthereumChain" || method === "wallet_switchEthereumChain") return null;
      if (method === "wallet_watchAsset") return true;
      if (method === "eth_sendTransaction") return HASH;
      // Everything else: Trust's provider does `fetch(rpcUrl)` to its own node.
      // A page CSP blocks the plaintext origin → a bare TypeError.
      window.__probe.proxied.push(method);
      try {
        const r = await fetch(TRUST_RPC, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
        });
        return await r.json();
      } catch (e) {
        window.__probe.errors.push(`${method}: ${String(e).slice(0, 80)}`);
        throw new TypeError("Failed to fetch");
      }
    },
    on: () => {},
    removeListener: () => {},
  };

  window.ethereum = provider;
  const info = { uuid: "trust-uuid", name: "Trust Wallet", icon: "", rdns: "com.trustwallet.app" };
  const announce = () =>
    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info, provider } }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
});

const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));
await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(1800);

await page
  .locator("button", { hasText: /Connect wallet|Connect Wallet/i })
  .first()
  .dispatchEvent("click")
  .catch(() => {});
await page.waitForTimeout(1200);
// Trust sets isMetaMask, so the legacy slot may label it "MetaMask"; take the
// first non-WalletConnect wallet row in the picker.
const rows = page.locator("button", { hasText: /MetaMask|Trust Wallet|Rabby|Coinbase|Browser wallet/i });
const rowCount = await rows.count();
const sawWalletRow = rowCount > 0;
await rows.first().dispatchEvent("click").catch(() => {});
await page.waitForTimeout(2500);

const state = await page.evaluate(() => ({
  ...window.__probe,
  bodyText: document.body.innerText.slice(0, 500),
}));

console.log(JSON.stringify({ sawWalletRow, rowCount, pageErrors, ...state }, null, 2));
await browser.close();
