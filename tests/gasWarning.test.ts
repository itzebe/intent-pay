import { describe, expect, it } from "vitest";
import { nativeGasWarning } from "@/lib/domain/gasWarning";

/**
 * The reported bug: a 0-MON wallet saw "You need a small amount of MON for
 * network fees … Your wallet needs MON" while the same screen advertised ERC-20
 * gas payment. These tests pin the honesty rule: a MON demand is only worded as
 * such when no ERC-20 path is offered; otherwise the real blocker is named and
 * the message never claims the paymaster is absent.
 */
describe("native gas warning honesty", () => {
  it("demands MON only when no ERC-20 gas path is offered", () => {
    const w = nativeGasWarning({
      requiredMon: "0.01212",
      availableMon: "0",
      erc20GasOffered: false,
    });
    expect(w.nativeRequired).toBe(true);
    expect(w.detail).toContain("0.01212");
    expect(w.detail).toMatch(/MON/);
  });

  it("never demands MON while ERC-20 gas is offered, and names the real reason", () => {
    const w = nativeGasWarning({
      requiredMon: "0.01212",
      availableMon: "0",
      erc20GasOffered: true,
      reason: "Best available gas token: WMON.",
    });
    expect(w.nativeRequired).toBe(false);
    expect(w.detail).not.toMatch(/Your wallet holds 0 MON/);
    expect(w.detail).toBe("Best available gas token: WMON.");
  });

  it("uses an honest fallback (no fabricated MON demand) when offered with no reason", () => {
    const w = nativeGasWarning({
      requiredMon: "0.01212",
      availableMon: "0",
      erc20GasOffered: true,
    });
    expect(w.nativeRequired).toBe(false);
    expect(w.detail).not.toMatch(/needs MON|holds 0 MON/i);
    expect(w.detail).toMatch(/gas token/i);
  });
});
