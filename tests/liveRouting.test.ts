import { describe, expect, it, beforeAll } from "vitest";
import { UniswapV3Provider } from "@/lib/providers/uniswapV3";
import { getToken } from "@/lib/config/tokens";
import { ensureCatalog } from "@/lib/server/discovery";

/**
 * Live integration tests against real Monad mainnet.
 *
 * These are gated because they hit the network. Run with:
 *
 *   MONAD_LIVE_TESTS=1 npx vitest run tests/liveRouting.test.ts
 *
 * They lock in the routing behaviour verified in the T7 fix (QuoterV2 revert
 * decoding via Multicall3, all fee tiers probed, graph reuse) and prove that a
 * token discovered at runtime is routable — the point of this change.
 */
const LIVE = process.env.MONAD_LIVE_TESTS === "1";
const network = "mainnet" as const;

const provider = new UniswapV3Provider("mainnet");

async function quote(pay: string, receive: string, usd = "5") {
  const res = await provider.quote({
    payToken: getToken(pay)!,
    receiveToken: getToken(receive)!,
    mode: "recipient_receives",
    amount: usd,
    usd: true,
    network,
  });
  return res;
}

describe.skipIf(!LIVE)("live routing on Monad mainnet (chain 143)", () => {
  beforeAll(async () => {
    // Mirror production: install the runtime catalog from the live Monad list
    // before routing. Production calls ensureCatalog on every API request; an
    // isolated test must do the same or the bounded route graph cannot discover
    // intermediates that only exist in the list (e.g. cbBTC -> EURW -> USDC).
    await ensureCatalog("mainnet");
    // Warm the graph once so the suite is not dominated by discovery.
    await provider.availableSymbols();
  }, 180_000);

  it("USDT -> USDC quotes with a real route", async () => {
    const res = await quote("USDT", "USDC");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(Number(res.payAmount)).toBeGreaterThan(0);
    expect(res.receiveAmount).toBe("5");
    expect(res.route.path[0]).toBe("USDT");
    expect(res.route.path.at(-1)).toBe("USDC");
  }, 120_000);

  it("USDC -> MON quotes (native MON handling)", async () => {
    const res = await quote("USDC", "MON");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(Number(res.receiveAmount)).toBeGreaterThan(0);
  }, 120_000);

  it("MON -> USDT quotes (native MON input)", async () => {
    const res = await quote("MON", "USDT");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(Number(res.receiveAmount)).toBeGreaterThan(0);
  }, 120_000);

  it("cbBTC -> USDC quotes", async () => {
    const res = await quote("cbBTC", "USDC");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(Number(res.receiveAmount)).toBeGreaterThan(0);
  }, 120_000);

  it("a token discovered at runtime is routable (regression: tokenByKey)", async () => {
    // DUST is in the official list but not a shipped seed, and its only pool is
    // thin — so quote a size its liquidity supports. The point is that the
    // path search can now *reach* a discovered token at all.
    const res = await quote("DUST", "USDC", "0.01");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.route.path[0]).toBe("DUST");
    expect(res.route.path).toContain("USDC");
  }, 120_000);

  it("preserves the exact recipient amount (exact-output intent)", async () => {
    const res = await quote("USDT", "USDC", "5");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.receiveAmount).toBe("5");
  }, 120_000);

  it("alternatives are reachable from the pay token, not merely liquid", async () => {
    // DUST is reachable from USDT (via USDC) but a $5 exact-output quote exceeds
    // its thin liquidity, so this is a route_unavailable. The alternatives must
    // be tokens the sender can actually pay from USDT — never the receive token
    // itself, and never a token that is only liquid somewhere unrelated.
    const res = await quote("USDT", "DUST", "5");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("route_unavailable");
    expect(res.alternatives).toBeTruthy();
    expect(res.alternatives).not.toContain("DUST");
    expect(res.alternatives).toContain("USDC");
  }, 120_000);

  it("multi-hop exact output preserves the recipient amount (regression: forward-quote bug)", async () => {
    // WETH -> MON has no direct pool; it must route WETH -> USDC -> MON. The old
    // path search quoted the *forward* hop with the final MON amount (18-dp)
    // against USDC (6-dp), so this valid route looked unavailable.
    const res = await quote("WETH", "MON", "10");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.route.path[0]).toBe("WETH");
    expect(res.route.path.at(-1)).toBe("MON");
    expect(res.route.path.length).toBeGreaterThan(2); // genuinely multi-hop
    expect(Number(res.receiveAmount)).toBeGreaterThan(0);
    expect(Number(res.payAmount)).toBeGreaterThan(0);
  }, 120_000);

  it("does not substitute the requested output asset", async () => {
    // The requested output asset is authoritative: even though the route passes
    // through USDC, the recipient receives MON — never USDC.
    const res = await quote("WETH", "MON", "10");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.route.path.at(-1)).toBe("MON");
    expect(res.route.hops.at(-1)?.toSymbol).toBe("MON");
  }, 120_000);
});
