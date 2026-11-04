import { describe, expect, it } from "vitest";
import {
  chainIdFromHex,
  connectionErrorMessage,
  firstAccount,
  isMonadChainId,
  pickRestorableWallet,
  statusForAccounts,
} from "@/lib/wallet/connection";

/**
 * Pure connection-lifecycle rules. No provider, no browser: every rule the
 * shared wallet hook depends on is asserted directly here.
 */

describe("chainIdFromHex", () => {
  it("parses a hex chain id", () => {
    expect(chainIdFromHex("0x8f")).toBe(143);
    expect(chainIdFromHex("0x1")).toBe(1);
  });

  it("rejects malformed values instead of guessing", () => {
    expect(chainIdFromHex("143")).toBeUndefined();
    expect(chainIdFromHex("0x")).toBeUndefined();
    expect(chainIdFromHex(undefined)).toBeUndefined();
    expect(chainIdFromHex(143)).toBeUndefined();
    expect(chainIdFromHex("0xzz")).toBeUndefined();
  });
});

describe("isMonadChainId", () => {
  it("is true only for Monad Mainnet (143)", () => {
    expect(isMonadChainId(143)).toBe(true);
    expect(isMonadChainId(1)).toBe(false);
    expect(isMonadChainId(undefined)).toBe(false);
  });
});

describe("firstAccount / statusForAccounts", () => {
  it("returns the first valid address", () => {
    const a = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4";
    const b = "0x1111111111111111111111111111111111111111";
    expect(firstAccount([a, b])).toBe(a);
  });

  it("ignores malformed entries", () => {
    expect(firstAccount(["not-an-address", "0x123"])).toBeUndefined();
    expect(firstAccount([])).toBeUndefined();
    expect(firstAccount(undefined)).toBeUndefined();
    expect(firstAccount("0xabc")).toBeUndefined();
  });

  it("maps an empty list to disconnected and a non-empty one to connected", () => {
    expect(statusForAccounts([])).toBe("disconnected");
    expect(statusForAccounts(undefined)).toBe("disconnected");
    expect(statusForAccounts(["0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4"])).toBe("connected");
  });
});

describe("pickRestorableWallet", () => {
  const wallets = [{ id: "uuid-mm" }, { id: "legacy:0" }];

  it("restores a stored wallet that still exists", () => {
    expect(pickRestorableWallet("uuid-mm", wallets)).toBe("uuid-mm");
  });

  it("does not restore a wallet that is gone", () => {
    expect(pickRestorableWallet("uuid-gone", wallets)).toBeNull();
  });

  it("returns null when nothing was stored", () => {
    expect(pickRestorableWallet(null, wallets)).toBeNull();
  });
});

describe("connectionErrorMessage", () => {
  it("keeps the user-rejection copy distinct", () => {
    expect(connectionErrorMessage({ code: 4001 })).toMatch(/rejected/i);
  });

  it("is generic and never echoes a raw provider string for other errors", () => {
    const msg = connectionErrorMessage(new Error("Internal JSON-RPC error: secret-ish detail"));
    expect(msg).not.toContain("secret-ish");
    expect(msg).toMatch(/couldn't connect/i);
  });
});
