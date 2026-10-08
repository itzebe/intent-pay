import type { Address } from "viem";
import { getPublicClient } from "@/lib/server/rpc";
import { getRoutingProvider } from "@/lib/providers";
import { ERC20_ABI } from "@/lib/execution/abis";
import type { MonadNetwork } from "@/lib/config/chains";
import { getPaymasterProvider, paymasterChainId } from "./index";
import { gasTokenConfig, normalizeSupportedTokens, type NormalizedGasToken } from "./capabilities";
import { estimateTokenCost, formatTokenAmount } from "./pimlico";
import type { PaymasterProvider } from "./types";
import { selectGasPaymentToken, type GasTokenCandidate } from "@/lib/aa/gasToken";

/**
 * Server-side gas-token resolution for the capability/quote surface.
 *
 * This is the *only* place balances, the provider's supported set and the live
 * price quote are combined. It produces:
 *   - the per-token status the UI needs (supported / held / sufficient / quoted),
 *   - a deterministic selection (best token, or the precise reason none applies).
 *
 * Balances are read on-chain (authoritative), never from an enrichment API. The
 * supported set comes from the provider, never from a local list.
 */

/** Conservative representative UserOperation gas when no estimate is supplied. */
export const DEFAULT_USEROP_GAS = 500_000n;

export type GasTokenQuote = {
  token: NormalizedGasToken;
  /** The token amount estimated for gas, base units (null when unknown). */
  estimatedCost: bigint | null;
  estimatedCostDecimal: string | null;
  estimatedCostUsd: string | null;
  priceKnown: boolean;
  quoteKnown: boolean;
  stablecoin: boolean;
};

export type ResolvedGasCapability = {
  chainId: number;
  providerConfigured: boolean;
  providerReachable: boolean;
  providerId: string | null;
  providerError: string | null;
  supportedTokens: NormalizedGasToken[];
  quotes: GasTokenQuote[];
  candidates: GasTokenCandidate[];
};

const STABLE_SYMBOLS = new Set(["USDC", "USDT", "DAI", "AUSD", "USDG"]);

/** Read a set of ERC-20 balances in one multicall. Never throws. */
export async function readGasTokenBalances(
  network: MonadNetwork,
  owner: Address | undefined,
  tokens: NormalizedGasToken[],
): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  if (!owner || tokens.length === 0) return out;
  const client = getPublicClient(network);
  try {
    const results = await client.multicall({
      contracts: tokens.map((t) => ({
        address: t.address,
        abi: ERC20_ABI,
        functionName: "balanceOf" as const,
        args: [owner] as const,
      })),
      allowFailure: true,
    });
    tokens.forEach((t, i) => {
      const r = results[i];
      const value = r?.status === "success" ? (r.result as bigint) : 0n;
      out.set(t.address.toLowerCase(), value);
    });
  } catch {
    /* leave empty — unknown is handled honestly downstream */
  }
  return out;
}

/** Current fee-per-gas from the provider, or a sane default. */
export async function readGasPriceWei(
  provider: PaymasterProvider | null,
  chainId: number,
): Promise<bigint> {
  const FALLBACK = 101_000_000_000n;
  if (!provider) return FALLBACK;
  try {
    const key = process.env.PIMLICO_API_KEY;
    if (!key) return FALLBACK;
    const { pimlicoRpc } = await import("./pimlico");
    const res = (await pimlicoRpc(key, chainId, "pimlico_getUserOperationGasPrice", [])) as
      | { standard?: { maxFeePerGas?: string } }
      | undefined;
    const v = res?.standard?.maxFeePerGas;
    if (typeof v === "string" && v.startsWith("0x")) return BigInt(v);
    if (typeof v === "string" && v) return BigInt(v);
  } catch {
    /* fall through */
  }
  return FALLBACK;
}

/**
 * Resolve the full gas capability: provider discovery, balances, quotes and the
 * deterministic selection. Fails closed on any provider problem.
 */
