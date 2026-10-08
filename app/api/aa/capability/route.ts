import { NextResponse } from "next/server";
import type { Address } from "viem";
import { isEvmAddress } from "@/lib/format";
import { gasPaymentForToken, resolveWalletAbstraction, type SupportedGasTokenView } from "@/lib/aa/capability";
import { formatTokenAmount } from "@/lib/server/paymaster/pimlico";
import { gasTokenConfig } from "@/lib/server/paymaster/capabilities";
import { resolveGasCapability, DEFAULT_USEROP_GAS } from "@/lib/server/paymaster/selector";
import type { MonadNetwork } from "@/lib/config/chains";

export const dynamic = "force-dynamic";

/**
 * GET /api/aa/capability — per-wallet ERC-20 gas capability.
 *
 * Combines the provider's supported set (authoritative) with the wallet's
 * on-chain balances (authoritative) and a live fee quote, then resolves one
 * honest capability: which token will pay gas, or exactly why none can.
 *
 * Query:
 *   owner     — the connected account (optional; omit for provider-only view)
 *   gasToken  — an explicit user choice (optional)
 *   source    — the payment's source asset symbol (tie-breaker)
 *   gasUnits  — an estimated UserOperation gas (optional)
 *   chainId   — must equal the configured chain
 *
 * `walletCompatible` is supplied by the client (it knows what the wallet
 * advertised); it defaults to true so a direct probe is not blocked.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const network: MonadNetwork = "mainnet";
  const ownerRaw = url.searchParams.get("owner") ?? undefined;
  const owner = ownerRaw && isEvmAddress(ownerRaw) ? (ownerRaw as Address) : undefined;
  const gasToken = url.searchParams.get("gasToken") ?? null;
  const source = url.searchParams.get("source") ?? null;
  const gasUnitsRaw = url.searchParams.get("gasUnits");
  const gasUnits = gasUnitsRaw ? BigInt(gasUnitsRaw) : DEFAULT_USEROP_GAS;
  const walletCompatible = url.searchParams.get("walletCompatible") !== "0";
  const reqChain = url.searchParams.get("chainId");
  if (reqChain && Number(reqChain) !== 143) {
    return NextResponse.json({ ok: false, message: "Only Monad mainnet (143) is supported." }, { status: 400 });
  }

  const { resolved, selection } = await resolveGasCapability({
    network,
    owner,
    gasUnits,
    explicitGasToken: gasToken,
    sourceSymbol: source,
  });

  // Build the per-token views the capability model and the API expose.
  const supportedViews: SupportedGasTokenView[] = resolved.quotes.map((q) => {
    const config = gasTokenConfig(q.token);
    const held = (resolved.candidates.find((c) => c.address.toLowerCase() === q.token.address.toLowerCase())?.balance ?? 0n) > 0n;
    const balance = resolved.candidates.find((c) => c.address.toLowerCase() === q.token.address.toLowerCase())?.balance ?? 0n;
    const sufficient =
      q.quoteKnown && q.estimatedCost !== null && balance >= q.estimatedCost;
    return {
      chainId: q.token.chainId,
      address: q.token.address,
      symbol: config.symbol,
      name: config.name,
      decimals: q.token.decimals,
      held,
      balance: formatTokenAmount(balance, q.token.decimals),
      sufficientBalance: sufficient,
      quoteKnown: q.quoteKnown,
      estimatedFee: q.estimatedCostDecimal,
      estimatedFeeUsd: q.estimatedCostUsd,
      selected: Boolean(selection.selected && selection.selected.address.toLowerCase() === q.token.address.toLowerCase()),
    };
  });

  const capability = resolveWalletAbstraction({
    chainId: resolved.chainId,
    providerConfigured: resolved.providerConfigured,
    providerReachable: resolved.providerReachable,
    providerError: resolved.providerError,
    providerId: resolved.providerId,
    walletCompatible,
    account: owner ?? null,
    selection,
    supportedGasTokens: supportedViews,
  });

  // Per-token `gasPayment` (section 14): never claim support from existence.
  const gasPayment = supportedViews.map((v) => ({
    address: v.address,
    symbol: v.symbol,
    decimals: v.decimals,
    ...gasPaymentForToken(
      {
        symbol: v.symbol,
        held: v.held,
        sufficientBalance: v.sufficientBalance,
        quoteKnown: v.quoteKnown,
        estimatedFee: v.estimatedFee,
        estimatedFeeUsd: v.estimatedFeeUsd,
      },
      true,
    ),
  }));

  return NextResponse.json({
    ok: true,
    chainId: resolved.chainId,
    walletAbstraction: capability,
    gasPayment,
    provider: {
      id: resolved.providerId,
      configured: resolved.providerConfigured,
      reachable: resolved.providerReachable,
      error: resolved.providerError,
    },
    supportedGasTokens: supportedViews,
    selection: {
      code: selection.code,
      reason: selection.reason,
      nativeRequired: selection.nativeRequired,
      explicitIssue: selection.explicitIssue ?? null,
      selected: selection.selected
        ? { address: selection.selected.address, symbol: selection.selected.symbol, decimals: selection.selected.decimals }
        : null,
    },
  });
}
