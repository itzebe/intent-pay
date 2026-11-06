// Mission 23 — load the REAL Trust Wallet provider bundle (trust_min.js from
// github.com/trustwallet/trust-web3-provider) in a browser page, construct the
// provider exactly as the Android in-app browser does, and record for every
// method: does it answer locally (native bridge), or does it hit the network?
//
// This is evidence about the *wallet*, not our app. No signature, no tx.
import fs from "node:fs";
import { chromium } from "playwright";

const bundlePath = process.env.TRUST_MIN ?? "/tmp/trust_min.js";
const bundle = fs.readFileSync(bundlePath, "utf8");

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const ctx = await browser.newContext();
const page = await ctx.newPage();
const net = [];
page.on("request", (r) => {
  const u = r.url();
  if (!u.startsWith("data:") && !u.startsWith("about:") && !u.startsWith("blob:")) {
    net.push(`${r.method()} ${u}`);
  }
});

await page.setContent("<html><body>probe</body></html>");
await page.addScriptTag({ content: bundle });

const out = await page.evaluate(async () => {
  const T = window.trustwallet;
  const rec = { hasFactory: typeof T?.ethereum, factoryType: typeof T?.ethereum };
  if (typeof T?.ethereum !== "function") return { ...rec, fatal: "no ethereum factory" };
  const provider = T.ethereum({ chainId: 143, rpcUrl: "http://monad.twnodes.com/" });
  rec.isTrust = provider.isTrust;
  rec.isTrustWallet = provider.isTrustWallet;
  rec.getChainId = typeof provider.getChainId === "function" ? provider.getChainId() : "n/a";
  const methods = [
    "eth_chainId",
    "eth_accounts",
    "net_version",
    "eth_blockNumber",
    "eth_getBalance",
    "eth_call",
    "eth_estimateGas",
    "eth_getTransactionCount",
    "wallet_switchEthereumChain",
    "eth_sendTransaction",
  ];
  rec.methods = [];
  for (const m of methods) {
    const entry = { method: m };
    try {
      const params =
        m === "eth_sendTransaction"
          ? [
              {
                from: "0x0000000000000000000000000000000000000001",
                to: "0x0000000000000000000000000000000000000002",
                value: "0x1",
                chainId: 143,
              },
            ]
          : m === "wallet_switchEthereumChain"
            ? [{ chainId: "0x8f" }]
            : [];
      const r = await provider.request({ method: m, params });
      entry.result =
        typeof r === "object" && r !== null ? JSON.stringify(r).slice(0, 100) : String(r).slice(0, 100);
    } catch (e) {
      entry.error = String(e?.message ?? e).slice(0, 140);
      entry.code = e?.code;
    }
    rec.methods.push(entry);
  }
  // Same call, WITHOUT chainId in the tx object (what an app that trusts the
  // wallet's active chain would send).
  try {
    await provider.request({
      method: "eth_sendTransaction",
      params: [{ from: "0x0000000000000000000000000000000000000001", to: "0x0000000000000000000000000000000000000002", value: "0x1" }],
    });
    rec.sendNoChainId = "resolved";
  } catch (e) {
    rec.sendNoChainId = String(e?.message ?? e).slice(0, 140);
  }
  return rec;
});

console.log(JSON.stringify({ bundlePath, network: net, ...out }, null, 2));
await browser.close();
