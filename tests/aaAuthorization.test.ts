import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { recoverAuthorizationAddress } from "viem/utils";
import {
  AaAuthorizationError,
  MAX_AUTHORIZATION_NONCE,
  prepareSignedAuthorization,
  isPlaceholderSignature,
} from "@/lib/aa/authorization";
import { buildAuthorizationSigner } from "@/lib/aa/account";

/**
 * EIP-7702 authorization preparation.
 *
 * The production defect: the ERC-20 gas path passed viem's *placeholder*
 * authorization to the bundler instead of a real signature. These tests pin the
 * real signing/validation contract. A deterministic test key is used (never a
 * user key); nothing here signs for a real account or broadcasts anything.
 *
 * The authorization `nonce` is the authority's EOA transaction nonce and is a
 * `bigint` throughout — these tests never pass the UserOperation nonce.
 */

const OWNER = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4" as const;
const IMPL = "0xe6Cae83BdE06E4c305530e199D7217f42808555B" as const;
const CHAIN = 143;
// Well-known Hardhat/Anvil test key #1 — a fixture, not a user wallet.
const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

const local = privateKeyToAccount(TEST_KEY);

/** A signer that produces a REAL signature via the local test account. */
function realSigner(owner: string = local.address) {
  return {
    address: owner as `0x${string}`,
    signAuthorization: (a: { address: `0x${string}`; chainId: number; nonce: bigint }) =>
      local.signAuthorization({
        contractAddress: a.address,
        chainId: a.chainId,
        nonce: Number(a.nonce),
      }),
  };
}

/** Convert our bigint-nonce authorization to viem's number-nonce shape. */
function forViem(a: {
  address: `0x${string}`;
  chainId: number;
  nonce: bigint;
  r: `0x${string}`;
  s: `0x${string}`;
  yParity: number;
}) {
  return { ...a, nonce: Number(a.nonce) };
}

