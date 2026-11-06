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

  /**
   * Defect A. A page-world injected provider answers `eth_chainId` by proxying
   * to the wallet's own node. When the page CSP blocks that origin the browser
   * throws a bare `TypeError: Failed to fetch` with no EIP-1193 code, so the
   * generic "check the connection in Monad" copy sent the user to the wrong
   * place. The blocked-fetch shape must be recognised and explained — and, now,
   * told apart from a failure of Intent Pay's *own* chain reads.
   */
  it("recognises a blocked/failed network fetch (the CSP-blocked wallet RPC)", () => {
    for (const err of [
      new TypeError("Failed to fetch"),
      { message: "Failed to fetch" },
      new Error("NetworkError when attempting to fetch resource."),
      { message: "Fetch API cannot load https://monad.twnodes.com/. Refused to connect because it violates the document's Content Security Policy." },
      { cause: { message: "Load failed" } },
    ]) {
      const info = classifyWalletError(err);
      expect(info.kind).toBe("rpc_transport");
      expect(info.rejected).toBe(false);
      // Names the wallet as the failing side and never claims our reads failed.
      expect(info.message).toMatch(/wallet couldn't complete its network request/i);
      expect(info.message).toMatch(/Intent Pay's own chain reads are unaffected/i);
      // It must not instruct the user to change an RPC URL — that is not their job.
      expect(info.message).not.toMatch(/rpc url|change your rpc|settings/i);
    }
  });

  it("keeps a user rejection distinct from a network failure", () => {
    // A rejection must never be re-labelled as a network problem.
    const info = classifyWalletError({ code: 4001, message: "Failed to fetch" });
    expect(info.kind).toBe("rejected");
  });
});
