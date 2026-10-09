import { describe, expect, it } from "vitest";
import { classifyWalletError } from "@/lib/domain/walletError";

/**
 * The loop involved collapsing every wallet failure into one generic sentence.
 * These tests pin the honest classification that replaced it: a user rejection,
 * an unsupported method, a disconnected chain and a transient error must be
 * distinguishable, and no raw provider message may leak through.
 */
describe("classifyWalletError", () => {
  it("classifies a user rejection (EIP-1193 4001) explicitly", () => {
    const info = classifyWalletError({ code: 4001, message: "User rejected the request." });
    expect(info.kind).toBe("rejected");
    expect(info.rejected).toBe(true);
    expect(info.code).toBe(4001);
    // Fixed, safe sentence — never the provider's own text.
    expect(info.message).toMatch(/rejected the request/i);
    expect(info.message).not.toContain("User rejected the request.");
  });

  it("classifies an unsupported method (4200 / -32601)", () => {
    for (const code of [4200, -32601]) {
      const info = classifyWalletError({ code });
      expect(info.kind).toBe("unsupported");
      expect(info.rejected).toBe(false);
      expect(info.message).toMatch(/doesn't support this request/i);
    }
  });

  it("classifies a disconnected wallet (4900 / 4901)", () => {
    for (const code of [4900, 4901]) {
      const info = classifyWalletError({ code });
      expect(info.kind).toBe("disconnected");
      expect(info.rejected).toBe(false);
    }
  });

  it("finds a nested JSON-RPC code (data / cause / error)", () => {
    expect(classifyWalletError({ data: { code: 4001 } }).kind).toBe("rejected");
    expect(classifyWalletError({ cause: { code: 4200 } }).kind).toBe("unsupported");
    expect(classifyWalletError({ error: { error: { code: 4001 } } }).kind).toBe("rejected");
  });

  it("falls back to unknown for anything else, without throwing", () => {
    for (const err of [undefined, null, "boom", 42, {}, new Error("network down")]) {
      const info = classifyWalletError(err);
      expect(info.kind).toBe("unknown");
      expect(info.rejected).toBe(false);
      expect(info.message.length).toBeGreaterThan(0);
    }
  });
});
