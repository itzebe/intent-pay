import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { isPlaceholderSignature } from "@/lib/aa/authorization";

/**
 * EIP-7702 authorization propagation through the ERC-20 execution path.
 *
 * The production defect: `executePlanViaAa` sourced the authorization nonce from
 * the EntryPoint account (`account.getNonce()`), which returns a 2D UserOperation
 * nonce (a nonce *key* in the high bits, far above EIP-7702's `uint64` bound).
 * These tests drive the REAL `executePlanViaAa` with a deterministic local test
 * key (never a user key), a mocked bundler, and deliberately DIFFERENT EOA and
 * EntryPoint nonces so an accidental substitution is impossible to miss.
 *
 * Nothing here broadcasts: the bundler client is mocked and `fetch` is stubbed,
 * so no state-changing RPC can leave the process.
 */

const SENDER = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4" as const;
const IMPL = "0xe6Cae83BdE06E4c305530e199D7217f42808555B" as const;
const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" as const;
const PAYMASTER = "0x888888888888ec68a58ab8094cc1ad20ba3d2402" as const;
const CHAIN = 143;
const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const local = privateKeyToAccount(TEST_KEY);

// The EOA transaction nonce the authorization MUST use (small, uint64-valid).
const EOA_TX_NONCE = 3n;
// A realistic EntryPoint 2D nonce: key in the high 192 bits, above 2^64.
const ENTRYPOINT_NONCE = (1234567890123456789n << 64n) | 5n;

type Ref = {
  signer?: {
    address: string;
    signAuthorization: (a: { address: string; chainId: number; nonce: bigint }) => Promise<unknown>;
  };
  prepare: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  wait: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
  getTransactionCount: ReturnType<typeof vi.fn>;
  nonceCalls: { address: string; blockTag?: string }[];
};

const ref = vi.hoisted(() => ({}) as Record<string, unknown>) as unknown as Ref;

vi.mock("viem/account-abstraction", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createBundlerClient: () => ({
      prepareUserOperation: ref.prepare,
      sendUserOperation: ref.send,
      waitForUserOperationReceipt: ref.wait,
      request: ref.request,
      getUserOperationReceipt: vi.fn(),
    }),
  };
});

vi.mock("@/lib/aa/account", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createAaAccount: async () => ({
      address: SENDER,
      account: {
        address: SENDER,
        entryPoint: { address: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108" },
        // Deliberately the EntryPoint 2D nonce — never the authorization nonce.
        getNonce: async () => ENTRYPOINT_NONCE,
      },
      walletClient: {},
      authorizationSigner: ref.signer,
    }),
  };
});

import { executePlanViaAa } from "@/lib/aa/execution";
import type { PaymentPlan } from "@/lib/execution/plan";
import { getToken } from "@/lib/config/tokens";

function usdcPlan(): PaymentPlan {
  const usdc = getToken("USDC")!;
  return {
    executable: true,
    primaryStepId: "transfer",
    slippageBps: 50,
    steps: [
      { id: "transfer", kind: "transfer", label: "Send USDC", token: usdc, to: "0x1111111111111111111111111111111111111111", amount: 300_000n },
    ],
  };
}

/** A public client whose EOA transaction nonce is small and uint64-valid. */
function fakePublicClient() {
  return {
    getTransactionCount: ref.getTransactionCount,
  } as never;
}

beforeEach(() => {
  ref.getTransactionCount = vi.fn(async () => Number(EOA_TX_NONCE));
  ref.nonceCalls = [];
  ref.prepare = vi.fn(async (args: any) => ({
    callGasLimit: 200_000n,
    verificationGasLimit: 200_000n,
    preVerificationGas: 50_000n,
    paymasterVerificationGasLimit: 100_000n,
    paymasterPostOpGasLimit: 50_000n,
    maxFeePerGas: 10_000_000_000n,
    authorization: args.authorization,
  }));
  ref.send = vi.fn(async () => "0xuserophash");
  ref.wait = vi.fn(async () => ({ success: true, receipt: { transactionHash: "0xtxhash" }, logs: [] }));
  ref.request = vi.fn(async () => ({ standard: { maxFeePerGas: "0x2540be400" } }));
  ref.signer = {
    address: SENDER,
    signAuthorization: (a: { address: string; chainId: number; nonce: bigint }) =>
      local.signAuthorization({ contractAddress: a.address as `0x${string}`, chainId: a.chainId, nonce: Number(a.nonce) }),
  } as never;

  // Only the gas *quote* GET should be reachable; any other call is unexpected.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("/api/aa/paymaster?")) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            quote: {
              paymaster: PAYMASTER,
              token: { address: USDC, symbol: "USDC", decimals: 6 },
              exchangeRate: "1000000000000",
              postOpGas: "100000",
            },
          }),
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("executePlanViaAa — authorization nonce source", () => {
  it("Test 1/2: uses the EOA transaction nonce (pending) for the authorization, read from the sender", async () => {
    await executePlanViaAa(usdcPlan(), {} as never, SENDER, "mainnet", USDC, fakePublicClient(), undefined, 1_000_000_000_000n);
    expect(ref.getTransactionCount).toHaveBeenCalledTimes(1);
    const call = ref.getTransactionCount.mock.calls[0][0] as any;
    expect(call.address.toLowerCase()).toBe(SENDER.toLowerCase());
    expect(call.blockTag).toBe("pending");
  });

  it("Test 3/4/5: the authorization nonce is the EOA nonce — a bigint below 2^64, never the EntryPoint nonce", async () => {
    const signed: { nonce?: bigint }[] = [];
    ref.signer = {
      address: SENDER,
      signAuthorization: (a: { address: string; chainId: number; nonce: bigint }) => {
        signed.push({ nonce: a.nonce });
        return local.signAuthorization({
          contractAddress: a.address as `0x${string}`,
          chainId: a.chainId,
          nonce: Number(a.nonce),
        });
      },
    } as never;

    await executePlanViaAa(usdcPlan(), {} as never, SENDER, "mainnet", USDC, fakePublicClient(), undefined, 1_000_000_000_000n);

    // The signer was asked for the EOA nonce, as a bigint.
    expect(signed).toHaveLength(1);
    expect(typeof signed[0].nonce).toBe("bigint");
    expect(signed[0].nonce).toBe(EOA_TX_NONCE);
    expect(signed[0].nonce! < 2n ** 64n).toBe(true);

    const sendAuth = (ref.send.mock.calls[0][0] as any).authorization;
    expect(sendAuth.nonce).toBe(EOA_TX_NONCE);
    // The EntryPoint 2D nonce must NEVER appear as the authorization nonce.
    expect(sendAuth.nonce).not.toBe(ENTRYPOINT_NONCE);
    expect(sendAuth.nonce < 2n ** 64n).toBe(true);
  });

  it("Test 12: refuses an out-of-range authorization nonce before submission", async () => {
    // If the authorization nonce ever came from the EntryPoint 2D nonce (or any
    // value ≥ 2^64), the guard must refuse it before eth_sendUserOperation.
    ref.getTransactionCount = vi.fn(async () => Number(ENTRYPOINT_NONCE)); // ~1.2e18*2^64, huge
    await expect(
      executePlanViaAa(usdcPlan(), {} as never, SENDER, "mainnet", USDC, fakePublicClient(), undefined, 1_000_000_000_000n),
    ).rejects.toThrow(/nonce/i);
    expect(ref.prepare).not.toHaveBeenCalled();
    expect(ref.send).not.toHaveBeenCalled();
  });
});