describe("prepareSignedAuthorization", () => {
  it("Test A: signs a real, non-placeholder authorization bound to the chain + implementation", async () => {
    const { authorization, request } = await prepareSignedAuthorization({
      signer: realSigner(OWNER) as never,
      owner: OWNER,
      chainId: CHAIN,
      implementation: IMPL,
      nonce: 7n,
    });
    expect(request).toEqual({ address: IMPL, chainId: CHAIN, nonce: 7n });
    expect(authorization.chainId).toBe(CHAIN);
    expect(authorization.address.toLowerCase()).toBe(IMPL.toLowerCase());
    expect(authorization.nonce).toBe(7n);
    expect(typeof authorization.nonce).toBe("bigint");
    expect(authorization.r).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(authorization.s).toMatch(/^0x[0-9a-fA-F]{64}$/);
    // Never viem's placeholder.
    expect(isPlaceholderSignature(authorization.r, authorization.s)).toBe(false);
    expect([0, 1]).toContain(Number(authorization.yParity));
  });

  it("Test A: the produced authorization recovers to the real signing EOA", async () => {
    // A cryptographic check: the signature must recover to the signer address,
    // proving it is a genuine EIP-7702 authorization (not a placeholder).
    const { authorization } = await prepareSignedAuthorization({
      signer: realSigner(OWNER) as never,
      owner: OWNER,
      chainId: CHAIN,
      implementation: IMPL,
      nonce: 9n,
    });
    const recovered = await recoverAuthorizationAddress({ authorization: forViem(authorization) });
    expect(recovered.toLowerCase()).toBe(local.address.toLowerCase());
  });

  it("Test B: fails explicitly when the signer cannot sign authorizations", async () => {
    await expect(
      prepareSignedAuthorization({
        signer: undefined,
        owner: OWNER,
        chainId: CHAIN,
        implementation: IMPL,
        nonce: 0n,
      }),
    ).rejects.toMatchObject({ code: "unsupported_signer" });
  });

  it("Test C: propagates a signing rejection (no silent fallback)", async () => {
    const signer = {
      address: OWNER as `0x${string}`,
      signAuthorization: vi.fn(async () => {
        throw new Error("User rejected request");
      }),
    };
    await expect(
      prepareSignedAuthorization({ signer: signer as never, owner: OWNER, chainId: CHAIN, implementation: IMPL, nonce: 0n }),
    ).rejects.toMatchObject({ code: "signing_failed" });
    await expect(
      prepareSignedAuthorization({ signer: signer as never, owner: OWNER, chainId: CHAIN, implementation: IMPL, nonce: 0n }),
    ).rejects.toBeInstanceOf(AaAuthorizationError);
  });

  it("rejects a nonce outside the EIP-7702 uint64 range before signing", async () => {
    const signer = { address: OWNER as `0x${string}`, signAuthorization: vi.fn() };
    await expect(
      prepareSignedAuthorization({
        signer: signer as never,
        owner: OWNER,
        chainId: CHAIN,
        implementation: IMPL,
        nonce: MAX_AUTHORIZATION_NONCE + 1n,
      }),
    ).rejects.toMatchObject({ code: "invalid_nonce" });
    await expect(
      prepareSignedAuthorization({
        signer: signer as never,
        owner: OWNER,
        chainId: CHAIN,
        implementation: IMPL,
        nonce: -1n,
      }),
    ).rejects.toMatchObject({ code: "invalid_nonce" });
    // An out-of-range value must never reach the signer.
    expect(signer.signAuthorization).not.toHaveBeenCalled();
  });

  it("Test D: rejects a placeholder signature as invalid", async () => {
    const placeholder = {
      address: OWNER as `0x${string}`,
      signAuthorization: async () => ({
        address: IMPL,
        chainId: CHAIN,
        nonce: 0n,
        r: "0xfffffffffffffffffffffffffffffff000000000000000000000000000000000",
        s: "0x7aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        yParity: 1,
      }),
    };
    await expect(
      prepareSignedAuthorization({ signer: placeholder as never, owner: OWNER, chainId: CHAIN, implementation: IMPL, nonce: 0n }),
    ).rejects.toMatchObject({ code: "invalid_authorization" });
  });

  it("Test D: rejects malformed (missing r/s) results", async () => {
    const bad = {
      address: OWNER as `0x${string}`,
      signAuthorization: async () => ({ address: IMPL, chainId: CHAIN, nonce: 0n }),
    };
    await expect(
      prepareSignedAuthorization({ signer: bad as never, owner: OWNER, chainId: CHAIN, implementation: IMPL, nonce: 0n }),
    ).rejects.toMatchObject({ code: "invalid_authorization" });
  });

  it("Test E: rejects an authorization signed for the wrong chain", async () => {
    const wrongChain = {
      address: OWNER as `0x${string}`,
      signAuthorization: (a: { address: `0x${string}`; nonce: bigint }) =>
        local.signAuthorization({ contractAddress: a.address, chainId: 1, nonce: Number(a.nonce) }),
    };
    await expect(
      prepareSignedAuthorization({ signer: wrongChain as never, owner: OWNER, chainId: CHAIN, implementation: IMPL, nonce: 0n }),
    ).rejects.toMatchObject({ code: "invalid_authorization" });
  });

  it("Test E: rejects an authorization targeting the wrong implementation", async () => {
    const wrongImpl = {
      address: OWNER as `0x${string}`,
      signAuthorization: (a: { chainId: number; nonce: bigint }) =>
        local.signAuthorization({
          contractAddress: "0x000000000000000000000000000000000000dEaD",
          chainId: a.chainId,
          nonce: Number(a.nonce),
        }),
    };
    await expect(
      prepareSignedAuthorization({ signer: wrongImpl as never, owner: OWNER, chainId: CHAIN, implementation: IMPL, nonce: 0n }),
    ).rejects.toMatchObject({ code: "invalid_authorization" });
  });

  it("Test E: rejects a signer that is not the payment account", async () => {
    await expect(
      prepareSignedAuthorization({
        signer: realSigner(local.address) as never,
        owner: OWNER,
        chainId: CHAIN,
        implementation: IMPL,
        nonce: 0n,
      }),
    ).rejects.toMatchObject({ code: "invalid_authorization" });
  });

  it("rejects an authorization the wallet signed for a different nonce", async () => {
    const shifted = {
      address: OWNER as `0x${string}`,
      signAuthorization: (a: { address: `0x${string}`; chainId: number }) =>
        local.signAuthorization({ contractAddress: a.address, chainId: a.chainId, nonce: 99 }),
    };
    await expect(
      prepareSignedAuthorization({ signer: shifted as never, owner: OWNER, chainId: CHAIN, implementation: IMPL, nonce: 3n }),
    ).rejects.toMatchObject({ code: "invalid_authorization" });
  });
});

