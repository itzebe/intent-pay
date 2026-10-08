import { describe, expect, it } from "vitest";
import {
  parseProviderToken,
  estimateTokenCost,
  estimateUserOpGas,
  formatTokenAmount,
} from "@/lib/server/paymaster/pimlico";
import { normalizeSupportedTokens, isSupportedGasToken, gasTokenConfig } from "@/lib/server/paymaster/capabilities";
import {
  selectGasPaymentToken,
  isViable,
  rankViable,
  candidateKey,
  type GasTokenCandidate,
} from "@/lib/aa/gasToken";
import { resolveWalletAbstraction, gasPaymentForToken } from "@/lib/aa/capability";
import { boundGasSpend, isSafeSpend, withGasBuffer } from "@/lib/aa/safety";
import type { SupportedTokensResult } from "@/lib/server/paymaster/types";

const USDC_ADDR = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" as const;
const USDT_ADDR = "0xe7cd86e13AC4309349F30B3435a9d337750fC82D" as const;
const WMON_ADDR = "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A" as const;
const RANDOM_ADDR = "0x1111111111111111111111111111111111111111" as const;

function supported(addresses: string[]): SupportedTokensResult {
  return {
    ok: true,
    at: Date.now(),
    source: "pimlico",
    tokens: addresses.map((a) => ({
      chainId: 143,
      address: a as `0x${string}`,
      symbol: a === USDC_ADDR ? "USDC" : a === WMON_ADDR ? "WMON" : "TOK",
      name: "Tok",
      decimals: 6,
    })),
  };
}

/**
 * Honest ERC-20 gas capability.
 *
 * The cardinal rule this suite pins: support is decided by the provider's live
 * answer and real balances — never by a hardcoded symbol, never by a configured
 * boolean, and never by proxy of "the token resolves".
 */
describe("provider token parsing", () => {
  it("accepts a well-formed token and normalizes the address", () => {
    const t = parseProviderToken({ token: USDC_ADDR, symbol: "USDC", decimals: 6 }, 143);
    expect(t).not.toBeNull();
    expect(t!.address).toBe(USDC_ADDR);
    expect(t!.decimals).toBe(6);
    expect(t!.chainId).toBe(143);
  });

  it("rejects a malformed address rather than defaulting it", () => {
    expect(parseProviderToken({ token: "not-an-address" }, 143)).toBeNull();
  });

  it("never trusts a missing decimals as a real scale", () => {
    const t = parseProviderToken({ address: USDC_ADDR, symbol: "X" }, 143);
    // Defaulted to 18 but flagged upstream via metadata cross-check; the value
    // is at least bounded, never NaN.
    expect(Number.isInteger(t!.decimals)).toBe(true);
  });
});

describe("token cost formula (never a fabricated rate)", () => {
  it("mirrors the paymaster formula gas * maxFeePerGas * rate / 1e18", () => {
    const gas = 500_000n;
    const fee = 101_000_000_000n;
    const rate = 27_615n; // observed exchangeRate on Monad
    const expected = (gas * fee * rate) / 10n ** 18n;
    expect(estimateTokenCost(gas, rate, fee)).toBe(expected);
  });

  it("returns 0 (unknown) when the exchange rate is missing", () => {
    expect(estimateTokenCost(500_000n, 0n, 101_000_000_000n)).toBe(0n);
  });

  it("returns 0 when the fee-per-gas is unknown rather than guessing", () => {
    expect(estimateTokenCost(500_000n, 27_615n, 0n)).toBe(0n);
  });

  it("formats base units with the token's decimals", () => {
    expect(formatTokenAmount(1_234_567n, 6)).toBe("1.234567");
    expect(formatTokenAmount(1_000_000n, 6)).toBe("1");
    expect(formatTokenAmount(0n, 6)).toBe("0");
  });

  it("sums the UserOperation gas fields", () => {
    const gas = estimateUserOpGas({
      callGasLimit: "0x186a0",
      verificationGasLimit: "0x186a0",
      preVerificationGas: "0x5208",
      paymasterPostOpGasLimit: "0x907e",
      paymasterVerificationGasLimit: "0x0",
    });
    expect(gas).toBe(100_000n + 100_000n + 21_000n + 36_990n);
  });
});

