// Mission 23 — with the REAL Trust provider bundle, determine which methods
// viem's wallet-client surfaces actually call through the wallet, and which of
// those are proxied to monad.twnodes.com (failing) vs answered natively.
import fs from "node:fs";
import { chromium } from "playwright";

const bundlePath = process.env.TRUST_MIN ?? "/tmp/trust_min.js";
const bundle = fs.readFileSync(bundlePath, "utf8");
const V = "https://esm.sh/viem@2.57.3";

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const ctx = await browser.newContext();
const page = await ctx.newPage();
const net = [];
page.on("request", (r) => {
  if (/twnodes/.test(r.url())) net.push(`${r.method()} ${r.url()}`);
});

await page.setContent("<html><body>probe</body></html>");
await page.addScriptTag({ content: bundle });
await page.addScriptTag({ type: "module", content: `import * as viem from "${V}"; window.viem = viem; window.__ready = true;` });
await page.waitForFunction(() => window.__ready, { timeout: 30000 });

const out = await page.evaluate(async () => {
  const { createWalletClient, custom, defineChain } = window.viem;
  const provider = window.trustwallet.ethereum({ chainId: 143, rpcUrl: "http://monad.twnodes.com/" });
  const ADDR = "0x7a91c4b8e2d9f04ab3c6e81d5f72a0c9e4bd92f4";
  provider.setAdapter({
    getStrategy: () => undefined,
    request: async (e) => {
      const name = e && (e.name || e.method);
      if (name === "requestAccounts") return [ADDR];
      if (name === "signTransaction") return "0x" + "ab".repeat(32);
      if (name === "wallet_requestPermissions") return JSON.stringify([{ caveats: [{ value: [ADDR] }] }]);
      if (name === "switchEthereumChain" || name === "addEthereumChain") return null;
      throw Object.assign(new Error("native: unsupported " + name), { code: 4200 });
    },
  });
  const calls = [];
  const orig = provider.request.bind(provider);
  provider.request = async (a) => {
    try {
      const r = await orig(a);
      calls.push({ method: a.method, ok: true });
      return r;
    } catch (e) {
      calls.push({ method: a.method, ok: false, error: String(e && e.message).slice(0, 90), code: e && e.code });
      throw e;
    }
  };
  const monad = defineChain({
    id: 143,
    name: "Monad",
    nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: ["https://rpc.monad.xyz"] } },
  });
  const wallet = createWalletClient({ account: ADDR, chain: monad, transport: custom(provider) });
  const results = {};

  // 1. What the app does today: raw eth_sendTransaction via walletClient.request
  calls.length = 0;
  try {
    const h = await wallet.request({
      method: "eth_sendTransaction",
      params: [{ from: ADDR, to: ADDR, value: "0x1", chainId: "0x8f" }],
    });
    results.rawRequest = { hash: String(h).slice(0, 12), methods: [...calls] };
  } catch (e) {
    results.rawRequest = { error: String(e && e.message).slice(0, 90), methods: [...calls] };
  }

  // 2. viem sendTransaction (high-level)
  calls.length = 0;
  try {
    const h = await wallet.sendTransaction({ account: ADDR, chain: monad, to: ADDR, value: 1n });
    results.sendTransaction = { hash: String(h).slice(0, 12), methods: [...calls] };
  } catch (e) {
    results.sendTransaction = { error: String(e && e.message).slice(0, 120), methods: [...calls] };
  }

  // 3. viem writeContract (high-level, what PR#44 removed)
  calls.length = 0;
  try {
    const ABI = [{ name: "transfer", type: "function", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }];
    const h = await wallet.writeContract({ account: ADDR, chain: monad, address: ADDR, abi: ABI, functionName: "transfer", args: [ADDR, 1n] });
    results.writeContract = { hash: String(h).slice(0, 12), methods: [...calls] };
  } catch (e) {
    results.writeContract = { error: String(e && e.message).slice(0, 120), methods: [...calls] };
  }

  return results;
});

console.log(JSON.stringify({ twnodesRequests: net, ...out }, null, 2));
await browser.close();
