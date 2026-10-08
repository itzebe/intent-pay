import { describe, expect, it } from "vitest";
import { selectSource, gasCovered, type SourceOption } from "@/lib/domain/sourceSelection";
import type { Balance } from "@/lib/domain/intent";
import { normalizeTokenConfig } from "@/lib/config/tokens";

const ADDR = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";

function bal(symbol: string, amount: string, usd: number, native = false): Balance {
  return {
    token: normalizeTokenConfig({ symbol, name: symbol, address: native ? undefined : ADDR, decimals: native ? 18 : 6, native }),
    amount,
    usd,
  };
}

function opt(symbol: string, o: Partial<SourceOption> = {}): SourceOption {
  return {
    symbol,
    ok: true,
    sufficient: true,
    payAmount: "1",
    payUsd: 10,
    totalSenderCostUsd: 10.1,
    routePath: [symbol, "MON"],
    ...o,
  };
}

const base = {
  recipientAsset: "MON",
  gasMode: "native" as const,
  gasAbstracted: false,
};

describe("source selection — the named asset is the recipient, not the source", () => {
  it("auto-selects the best executable, sufficient asset (never the recipient asset by default)", () => {
    const sel = selectSource({
      ...base,
      balances: [bal("USDC", "250", 250), bal("MON", "0.5", 1.0, true)],
      options: [opt("USDC"), opt("MON"), opt("USDT")],
    });
    expect(sel.sourceAsset).toBe("USDC");
    expect(["auto_best_cost", "direct_recipient_asset"]).toContain(sel.code);
  });

  it("prefers the recipient asset only when it is itself the best option (no conversion)", () => {
    const sel = selectSource({
      ...base,
      recipientAsset: "MON",
      balances: [bal("MON", "100", 300, true)],
      options: [opt("MON", { routePath: ["MON"] })],
    });
    expect(sel.sourceAsset).toBe("MON");
    expect(sel.code).toBe("direct_recipient_asset");
  });

  it("skips an option with no executable route", () => {
    const sel = selectSource({
      ...base,
      balances: [bal("USDC", "250", 250), bal("XXX", "1", 250), bal("MON", "1", 3, true)],
      options: [opt("XXX", { ok: false, reason: "no executable route" }), opt("USDC")],
    });
    expect(sel.sourceAsset).toBe("USDC");
  });

  it("skips an option whose balance is insufficient", () => {
    const sel = selectSource({
      ...base,
      balances: [bal("USDC", "1", 1), bal("USDT", "500", 500), bal("MON", "1", 3, true)],
      options: [opt("USDC", { sufficient: false }), opt("USDT")],
    });
    expect(sel.sourceAsset).toBe("USDT");
  });
});

describe("source selection — explicit choice is authoritative", () => {
  it("keeps the user's chosen source while it is executable + sufficient", () => {
    const sel = selectSource({
      ...base,
      balances: [bal("USDC", "250", 250), bal("USDT", "500", 500), bal("MON", "1", 3, true)],
      options: [opt("USDT"), opt("USDC")],
      explicit: { symbol: "USDC", origin: "user" },
    });
    expect(sel.sourceAsset).toBe("USDC");
    expect(sel.code).toBe("explicit_user");
  });

  it("never silently replaces an unusable explicit choice — it reports instead", () => {
    const sel = selectSource({
      ...base,
      balances: [bal("USDC", "1", 1), bal("USDT", "500", 500), bal("MON", "1", 3, true)],
      options: [opt("USDC", { sufficient: false }), opt("USDT")],
      explicit: { symbol: "USDC", origin: "user" },
    });
    expect(sel.sourceAsset).toBe("USDC");
    expect(sel.code).toBe("explicit_unusable");
    expect(sel.blocker).toBeTruthy();
  });
});

describe("source selection — honest failure states", () => {
  it("reports no balances", () => {
    const sel = selectSource({ ...base, balances: [], options: [] });
    expect(sel.sourceAsset).toBeNull();
    expect(sel.code).toBe("no_balances");
  });

  it("reports when nothing is funded", () => {
    const sel = selectSource({
      ...base,
      balances: [bal("USDC", "1", 1), bal("MON", "1", 3, true)],
      options: [opt("USDC", { sufficient: false })],
    });
    expect(sel.sourceAsset).toBeNull();
    expect(sel.code).toBe("none_executable");
    expect(sel.blocker).toMatch(/enough/i);
  });

  it("reports when nothing is routable", () => {
    const sel = selectSource({
      ...base,
      balances: [bal("USDC", "250", 250), bal("MON", "1", 3, true)],
      options: [opt("USDC", { ok: false, reason: "no executable route" })],
    });
    expect(sel.sourceAsset).toBeNull();
    expect(sel.blocker).toMatch(/route/i);
  });

  it("never selects an asset when the network fee cannot be paid (native gas)", () => {
    const sel = selectSource({
      recipientAsset: "MON",
      gasMode: "native",
      gasAbstracted: false,
      balances: [bal("USDC", "250", 250), bal("MON", "0.0001", 0.0003, true)],
      options: [opt("USDC")],
      gasRequiredMon: "0.01",
    });
    expect(sel.sourceAsset).toBeNull();
    expect(sel.blocker).toMatch(/MON/i);
  });

  it("does not block on gas when a paymaster genuinely covers it", () => {
    const sel = selectSource({
      recipientAsset: "MON",
      gasMode: "sponsored",
      gasAbstracted: true,
      balances: [bal("USDC", "250", 250)],
      options: [opt("USDC")],
      gasRequiredMon: "0.5",
    });
    expect(sel.sourceAsset).toBe("USDC");
  });
});

describe("gasCovered", () => {
  it("is true when abstracted regardless of MON", () => {
    expect(
      gasCovered({
        recipientAsset: "MON",
        gasMode: "sponsored",
        gasAbstracted: true,
        balances: [],
      }),
    ).toBe(true);
  });
  it("is false with no native balance under native gas", () => {
    expect(
      gasCovered({ recipientAsset: "MON", gasMode: "native", gasAbstracted: false, balances: [] }),
    ).toBe(false);
  });
});