describe("supported-token normalization", () => {
  it("drops tokens reported for another chain", () => {
    const result: SupportedTokensResult = {
      ok: true,
      at: Date.now(),
      source: "pimlico",
      tokens: [
        { chainId: 1, address: USDC_ADDR, symbol: "USDC", name: "x", decimals: 6 },
        { chainId: 143, address: WMON_ADDR, symbol: "WMON", name: "y", decimals: 18 },
      ],
    };
    const normalized = normalizeSupportedTokens(result, 143);
    expect(normalized.ok).toBe(true);
    expect(normalized.tokens).toHaveLength(1);
    expect(normalized.tokens[0].address).toBe(WMON_ADDR);
  });

  it("never treats a discovery failure as an empty-but-supported list", () => {
    const failed: SupportedTokensResult = { ok: false, reason: "timeout", at: Date.now(), source: "pimlico" };
    const normalized = normalizeSupportedTokens(failed, 143);
    expect(normalized.ok).toBe(false);
    expect(normalized.tokens).toHaveLength(0);
    expect(normalized.reason).toBe("timeout");
  });

  it("flags a local/provier decimals mismatch", () => {
    const result: SupportedTokensResult = {
      ok: true,
      at: Date.now(),
      source: "pimlico",
      tokens: [{ chainId: 143, address: USDC_ADDR, symbol: "USDC", name: "USD Coin", decimals: 18 }],
    };
    const normalized = normalizeSupportedTokens(result, 143);
    expect(normalized.tokens[0].metadataMismatch).toBe(true);
  });

  it("matches by chain+address, never by symbol", () => {
    const normalized = normalizeSupportedTokens(supported([USDC_ADDR]), 143);
    expect(isSupportedGasToken(normalized.tokens, 143, USDC_ADDR)).toBe(true);
    // A spoofed "USDC" at another address is NOT supported.
    expect(isSupportedGasToken(normalized.tokens, 143, RANDOM_ADDR)).toBe(false);
  });

  it("uses the provider decimals for an unknown token rather than inventing a symbol default", () => {
    const normalized = normalizeSupportedTokens(supported([RANDOM_ADDR]), 143);
    const cfg = gasTokenConfig({ ...normalized.tokens[0], decimals: 9 });
    expect(cfg.decimals).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// Deterministic selector
// ---------------------------------------------------------------------------

function cand(over: Partial<GasTokenCandidate> & { address: string }): GasTokenCandidate {
  return {
    chainId: 143,
    symbol: "TOK",
    name: "Tok",
    decimals: 6,
    balance: 0n,
    estimatedCost: 1_000n,
    quoteKnown: true,
    priceKnown: true,
    costUsd: 1,
    stablecoin: false,
    ...over,
  };
}

const SUPPORTED = new Set([candidateKey(143, USDC_ADDR), candidateKey(143, USDT_ADDR)]);

describe("deterministic ERC-20 gas-token selection", () => {
  it("selects the best viable token (lowest USD cost)", () => {
    const res = selectGasPaymentToken({
      supportedKeys: SUPPORTED,
      chainId: 143,
      candidates: [
        cand({ address: USDC_ADDR, symbol: "USDC", balance: 10_000n, costUsd: 0.5, stablecoin: true }),
        cand({ address: USDT_ADDR, symbol: "USDT", balance: 10_000n, costUsd: 0.9, stablecoin: true }),
      ],
      paymasterAvailable: true,
      walletCompatible: true,
    });
    expect(res.code).toBe("auto_best");
    expect(res.selected?.symbol).toBe("USDC");
  });

  it("is deterministic across provider order", () => {
    const a = cand({ address: USDC_ADDR, balance: 10_000n, costUsd: 0.5 });
    const b = cand({ address: USDT_ADDR, balance: 10_000n, costUsd: 0.5 });
    const r1 = selectGasPaymentToken({ supportedKeys: SUPPORTED, chainId: 143, candidates: [a, b], paymasterAvailable: true, walletCompatible: true });
    const r2 = selectGasPaymentToken({ supportedKeys: SUPPORTED, chainId: 143, candidates: [b, a], paymasterAvailable: true, walletCompatible: true });
    expect(r1.selected?.address).toBe(r2.selected?.address);
  });

  it("never selects an unsupported token, even if the wallet holds it", () => {
    const res = selectGasPaymentToken({
      supportedKeys: SUPPORTED,
      chainId: 143,
      candidates: [cand({ address: RANDOM_ADDR, symbol: "NEW", balance: 10_000_000n })],
      paymasterAvailable: true,
      walletCompatible: true,
    });
    expect(res.selected).toBeNull();
    expect(res.code).toBe("token_unsupported");
  });

  it("never selects a supported token the wallet cannot cover", () => {
    const res = selectGasPaymentToken({
      supportedKeys: SUPPORTED,
      chainId: 143,
      candidates: [cand({ address: USDC_ADDR, balance: 10n, estimatedCost: 1_000n })],
      paymasterAvailable: true,
      walletCompatible: true,
    });
    expect(res.selected).toBeNull();
    expect(res.code).toBe("insufficient_balance");
  });

  it("honours an explicit choice when viable and never silently swaps it", () => {
    const res = selectGasPaymentToken({
      supportedKeys: SUPPORTED,
      chainId: 143,
      candidates: [
        cand({ address: USDC_ADDR, symbol: "USDC", balance: 10_000n, costUsd: 0.1 }),
        cand({ address: USDT_ADDR, symbol: "USDT", balance: 10_000n, costUsd: 0.9 }),
      ],
      explicitAddress: USDT_ADDR,
      paymasterAvailable: true,
      walletCompatible: true,
    });
    expect(res.code).toBe("explicit_selected");
    expect(res.selected?.symbol).toBe("USDT");
  });

  it("reports the exact reason when the explicit token is unsupported", () => {
    const res = selectGasPaymentToken({
      supportedKeys: SUPPORTED,
      chainId: 143,
      candidates: [cand({ address: RANDOM_ADDR, balance: 10_000n })],
      explicitAddress: RANDOM_ADDR,
      paymasterAvailable: true,
      walletCompatible: true,
    });
    expect(res.selected).toBeNull();
    expect(res.explicitIssue).toBe("token_unsupported");
  });

  it("falls back to native honestly when the paymaster is unavailable", () => {
    const res = selectGasPaymentToken({
      supportedKeys: new Set(),
      chainId: 143,
      candidates: [],
      paymasterAvailable: false,
      walletCompatible: true,
    });
    expect(res.nativeRequired).toBe(true);
    expect(res.code).toBe("provider_unavailable");
  });

  it("requires a wallet that can deliver an AA transaction", () => {
    const res = selectGasPaymentToken({
      supportedKeys: SUPPORTED,
      chainId: 143,
      candidates: [cand({ address: USDC_ADDR, balance: 10_000n })],
      paymasterAvailable: true,
      walletCompatible: false,
    });
    expect(res.code).toBe("wallet_incompatible");
    expect(res.nativeRequired).toBe(true);
  });

  it("excludes a token the provider cannot quote", () => {
    const res = selectGasPaymentToken({
      supportedKeys: SUPPORTED,
      chainId: 143,
      candidates: [cand({ address: USDC_ADDR, balance: 10_000n, quoteKnown: false })],
      paymasterAvailable: true,
      walletCompatible: true,
    });
    expect(res.selected).toBeNull();
    expect(res.code).toBe("quote_unavailable");
  });

  it("prefers no extra conversion (gas == source) as a tie-breaker", () => {
    const res = selectGasPaymentToken({
      supportedKeys: SUPPORTED,
      chainId: 143,
      candidates: [
        cand({ address: USDC_ADDR, symbol: "USDC", balance: 10_000n, costUsd: 0.5 }),
        cand({ address: USDT_ADDR, symbol: "USDT", balance: 10_000n, costUsd: 0.5 }),
      ],
      sourceSymbol: "USDT",
      paymasterAvailable: true,
      walletCompatible: true,
    });
    expect(res.selected?.symbol).toBe("USDT");
  });

  it("ranks by USD only when both are priceable", () => {
    const ranked = rankViable(
      [
        cand({ address: USDC_ADDR, priceKnown: false, costUsd: undefined }),
        cand({ address: USDT_ADDR, priceKnown: true, costUsd: 99 }),
      ],
      null,
    );
    // price-known wins over an unpriced candidate.
    expect(ranked[0].address).toBe(USDT_ADDR);
  });

  it("isViable requires support + funds + quote", () => {
    expect(isViable(cand({ address: USDC_ADDR, balance: 0n }), SUPPORTED, 143)).toBe(false);
    expect(isViable(cand({ address: USDC_ADDR, balance: 10_000n }), SUPPORTED, 143)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Capability states (honest, never a boolean)
// ---------------------------------------------------------------------------

describe("wallet-abstraction capability states", () => {
  const base = {
    chainId: 143,
    providerId: "pimlico",
    walletCompatible: true,
    account: null,
  };

  it("reports provider_unavailable when no provider is configured", () => {
    const cap = resolveWalletAbstraction({
      ...base,
      providerConfigured: false,
      providerReachable: false,
      selection: { selected: null, viable: [], code: "provider_unavailable", reason: "", nativeRequired: true },
    });
    expect(cap.available).toBe(false);
    expect(cap.mode).toBe("UNAVAILABLE");
    expect(cap.code).toBe("provider_unavailable");
  });

  it("reports provider_error (not unsupported-token) when discovery fails", () => {
    const cap = resolveWalletAbstraction({
      ...base,
      providerConfigured: true,
      providerReachable: false,
      providerError: "timeout",
      selection: { selected: null, viable: [], code: "token_unsupported", reason: "", nativeRequired: true },
    });
    expect(cap.code).toBe("provider_error");
    expect(cap.mode).toBe("UNAVAILABLE");
  });

  it("reports wallet_incompatible distinctly", () => {
    const cap = resolveWalletAbstraction({
      ...base,
      walletCompatible: false,
      providerConfigured: true,
      providerReachable: true,
      selection: { selected: null, viable: [], code: "wallet_incompatible", reason: "", nativeRequired: true },
    });
    expect(cap.code).toBe("wallet_incompatible");
    expect(cap.mode).toBe("NATIVE");
  });

  it("is ACTIVE only with a real selected token", () => {
    const cap = resolveWalletAbstraction({
      ...base,
      providerConfigured: true,
      providerReachable: true,
      selection: {
        selected: cand({ address: USDC_ADDR, symbol: "USDC", balance: 10_000n }),
        viable: [],
        code: "auto_best",
        reason: "Best available gas token: USDC.",
        nativeRequired: false,
      },
    });
    expect(cap.available).toBe(true);
    expect(cap.mode).toBe("ERC20_PAYMASTER");
    expect(cap.reason).toMatch(/USDC/);
  });

  it("distinguishes insufficient_balance from token_unsupported", () => {
    const insufficient = resolveWalletAbstraction({
      ...base,
      providerConfigured: true,
      providerReachable: true,
      selection: { selected: null, viable: [], code: "insufficient_balance", reason: "low", nativeRequired: true },
    });
    expect(insufficient.code).toBe("insufficient_balance");
    const unsupported = resolveWalletAbstraction({
      ...base,
      providerConfigured: true,
      providerReachable: true,
      selection: { selected: null, viable: [], code: "token_unsupported", reason: "no", nativeRequired: true },
    });
    expect(unsupported.code).toBe("token_unsupported");
  });

  it("never claims per-token support from existence alone", () => {
    const notHeld = gasPaymentForToken(
      { symbol: "X", held: false, sufficientBalance: false, quoteKnown: false, estimatedFee: null, estimatedFeeUsd: null },
      true,
    );
    expect(notHeld.supported).toBe(true);
    expect(notHeld.sufficientBalance).toBe(false);
    expect(notHeld.reason).toMatch(/don't hold/);
  });
});

// ---------------------------------------------------------------------------
// Bounded spend (a paymaster must never be able to drain a wallet)
// ---------------------------------------------------------------------------

describe("bounded ERC-20 gas spend", () => {
  it("bounds the max spend to the estimate + buffer", () => {
    const res = boundGasSpend({ estimatedCost: 1_000n, balance: 1_000_000n });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.maxSpend).toBe(withGasBuffer(1_000n));
  });

  it("never allows an unlimited approval", () => {
    expect(isSafeSpend(2n ** 256n - 1n, 10n ** 30n, 1_000n)).toBe(false);
  });

  it("refuses when the balance cannot cover the estimate", () => {
    const res = boundGasSpend({ estimatedCost: 1_000n, balance: 500n });
    expect(res.ok).toBe(false);
  });

  it("refuses when the estimate would exceed half the balance (fails closed)", () => {
    const balance = 1_000_000n;
    const res = boundGasSpend({ estimatedCost: 900_000n, balance });
    // Capping to half the balance would fall below the estimate, so we refuse
    // rather than approve a spend the wallet may not be able to sustain.
    expect(res.ok).toBe(false);
  });

  it("caps a large-but-safe estimate at the buffered value, below half the balance", () => {
    const balance = 10_000_000n;
    const res = boundGasSpend({ estimatedCost: 1_000_000n, balance });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.maxSpend).toBeLessThanOrEqual(balance / 2n);
      expect(res.maxSpend).toBeGreaterThanOrEqual(1_000_000n);
    }
  });

  it("never exceeds the wallet balance", () => {
    expect(isSafeSpend(1_000n, 999n, 500n)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// UserOperation field allow-list (Pimlico rejects unknown keys)
// ---------------------------------------------------------------------------
import { filterUserOperation, USER_OPERATION_KEYS } from "@/lib/aa/userOp";

describe("filterUserOperation", () => {
  it("drops viem's transport-only keys (the live 'Unrecognized keys' failure)", () => {
    const bag = {
      chainId: 143,
      entryPointAddress: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
      context: { token: USDC_ADDR },
      sender: "0x1111111111111111111111111111111111111111",
      nonce: "0x0",
      callData: "0x",
      callGasLimit: "0x186a0",
    };
    const filtered = filterUserOperation(bag);
    expect(filtered).not.toHaveProperty("chainId");
    expect(filtered).not.toHaveProperty("entryPointAddress");
    expect(filtered).not.toHaveProperty("context");
    expect(filtered.sender).toBe(bag.sender);
    expect(filtered.callData).toBe("0x");
  });

  it("keeps every real UserOperation field", () => {
    const bag: Record<string, unknown> = {};
    for (const k of USER_OPERATION_KEYS) bag[k] = "0x1";
    expect(Object.keys(filterUserOperation(bag)).sort()).toEqual([...USER_OPERATION_KEYS].sort());
  });

  it("never forwards a client-invented key", () => {
    const filtered = filterUserOperation({ sender: "0x1", evil: "0xdeadbeef", paymasterData: "0x" });
    expect(filtered).not.toHaveProperty("evil");
    expect(filtered.paymasterData).toBe("0x");
  });
});

// ---------------------------------------------------------------------------
// Bounded ERC-20 paymaster allowance (approve the paymaster, never unlimited)
// ---------------------------------------------------------------------------
import { maxCostInToken } from "@/lib/aa/gasCost";
import { planGasApproval, type GasPaymasterQuote } from "@/lib/aa/gasApproval";

const PAYMASTER = "0x888888888888Ec68A58AB8094Cc1AD20Ba3D2402" as const;
const UNLIMITED = 2n ** 256n - 1n;

const baseQuote = (over: Partial<GasPaymasterQuote> = {}): GasPaymasterQuote => ({
  paymaster: PAYMASTER,
  token: { address: USDC_ADDR, symbol: "USDC", decimals: 6 },
  exchangeRate: 27_615n, // ~USDC per native, scaled 1e18 (real shape)
  postOpGas: 37_000n,
  ...over,
});

const userOp = {
  callGasLimit: 900_000n,
  verificationGasLimit: 900_000n,
  preVerificationGas: 120_000n,
  paymasterVerificationGasLimit: 120_000n,
  paymasterPostOpGasLimit: 37_000n,
  maxFeePerGas: 100_000_000_000n,
};

describe("maxCostInToken", () => {
  it("matches Pimlico's published formula", () => {
    const gas = 1_000_000n + 37_000n;
    const fee = 100_000_000_000n;
    const rate = 27_615n;
    expect(maxCostInToken({ userOperationMaxGas: 1_000_000n, postOpGas: 37_000n, maxFeePerGas: fee, exchangeRate: rate }))
      .toBe((gas * fee * rate) / 10n ** 18n);
  });

  it("includes postOpGas (omitting it under-approves and postOp reverts)", () => {
    const withPost = maxCostInToken({ userOperationMaxGas: 1_000_000n, postOpGas: 50_000n, maxFeePerGas: 10n ** 11n, exchangeRate: 30_000n });
    const without = maxCostInToken({ userOperationMaxGas: 1_000_000n, postOpGas: 0n, maxFeePerGas: 10n ** 11n, exchangeRate: 30_000n });
    expect(withPost).toBeGreaterThan(without);
  });
});

describe("planGasApproval", () => {
  it("approves the paymaster for a bounded amount derived from the live quote", () => {
    const balance = 5_000_000n; // 5 USDC
    const plan = planGasApproval({ userOperation: userOp, quote: baseQuote(), gasTokenBalance: balance });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    // Spender is the paymaster, target is the gas token.
    expect(plan.call.to.toLowerCase()).toBe(USDC_ADDR.toLowerCase());
    expect(plan.call.data!.startsWith("0x095ea7b3")).toBe(true);
    expect(plan.call.data!.toLowerCase()).toContain(PAYMASTER.toLowerCase().slice(2));
    // Bounded: never unlimited, never above half the balance.
    expect(plan.amount).toBeLessThan(UNLIMITED);
    expect(plan.amount).toBeLessThanOrEqual(balance / 2n);
    expect(plan.amount).toBeGreaterThan(0n);
  });

  it("is the minimum bounded amount (estimate + buffer, capped by balance)", () => {
    const balance = 5_000_000n;
    const plan = planGasApproval({ userOperation: userOp, quote: baseQuote(), gasTokenBalance: balance });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const required = maxCostInToken({
      userOperationMaxGas:
        userOp.callGasLimit + userOp.verificationGasLimit + userOp.preVerificationGas +
        userOp.paymasterVerificationGasLimit + userOp.paymasterPostOpGasLimit,
      postOpGas: 37_000n,
      maxFeePerGas: userOp.maxFeePerGas,
      exchangeRate: 27_615n,
    });
    const expectedBound = boundGasSpend({ estimatedCost: required, balance });
    expect(expectedBound.ok).toBe(true);
    if (!expectedBound.ok) return;
    expect(plan.amount).toBe(expectedBound.maxSpend);
    expect(plan.amount).toBeGreaterThanOrEqual(required);
  });

  it("fails closed when the quote has no exchange rate", () => {
    const plan = planGasApproval({ userOperation: userOp, quote: baseQuote({ exchangeRate: 0n }), gasTokenBalance: 5_000_000n });
    expect(plan.ok).toBe(false);
  });

  it("fails closed when the balance cannot cover the bounded spend", () => {
    const plan = planGasApproval({ userOperation: userOp, quote: baseQuote(), gasTokenBalance: 1n });
    expect(plan.ok).toBe(false);
  });

  it("never proposes an unlimited approval", () => {
    const plan = planGasApproval({ userOperation: userOp, quote: baseQuote(), gasTokenBalance: 10n ** 18n });
    if (plan.ok) {
      expect(isSafeSpend(plan.amount, 10n ** 18n, 1n)).toBe(true);
      expect(plan.amount).not.toBe(UNLIMITED);
    }
  });

  it("honours an operator ceiling below the buffer", () => {
    const balance = 5_000_000n;
    const required = maxCostInToken({ userOperationMaxGas: 2_077_000n, postOpGas: 37_000n, maxFeePerGas: userOp.maxFeePerGas, exchangeRate: 27_615n });
    const ceiling = withGasBuffer(required);
    const plan = planGasApproval({ userOperation: userOp, quote: baseQuote(), gasTokenBalance: balance, configuredMax: ceiling });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.amount).toBeLessThanOrEqual(ceiling);
  });
});