export async function resolveGasCapability(input: {
  network: MonadNetwork;
  owner?: Address;
  gasUnits?: bigint;
  explicitGasToken?: string | null;
  sourceSymbol?: string | null;
}): Promise<{
  resolved: ResolvedGasCapability;
  selection: ReturnType<typeof selectGasPaymentToken>;
}> {
  const network = input.network;
  const chainId = paymasterChainId();
  const provider = getPaymasterProvider();
  const configured = Boolean(provider && provider.configured());

  if (!provider || !configured) {
    return {
      resolved: {
        chainId,
        providerConfigured: false,
        providerReachable: false,
        providerId: provider?.id ?? null,
        providerError: "PIMLICO_API_KEY is not set",
        supportedTokens: [],
        quotes: [],
        candidates: [],
      },
      selection: selectGasPaymentToken({
        supportedKeys: new Set(),
        chainId,
        candidates: [],
        explicitAddress: input.explicitGasToken ?? null,
        sourceSymbol: input.sourceSymbol ?? null,
        paymasterAvailable: false,
        walletCompatible: true,
      }),
    };
  }

  const health = await provider.reachable(chainId);
  const discovery = await provider.supportedTokens(chainId);
  const normalized = normalizeSupportedTokens(discovery, chainId);

  // Discovery failed → no token may be claimed.
  if (!normalized.ok || !health.reachable) {
    return {
      resolved: {
        chainId,
        providerConfigured: true,
        providerReachable: false,
        providerId: provider.id,
        providerError: normalized.reason ?? health.error ?? "Paymaster unreachable",
        supportedTokens: [],
        quotes: [],
        candidates: [],
      },
      selection: selectGasPaymentToken({
        supportedKeys: new Set(),
        chainId,
        candidates: [],
        explicitAddress: input.explicitGasToken ?? null,
        sourceSymbol: input.sourceSymbol ?? null,
        paymasterAvailable: true,
        walletCompatible: true,
      }),
    };
  }

  const tokens = normalized.tokens;
  const gasUnits = input.gasUnits && input.gasUnits > 0n ? input.gasUnits : DEFAULT_USEROP_GAS;
  const [balances, gasPriceWei] = await Promise.all([
    readGasTokenBalances(network, input.owner, tokens),
    readGasPriceWei(provider, chainId),
  ]);

  const routing = getRoutingProvider(network);
  const quotes: GasTokenQuote[] = [];
  const candidates: GasTokenCandidate[] = [];

  for (const t of tokens) {
    const config = gasTokenConfig(t);
    // Exchange rate + postOp gas from the provider; never invented.
    let exchangeRate = 0n;
    let postOpGas = 0n;
    let quoteKnown = false;
    try {
      const key = process.env.PIMLICO_API_KEY!;
      const { pimlicoRpc } = await import("./pimlico");
      const q = (await pimlicoRpc(key, chainId, "pimlico_getTokenQuotes", [
        { tokens: [t.address] },
        "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
        chainId,
      ])) as { quotes?: Record<string, unknown>[] } | undefined;
      const first = q?.quotes?.[0];
      if (first) {
        exchangeRate = parseQty(first.exchangeRate);
        postOpGas = parseQty(first.postOpGas);
        quoteKnown = exchangeRate > 0n;
      }
    } catch {
      quoteKnown = false;
    }

    const totalGas = gasUnits + postOpGas;
    const cost = quoteKnown ? estimateTokenCost(totalGas, exchangeRate, gasPriceWei) : 0n;

    let priceKnown = false;
    let priceUsd = 0;
    try {
      const p = await routing.priceUsd(config, network);
      priceKnown = p.usd > 0;
      priceUsd = p.usd;
    } catch {
      priceKnown = false;
    }

    const costUsd = cost > 0n && priceKnown ? Number(cost) / 10 ** config.decimals * priceUsd : undefined;

    quotes.push({
      token: t,
      estimatedCost: quoteKnown ? cost : null,
      estimatedCostDecimal: quoteKnown ? formatTokenAmount(cost, t.decimals) : null,
      estimatedCostUsd: costUsd !== undefined ? costUsd.toFixed(6) : null,
      priceKnown,
      quoteKnown,
      stablecoin: STABLE_SYMBOLS.has(t.symbol.toUpperCase()),
    });

    candidates.push({
      chainId: t.chainId,
      address: t.address,
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
      estimatedCost: cost,
      balance: balances.get(t.address.toLowerCase()) ?? 0n,
      quoteKnown,
      priceKnown,
      costUsd,
      stablecoin: STABLE_SYMBOLS.has(t.symbol.toUpperCase()),
    });
  }

  const selection = selectGasPaymentToken({
    supportedKeys: new Set(tokens.map((t) => `${t.chainId}:${t.address.toLowerCase()}`)),
    chainId,
    candidates,
    explicitAddress: input.explicitGasToken ?? null,
    sourceSymbol: input.sourceSymbol ?? null,
    paymasterAvailable: true,
    // Wallet compatibility is a client-side fact; the route resolves the
    // provider side and the caller ANDs it with the wallet probe.
    walletCompatible: true,
  });

  return {
    resolved: {
      chainId,
      providerConfigured: true,
      providerReachable: true,
      providerId: provider.id,
      providerError: null,
      supportedTokens: tokens,
      quotes,
      candidates,
    },
    selection,
  };
}

function parseQty(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (typeof value === "string" && value.trim()) {
    return value.trim().startsWith("0x") ? BigInt(value.trim()) : BigInt(value.trim());
  }
  return 0n;
}