describe("executePlanViaAa — real authorization propagation", () => {
  it("Test 7: passes the same real signed authorization to prepare and send (no placeholder)", async () => {
    const res = await executePlanViaAa(usdcPlan(), {} as never, SENDER, "mainnet", USDC, fakePublicClient(), undefined, 1_000_000_000_000n);

    expect(res.userOpHash).toBe("0xuserophash");
    expect(ref.prepare).toHaveBeenCalledTimes(1);
    expect(ref.send).toHaveBeenCalledTimes(1);

    const prepareAuth = (ref.prepare.mock.calls[0][0] as any).authorization;
    const sendAuth = (ref.send.mock.calls[0][0] as any).authorization;
    expect(prepareAuth).toBeTruthy();
    expect(sendAuth).toBeTruthy();
    // The real, non-placeholder signature (bound to chain + implementation).
    expect(isPlaceholderSignature(sendAuth.r, sendAuth.s)).toBe(false);
    expect(sendAuth.address.toLowerCase()).toBe(IMPL.toLowerCase());
    expect(Number(sendAuth.chainId)).toBe(CHAIN);
    // prepare and send carry the same authorization object.
    expect(sendAuth).toEqual(prepareAuth);
  });

  it("Test 6/F: preserves the bounded gas-token approval (never unlimited, ≤ half balance)", async () => {
    await executePlanViaAa(usdcPlan(), {} as never, SENDER, "mainnet", USDC, fakePublicClient(), undefined, 1_000_000_000_000n);
    const calls = (ref.send.mock.calls[0][0] as any).calls as { to: string; data: string; value: bigint }[];
    // First call is the approve to the verified paymaster; second is the transfer.
    expect(calls.length).toBe(2);
    expect(calls[0].to.toLowerCase()).toBe(USDC.toLowerCase());
    const selector = calls[0].data.slice(0, 10);
    expect(selector).toBe("0x095ea7b3"); // approve(address,uint256)
    const amount = BigInt("0x" + calls[0].data.slice(10 + 64)); // second arg (spender is first)
    expect(amount).toBeGreaterThan(0n);
    expect(amount).toBeLessThanOrEqual(500_000_000_000n); // ≤ half the balance
    expect(amount).not.toBe(2n ** 256n - 1n); // never uint256.max
    // The payment transfer is untouched.
    expect(calls[1].to.toLowerCase()).toBe(USDC.toLowerCase());
    expect(calls[1].data.slice(0, 10)).toBe("0xa9059cbb"); // transfer(address,uint256)
  });

  it("Test 8/B/C: a missing signer fails BEFORE any submission (no fallback, no broadcast)", async () => {
    ref.signer = undefined;
    await expect(
      executePlanViaAa(usdcPlan(), {} as never, SENDER, "mainnet", USDC, fakePublicClient(), undefined, 1_000_000_000_000n),
    ).rejects.toThrow(/can't sign the EIP-7702 authorization/i);
    expect(ref.prepare).not.toHaveBeenCalled();
    expect(ref.send).not.toHaveBeenCalled();
  });

  it("Test 11/G: preparation never issues eth_sendUserOperation; only the mocked bundler submit runs", async () => {
    await executePlanViaAa(usdcPlan(), {} as never, SENDER, "mainnet", USDC, fakePublicClient(), undefined, 1_000_000_000_000n);
    const fetchCalls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(fetchCalls.some((u) => u.includes("eth_sendUserOperation"))).toBe(false);
    // The submission boundary is exactly the bundler's sendUserOperation.
    expect(ref.send).toHaveBeenCalledTimes(1);
  });
});
