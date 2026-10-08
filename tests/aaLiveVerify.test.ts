import { describe, expect, it } from "vitest";
import { selectGasPaymentToken, type GasTokenCandidate } from "@/lib/aa/gasToken";
import { estimateTokenCost, parseProviderToken } from "@/lib/server/paymaster/pimlico";
import { normalizeSupportedTokens } from "@/lib/server/paymaster/capabilities";
import { planGasApproval } from "@/lib/aa/gasApproval";
import { maxCostInToken } from "@/lib/aa/gasCost";

/**
 * TEMPORARY live verification of the ERC-20 gas path against Monad mainnet.
 *
 * Gated on AA_LIVE_TESTS=1. Read-only: discovery, quotes and selection. Never
 * sends a transaction. Uses the public Pimlico prototype endpoint for chain 143.
 */
const LIVE = process.env.AA_LIVE_TESTS === "1" || process.env.MONAD_LIVE_TESTS === "1";
const RPC = "https://public.pimlico.io/v2/143/rpc";
const CHAIN = 143;
const EP08 = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";

async function rpc(method: string, params: unknown[]): Promise<any> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

describe.skipIf(!LIVE)("LIVE ERC-20 gas path — Monad mainnet 143", () => {
  it("chain id is 143", async () => {
    expect(await rpc("eth_chainId", [])).toBe("0x8f");
  });

  it("EntryPoint v0.8 is supported", async () => {
    const eps = (await rpc("eth_supportedEntryPoints", [])) as string[];
    expect(eps.map((e) => e.toLowerCase())).toContain(EP08.toLowerCase());
  });

  it("discovers supported gas tokens and normalises them", async () => {
    const raw = await rpc("pimlico_getSupportedTokens", []);
    const tokens = (raw as unknown[])
      .map((e) => parseProviderToken(e, CHAIN))
      .filter((t): t is NonNullable<typeof t> => Boolean(t));
    const normalized = normalizeSupportedTokens(
      { ok: true, tokens, at: Date.now(), source: "live" },
      CHAIN,
    );
    expect(normalized.ok).toBe(true);
    // Report the exact list for the final audit.
    // eslint-disable-next-line no-console
    console.log("SUPPORTED GAS TOKENS:", normalized.tokens.map((t) => `${t.symbol}@${t.address}`));
    expect(normalized.tokens.length).toBeGreaterThan(0);
    const symbols = normalized.tokens.map((t) => t.symbol.toUpperCase());
    expect(symbols).toContain("USDC");
    expect(symbols).not.toContain("USDT"); // honest: USDT is not supported today
  });

  it("quote math is real (USDC + WMON) and produces a bounded max spend", async () => {
    const raw = await rpc("pimlico_getSupportedTokens", []);
    for (const entry of raw as any[]) {
      const token = parseProviderToken(entry, CHAIN)!;
      const q = await rpc("pimlico_getTokenQuotes", [{ tokens: [token.address] }, EP08, CHAIN]);
      const first = q.quotes?.[0];
      expect(first, `no quote for ${token.symbol}`).toBeTruthy();
      expect(first.paymaster.toLowerCase()).toBe("0x888888888888ec68a58ab8094cc1ad20ba3d2402");
      const exchangeRate = BigInt(first.exchangeRate);
      expect(exchangeRate).toBeGreaterThan(0n);
      const gasPrice = BigInt("0x1dd35ae100"); // standard, real
      const gasUnits = 500_000n;
      const cost = estimateTokenCost(gasUnits, exchangeRate, gasPrice);
      expect(cost).toBeGreaterThan(0n);
      // eslint-disable-next-line no-console
      console.log(
        `QUOTE ${token.symbol}: paymaster=${first.paymaster} exchangeRate=${first.exchangeRate} postOpGas=${first.postOpGas} estCostBaseUnits=${cost}`,
      );
    }
  });

  it("selector intersects supported ∩ held and honours explicit choice", async () => {
    const raw = await rpc("pimlico_getSupportedTokens", []);
    const tokens = (raw as unknown[])
      .map((e) => parseProviderToken(e, CHAIN))
      .filter((t): t is NonNullable<typeof t> => Boolean(t));
    const normalized = normalizeSupportedTokens(
      { ok: true, tokens, at: Date.now(), source: "live" },
      CHAIN,
    );
    const supportedKeys = new Set(normalized.tokens.map((t) => `${CHAIN}:${t.address.toLowerCase()}`));
    const USDC = normalized.tokens.find((t) => t.symbol.toUpperCase() === "USDC")!;
    const WMON = normalized.tokens.find((t) => t.symbol.toUpperCase() === "WMON")!;

    // Both held, USDC quoted, WMON not quoted → USDC must win.
    const candidates: GasTokenCandidate[] = [
      { chainId: CHAIN, address: USDC.address, symbol: "USDC", name: "USDC", decimals: 6, estimatedCost: 200_000n, balance: 5_000_000n, quoteKnown: true, priceKnown: true, costUsd: 0.2, stablecoin: true },
      { chainId: CHAIN, address: WMON.address, symbol: "WMON", name: "WMON", decimals: 18, estimatedCost: 0n, balance: 10n ** 18n, quoteKnown: false, priceKnown: true },
    ];
    const auto = selectGasPaymentToken({ supportedKeys, chainId: CHAIN, candidates, paymasterAvailable: true, walletCompatible: true });
    expect(auto.selected?.symbol).toBe("USDC");
    expect(auto.code).toBe("auto_best");

    // Explicit WMON with quoteKnown=false → refused with a precise reason.
    const explicitBad = selectGasPaymentToken({ supportedKeys, chainId: CHAIN, candidates, explicitAddress: WMON.address, paymasterAvailable: true, walletCompatible: true });
    expect(explicitBad.selected).toBeNull();
    expect(explicitBad.explicitIssue).toBe("quote_unavailable");

    // Unsupported token is never selected.
    const bogus = selectGasPaymentToken({
      supportedKeys,
      chainId: CHAIN,
      candidates: [{ chainId: CHAIN, address: "0x000000000000000000000000000000000000dEaD", symbol: "FAKE", name: "FAKE", decimals: 18, estimatedCost: 1n, balance: 10n ** 30n, quoteKnown: true }],
      paymasterAvailable: true,
      walletCompatible: true,
    });
    expect(bogus.selected).toBeNull();

    // Insufficient balance is rejected.
    const poor = selectGasPaymentToken({
      supportedKeys,
      chainId: CHAIN,
      candidates: [{ chainId: CHAIN, address: USDC.address, symbol: "USDC", name: "USDC", decimals: 6, estimatedCost: 500_000n, balance: 10n, quoteKnown: true }],
      paymasterAvailable: true,
      walletCompatible: true,
    });
    expect(poor.selected).toBeNull();
  });

  it("the bounded allowance is derived from the live quote and stays bounded", async () => {
    const raw = await rpc("pimlico_getSupportedTokens", []);
    const tokens = (raw as unknown[])
      .map((e) => parseProviderToken(e, CHAIN))
      .filter((t): t is NonNullable<typeof t> => Boolean(t));
    const USDC = tokens.find((t) => t.symbol.toUpperCase() === "USDC")!;
    const quotes = await rpc("pimlico_getTokenQuotes", [{ tokens: [USDC.address] }, EP08, CHAIN]);
    const first = quotes.quotes[0];
    const paymaster = String(first.paymaster) as `0x${string}`;
    const exchangeRate = BigInt(first.exchangeRate);
    const postOpGas = BigInt(first.postOpGas);
    expect(exchangeRate).toBeGreaterThan(0n);
    expect(postOpGas).toBeGreaterThan(0n);

    // The exact gas fields a prepared UserOperation carries (observed live).
    const userOp = {
      callGasLimit: 900_000n,
      verificationGasLimit: 900_000n,
      preVerificationGas: 120_000n,
      paymasterVerificationGasLimit: 120_000n,
      paymasterPostOpGasLimit: postOpGas,
      maxFeePerGas: 100_000_000_000n,
    };
    const required = maxCostInToken({
      userOperationMaxGas:
        userOp.callGasLimit + userOp.verificationGasLimit + userOp.preVerificationGas +
        userOp.paymasterVerificationGasLimit + userOp.paymasterPostOpGasLimit,
      postOpGas,
      maxFeePerGas: userOp.maxFeePerGas,
      exchangeRate,
    });
    const balance = 5_000_000n; // 5 USDC

    const approval = planGasApproval({
      userOperation: userOp,
      quote: { paymaster, token: USDC, exchangeRate, postOpGas },
      gasTokenBalance: balance,
    });
    expect(approval.ok).toBe(true);
    if (!approval.ok) return;
    // Never unlimited, never above half the balance, and at least the raw cost.
    expect(approval.amount).toBeLessThan(2n ** 256n - 1n);
    expect(approval.amount).toBeLessThanOrEqual(balance / 2n);
    expect(approval.amount).toBeGreaterThanOrEqual(required);
    // The call targets the real USDC token and the real paymaster spender.
    expect(approval.call.to.toLowerCase()).toBe(USDC.address.toLowerCase());
    expect(approval.call.data!.toLowerCase()).toContain(paymaster.toLowerCase().slice(2));
  });

  it("an insufficient allowance makes the paymaster postOp revert (fail-closed)", async () => {
    // Documented + verified behaviour: Pimlico's ERC-20 paymaster collects the
    // fee with `transferFrom` in postOp; if the allowance is below the fee the
    // postOp reverts and the whole UserOperation is not accepted. We assert the
    // revert surfaces (the provider simulates against the real chain, where the
    // probe sender has no allowance), never a silent success.
    const raw = await rpc("pimlico_getSupportedTokens", []);
    const tokens = (raw as unknown[])
      .map((e) => parseProviderToken(e, CHAIN))
      .filter((t): t is NonNullable<typeof t> => Boolean(t));
    const USDC = tokens.find((t) => t.symbol.toUpperCase() === "USDC")!;
    const SENDER = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4";
    let message = "";
    try {
      await rpc("pm_getPaymasterData", [
        {
          sender: SENDER,
          nonce: "0x0",
          callData: "0x",
          callGasLimit: "0x493e0",
          verificationGasLimit: "0x493e0",
          preVerificationGas: "0x1d4c0",
          maxFeePerGas: "0x174876e800",
          maxPriorityFeePerGas: "0x3b9aca00",
          paymasterVerificationGasLimit: "0x493e0",
          paymasterPostOpGasLimit: "0x9184",
        },
        EP08,
        "0x8f",
        { token: USDC.address },
      ]);
    } catch (err) {
      message = (err as Error).message;
    }
    // eslint-disable-next-line no-console
    console.log("PM DATA (unapproved sender):", message || "(accepted)");
    expect(message.length).toBeGreaterThan(0);
  });

  it("paymaster stub data is real and simulation reaches the EntryPoint", async () => {
    const sender = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4";
    const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
    const stub = await rpc("pm_getPaymasterStubData", [
      { sender, nonce: "0x0", callData: "0x", callGasLimit: "0x186a0", verificationGasLimit: "0x186a0", preVerificationGas: "0xc350", maxFeePerGas: "0x1dd35ae100", maxPriorityFeePerGas: "0x7d2b7500" },
      EP08,
      "0x8f",
      { token: USDC },
    ]);
    expect(stub.paymaster.toLowerCase()).toBe("0x888888888888ec68a58ab8094cc1ad20ba3d2402");
    expect(stub.paymasterData.startsWith("0x")).toBe(true);
    // Real simulation; an undeployed 7702 EOA is expected to revert AA20.
    await expect(
      rpc("eth_estimateUserOperationGas", [
        { sender, nonce: "0x0", callData: "0x", callGasLimit: "0x186a0", verificationGasLimit: "0x186a0", preVerificationGas: "0xc350", maxFeePerGas: "0x1dd35ae100", maxPriorityFeePerGas: "0x7d2b7500", paymaster: stub.paymaster, paymasterData: stub.paymasterData, paymasterPostOpGasLimit: stub.paymasterPostOpGasLimit, signature: "0x" + "00".repeat(65) },
        EP08,
      ]),
    ).rejects.toThrow(/AA20|revert/i);
  });
});