describe("buildAuthorizationSigner (injected wallet)", () => {
  it("Test A: signs via eth_signAuthorization and normalises decimal fields", async () => {
    const calls: string[] = [];
    const provider = {
      request: vi.fn(async ({ method }: { method: string }) => {
        calls.push(method);
        return { address: IMPL, chainId: CHAIN, nonce: 3, r: "0x" + "11".repeat(32), s: "0x" + "22".repeat(32), yParity: 1 };
      }),
    };
    const { signer, capable } = buildAuthorizationSigner(provider as never, OWNER);
    expect(capable).toBe(true);
    const signed = await signer!.signAuthorization({ address: IMPL, chainId: CHAIN, nonce: 3n });
    expect(calls[0]).toBe("eth_signAuthorization");
    expect(signed.r).toBe("0x" + "11".repeat(32));
    expect(signed.nonce).toBe(3n);
    expect(Number(signed.yParity)).toBe(1);
  });

  it("Test A: falls back to wallet_signAuthorization on a method-not-found error", async () => {
    const methods: string[] = [];
    const provider = {
      request: vi.fn(async ({ method }: { method: string }) => {
        methods.push(method);
        if (method === "eth_signAuthorization") {
          throw { code: -32601, message: "Method not found" };
        }
        return { contractAddress: IMPL, chainId: "0x8f", nonce: 1, r: "0x" + "33".repeat(32), s: "0x" + "44".repeat(32), v: 28 };
      }),
    };
    const { signer } = buildAuthorizationSigner(provider as never, OWNER);
    const signed = await signer!.signAuthorization({ address: IMPL, chainId: CHAIN, nonce: 1n });
    expect(methods).toEqual(["eth_signAuthorization", "wallet_signAuthorization"]);
    expect(Number(signed.yParity)).toBe(1); // 28 -> 1
  });

  it("does NOT retry a second method after a user rejection (no double prompt)", async () => {
    const methods: string[] = [];
    const provider = {
      request: vi.fn(async ({ method }: { method: string }) => {
        methods.push(method);
        throw { code: 4001, message: "User rejected the request" };
      }),
    };
    const { signer } = buildAuthorizationSigner(provider as never, OWNER);
    await expect(
      signer!.signAuthorization({ address: IMPL, chainId: CHAIN, nonce: 0n }),
    ).rejects.toMatchObject({ code: 4001 });
    expect(methods).toEqual(["eth_signAuthorization"]);
  });

  it("does NOT retry a second method after a generic provider error", async () => {
    const methods: string[] = [];
    const provider = {
      request: vi.fn(async ({ method }: { method: string }) => {
        methods.push(method);
        throw new Error("Internal JSON-RPC error");
      }),
    };
    const { signer } = buildAuthorizationSigner(provider as never, OWNER);
    await expect(
      signer!.signAuthorization({ address: IMPL, chainId: CHAIN, nonce: 0n }),
    ).rejects.toThrow("Internal JSON-RPC error");
    expect(methods).toEqual(["eth_signAuthorization"]);
  });

  it("Test A: normalises a packed signature string", async () => {
    const provider = {
      request: vi.fn(async () => ({
        address: IMPL,
        chainId: CHAIN,
        nonce: 0,
        signature: "0x" + "aa".repeat(32) + "bb".repeat(32) + "1c",
      })),
    };
    const { signer } = buildAuthorizationSigner(provider as never, OWNER);
    const signed = await signer!.signAuthorization({ address: IMPL, chainId: CHAIN, nonce: 0n });
    expect(signed.r).toBe("0x" + "aa".repeat(32));
    expect(signed.s).toBe("0x" + "bb".repeat(32));
    expect(Number(signed.yParity)).toBe(1); // 0x1c = 28 -> 1
  });

  it("Test B: reports incapable when the provider exposes no request method", () => {
    const { capable, signer } = buildAuthorizationSigner(undefined, OWNER);
    expect(capable).toBe(false);
    expect(signer).toBeUndefined();
  });
});
