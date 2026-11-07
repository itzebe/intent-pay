// Mission 24 — critical experiment: does a fully prepared transaction change
// what the REAL Trust Wallet provider sends to its native bridge, and does it
// stop the provider from touching monad.twnodes.com?
//
// The real bundle (dist/trust-min.js) is loaded, its provider is constructed
// with Trust's own Monad RPC (`http://monad.twnodes.com/`), and its native
// bridge (`window.trustwallet.postMessage`) is spied on. Every fetch to the
// Trust RPC is recorded and made to fail, exactly like a device where that host
// is unreachable.
//
// Two otherwise identical `eth_sendTransaction` requests are issued:
//   A. prepared  — gas + maxFeePerGas + maxPriorityFeePerGas supplied by the app
//   B. omitted   — only from/to/value/chainId (what the app sent before)
//
// We record, per case: the exact object forwarded to the native bridge, whether
// the provider issued any of its own RPC reads, and the outcome.
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
  if (/twnodes/.test(r.url())) net.push(`${r.method()} ${r.url()}`);
});

await page.setContent("<html><body>probe</body></html>");
await page.addScriptTag({ content: bundle });

const out = await page.evaluate(async () => {
  const ADDR = "0x7a91c4b8e2d9f04ab3c6e81d5f72a0c9e4bd92f4";
  const HASH = "0x" + "ab".repeat(32);

  // The page-world fetch is what a Trust RPC read would use; make it fail and
  // record it (the device blocks this host).
  const proxied = [];
  const realFetch = window.fetch;
  window.fetch = async (url, init) => {
    const u = String(url);
    if (/twnodes/.test(u)) {
      proxied.push(u);
      throw new TypeError("Failed to fetch");
    }
    return realFetch(url, init);
  };

  const forwarded = [];
  const provider = new window.trustwallet.Provider({
    ethereum: { address: ADDR, chainId: 143, rpcUrl: "http://monad.twnodes.com/" },
    isDebug: false,
  });
  // The native bridge. Record the object the JS provider hands to native, then
  // answer as a working signer/broadcaster would.
  window.trustwallet.postMessage = (obj) => {
    forwarded.push(obj);
    if (obj.name === "signTransaction") {
      provider.sendResponse(obj.id, HASH);
    } else if (obj.name === "requestAccounts") {
      provider.sendResponse(obj.id, [ADDR]);
    } else {
      provider.sendResponse(obj.id, null);
    }
  };

  const methods = [];
  const orig = provider.request.bind(provider);
  provider.request = async (a) => {
    methods.push(a.method);
    return orig(a);
  };

  const run = async (prepared) => {
    forwarded.length = 0;
    proxied.length = 0;
    methods.length = 0;
    const params = [{ from: ADDR, to: ADDR, value: "0x1", chainId: "0x8f" }];
    if (prepared) {
      Object.assign(params[0], {
        gas: "0x5208",
        maxFeePerGas: "0x1a13b8600",
        maxPriorityFeePerGas: "0x77359400",
      });
    }
    let result;
    try {
      result = await provider.request({ method: "eth_sendTransaction", params });
      result = { ok: true, hash: String(result).slice(0, 12) };
    } catch (e) {
      result = { ok: false, error: String(e && e.message).slice(0, 120), code: e && e.code };
    }
    const sig = forwarded.find((o) => o.name === "signTransaction");
    return {
      result,
      providerMethods: [...methods],
      proxiedReads: [...proxied],
      nativePayloadKeys: sig ? Object.keys(sig.object).sort() : null,
      nativePayload: sig ? sig.object : null,
    };
  };

  return {
    prepared: await run(true),
    omitted: await run(false),
  };
});

console.log(JSON.stringify({ networkRequestsToTrustRpc: net, ...out }, null, 2));
await browser.close();
