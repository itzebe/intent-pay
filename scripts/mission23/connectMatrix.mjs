// Mission 23 — connection matrix against a running app. Each scenario injects a
// different provider shape and records: is the wallet discovered, is it labelled
// correctly, is there a duplicate, does one Connect Wallet action connect it,
// and what is shown on screen. No signature, no tx.
import { chromium } from "playwright";

const base = process.argv[2] ?? "https://intent-pay-roan.vercel.app";
const ADDR = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4";

const scenarios = {
  // Legacy-only MetaMask-shaped provider, no EIP-6963.
  legacyMetaMask: `(() => {
    const p = { isMetaMask: true, request: async ({method}) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return ["${ADDR}"];
      if (method === "eth_chainId") return "0x8f";
      return null; }, on: () => {}, removeListener: () => {} };
    window.ethereum = p;
  })()`,
  // Legacy-only Trust provider (isMetaMask AND isTrust, as the real bundle sets).
  legacyTrust: `(() => {
    const p = { isTrust: true, isTrustWallet: true, isMetaMask: true, request: async ({method}) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return ["${ADDR}"];
      if (method === "eth_chainId") return "0x8f";
      return null; }, on: () => {}, removeListener: () => {} };
    window.ethereum = p;
  })()`,
  // EIP-6963 MetaMask that also occupies the legacy slot (the duplicate case).
  eip6963AndLegacy: `(() => {
    const p = { isMetaMask: true, request: async ({method}) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return ["${ADDR}"];
      if (method === "eth_chainId") return "0x8f";
      return null; }, on: () => {}, removeListener: () => {} };
    window.ethereum = p;
    const info = { uuid: "mm", name: "MetaMask", icon: "", rdns: "io.metamask" };
    window.addEventListener("eip6963:requestProvider", () =>
      window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info, provider: p } })));
  })()`,
  // Two legacy providers in window.ethereum.providers.
  twoLegacy: `(() => {
    const mk = (isMetaMask, isRabby) => ({ isMetaMask, isRabby, request: async ({method}) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return ["${ADDR}"];
      if (method === "eth_chainId") return "0x8f";
      return null; }, on: () => {}, removeListener: () => {} });
    const a = mk(true, false), b = mk(false, true);
    const eth = { providers: [a, b], request: a.request, on: () => {}, removeListener: () => {} };
    window.ethereum = eth;
  })()`,
  // Late injection: nothing at load, provider appears after 3.5s (no event).
  lateInjection: `(() => {
    setTimeout(() => {
      const p = { isMetaMask: true, request: async ({method}) => {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return ["${ADDR}"];
        if (method === "eth_chainId") return "0x8f";
        return null; }, on: () => {}, removeListener: () => {} };
      window.ethereum = p;
    }, 3500);
  })()`,
  // Rejection on connect.
  rejection: `(() => {
    const p = { isMetaMask: true, request: async ({method}) => {
      if (method === "eth_requestAccounts") { const e = new Error("User rejected the request."); e.code = 4001; throw e; }
      if (method === "eth_accounts") return [];
      if (method === "eth_chainId") return "0x8f";
      return null; }, on: () => {}, removeListener: () => {} };
    window.ethereum = p;
  })()`,
  // Unreadable chain.
  unreadableChain: `(() => {
    const p = { isMetaMask: true, request: async ({method}) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return ["${ADDR}"];
      if (method === "eth_chainId") throw new TypeError("Failed to fetch");
      return null; }, on: () => {}, removeListener: () => {} };
    window.ethereum = p;
  })()`,
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const results = {};
for (const [name, script] of Object.entries(scenarios)) {
  const ctx = await browser.newContext({ viewport: { width: 430, height: 940 } });
  await ctx.addInitScript(script);
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 160)));
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(name === "lateInjection" ? 6000 : 2500);
  // One Connect Wallet action.
  const connect = page.getByRole("button", { name: /Connect wallet/i }).first();
  await connect.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1800);
  const picker = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
  const listed = (picker.match(/MetaMask|Trust Wallet|Rabby|Coinbase Wallet|Browser wallet/g) || []);
  const noWallet = /No browser wallet detected/i.test(picker);
  // Choose the first injected option, if any.
  const opt = page.getByRole("button", { name: /Detected in this browser|MetaMask|Trust Wallet|Rabby|Browser wallet/i }).first();
  if (await opt.count()) await opt.click({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const after = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
  results[name] = {
    listed: [...new Set(listed)],
    duplicateRows: listed.length !== new Set(listed).size,
    noWalletNote: noWallet,
    connectedAddress: /0x7A91|0x7a91/i.test(after),
    errorShown: /Couldn't connect|rejected the connection|didn't share an account/i.test(after),
    pageErrors: errs,
  };
  await ctx.close();
}
console.log(JSON.stringify(results, null, 2));
await browser.close();
