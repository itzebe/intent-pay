// Contrast probe: the app's OWN RPC clients (rpc.monad.xyz / alchemy) reachable
// from the production page context, proving the CSP blocks only the wallet's
// http:// URL, not our endpoints. Read-only.
import { chromium } from "playwright";
const base = process.argv[2] ?? "https://intent-pay-roan.vercel.app";
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox","--disable-dev-shm-usage"] });
const page = await (await browser.newContext()).newPage();
await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(1000);
const out = await page.evaluate(async () => {
  const post = (url) => fetch(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) })
    .then(async (r) => ({ ok: r.ok, status: r.status, body: (await r.text()).slice(0, 80) }))
    .catch((e) => ({ error: String(e).slice(0, 120) }));
  return {
    publicMonad: await post("https://rpc.monad.xyz"),
    alchemy: await post("https://monad-mainnet.g.alchemy.com/v2/0"),
    twnodesHttps: await post("https://monad.twnodes.com/"),
    twnodesHttp: await post("http://monad.twnodes.com/"),
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
