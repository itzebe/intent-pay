import { describe, expect, it } from "vitest";
import { DemoProvider } from "@/lib/providers/demo";
import { configFromCurated, tokenBySymbol } from "@/lib/config/tokens";

const provider = new DemoProvider();
const network = "mainnet" as const;

describe("DemoProvider routing (USD-denominated intent)", () => {
  it("prices $5 of SOL: recipient receives ~5, sender pays a little more", async () => {
    const res = await provider.quote({
      network,
      usd: true,
      payToken: tokenBySymbol("USDT"),
      receiveToken: tokenBySymbol("SOL"),
      mode: "recipient_receives",
      amount: "5",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(Number(res.payAmount)).toBeGreaterThan(5);
    expect(Number(res.payAmount)).toBeLessThan(5.1);
    // 5 USD of SOL at $180 -> ~0.0278 SOL
    expect(Number(res.receiveAmount)).toBeCloseTo(5 / 180, 4);
    expect(res.route.path).toEqual(["USDT", "SOL"]);
    expect(res.exactOutput).toBe(true);
  });

  it("prices $5 of USDC from USDT", async () => {
    const res = await provider.quote({
      network,
      usd: true,
      payToken: tokenBySymbol("USDT"),
      receiveToken: tokenBySymbol("USDC"),
      mode: "recipient_receives",
      amount: "5",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.receiveAmount).toBe("5");
    expect(Number(res.payAmount)).toBeGreaterThan(5);
  });

  it("i_spend mode: sender spends exactly the entered amount", async () => {
    const res = await provider.quote({
      network,
      usd: true,
      payToken: tokenBySymbol("USDT"),
      receiveToken: tokenBySymbol("MON"),
      mode: "i_spend",
      amount: "5",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.payAmount).toBe("5");
    // 5 USD of MON at $0.029, minus the 0.8% demo spread -> ~171 MON
    expect(Number(res.receiveAmount)).toBeCloseTo((5 * 0.992) / 0.029, 0);
    expect(res.exactOutput).toBe(false);
  });

  it("treats identical assets as a direct transfer", async () => {
    const res = await provider.quote({
      network,
      usd: true,
      payToken: tokenBySymbol("USDC"),
      receiveToken: tokenBySymbol("USDC"),
      mode: "recipient_receives",
      amount: "5",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.route.kind).toBe("direct");
    expect(res.payAmount).toBe(res.receiveAmount);
  });

  it("is deterministic across calls", async () => {
    const args = {
      network,
      usd: true,
      payToken: tokenBySymbol("MON"),
      receiveToken: tokenBySymbol("USDT"),
      mode: "recipient_receives" as const,
      amount: "3",
    };
    const a = await provider.quote(args);
    const b = await provider.quote(args);
    expect(a.ok && b.ok && a.payAmount === b.payAmount && a.receiveAmount === b.receiveAmount).toBe(true);
  });

  it("prices a token discovered at runtime (not a shipped seed)", async () => {
    const discovered = configFromCurated({
      address: "0x00000000000000000000000000000000000000Cd",
      symbol: "RUNTIME",
      name: "Runtime Token",
      decimals: 18,
    });
    const res = await provider.quote({
      network,
      usd: true,
      payToken: tokenBySymbol("USDT"),
      receiveToken: discovered,
      mode: "recipient_receives",
      amount: "5",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.route.path).toEqual(["USDT", "RUNTIME"]);
    expect(Number(res.receiveAmount)).toBeGreaterThan(0);
  });
});
