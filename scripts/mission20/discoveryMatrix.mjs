// Mission 20 Gate 2 — discovery matrix against production using the REAL,
// documented Trust Wallet shapes (github.com/trustwallet/trust-web3-provider).
// For each shape we report: is any injected wallet listed, and under what name?
// No signature, no transaction, no approval.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const base = process.argv[2] ?? "https://intent-pay-roan.vercel.app";
const outDir = process.argv[3] ?? "/tmp/m20matrix";
fs.mkdirSync(outDir, { recursive: true });
const ACCOUNT = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4";

// Each shape installs its globals at document start (Trust injects at document
// start too). `late` shapes install ~9s after load (a slow mobile injection).
const SHAPES = {
  // iOS in-app browser: trustwallet.ethereum is a FACTORY; window.ethereum is the
  // provider; a Proxy stands in for window.trustwallet; EIP-6963 IS announced.
  "ios-proxy-factory+ethereum+eip6963": { build: "ios", late: false },
  // Android reference app: trustwallet.ethereum is a PROVIDER; window.ethereum is
  // the same provider; NO EIP-6963.
  "android-provider+ethereum": { build: "android", late: false },
  // Android new injector factory: trustwallet.ethereum is a FACTORY; window.ethereum
  // is the provider.
  "android-factory+ethereum": { build: "androidFactory", late: false },
  // Legacy-only: only window.ethereum (no trustwallet namespace at all).
  "ethereum-only": { build: "ethereumOnly", late: false },
  // Late iOS injection at ~9s.
  "ios-late-9s": { build: "ios", late: true },
  // Late legacy-only at ~9s.
  "ethereum-only-late-9s": { build: "ethereumOnly", late: true },
};

const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox","--disable-dev-shm-usage"] });
const results = {};
for (const [name, spec] of Object.entries(SHAPES)) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  await ctx.addInitScript(({ account, build, late }) => {
    const mkProvider = () => ({
      isTrust: true, isTrustWallet: true,
      request: async ({ method }) => (method === "eth_requestAccounts" || method === "eth_accounts") ? [account] : "0x8f",
      on: () => {}, removeListener: () => {},
    });
    const install = () => {
      const provider = mkProvider();
      if (build === "ios") {
        // Proxy + factory + EIP-6963
        const target = { ethereum: function factory() { return provider; }, Provider: function(){} };
        window.ethereum = provider;
        window.trustwallet = new Proxy(target, { get(t, p) { return Reflect.get(t, p); } });
        window.addEventListener("eip6963:requestProvider", () => {
          window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info: { uuid: "tw-uuid", name: "Trust Wallet", icon: "", rdns: "com.trustwallet.app" }, provider }) }));
        });
        window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info: { uuid: "tw-uuid", name: "Trust Wallet", icon: "", rdns: "com.trustwallet.app" }, provider }) }));
      } else if (build === "android") {
        window.trustwallet = { ethereum: provider, Provider: function(){} };
        window.ethereum = provider;
      } else if (build === "androidFactory") {
        window.trustwallet = { ethereum: function factory() { return provider; }, Provider: function(){} };
        window.ethereum = provider;
      } else { // ethereumOnly
        window.ethereum = provider;
      }
    };
    if (late) setTimeout(install, 9000); else install();
  }, { account: ACCOUNT, build: spec.build, late: spec.late });

  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));
  try {
    await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(spec.late ? 12000 : 3500);
    // Open the picker (the app re-scans on open).
    await page.locator("button.btn-primary").first().dispatchEvent("click", undefined, { timeout: 8000 }).catch(()=>{});
    await page.waitForTimeout(1500);
    const text = await page.evaluate(() => document.body.innerText);
    results[name] = {
      noWalletNote: /No browser wallet detected/i.test(text),
      listedTrust: /Trust Wallet/i.test(text),
      listedMetaMask: /MetaMask/i.test(text),
      listedBrowserWallet: /Browser wallet/i.test(text),
      pageErrors: errs.slice(0, 2),
    };
  } catch (e) { results[name] = { fatal: String(e).slice(0, 200) }; }
  await ctx.close();
}
await browser.close();
fs.writeFileSync(path.join(outDir, "matrix.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
