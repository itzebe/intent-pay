import type { Address } from "viem";
import type { MonadNetwork } from "@/lib/config/chains";
import { registerToken, tintForAddress, type TokenConfig } from "@/lib/config/tokens";
import { isEvmAddress } from "@/lib/format";
import { fetchWithTimeout, TtlCache } from "@/lib/server/http";

/**
 * Zerion wallet intelligence.
 *
 * Real integration against https://api.zerion.io (HTTP Basic Auth: API key as
 * username, empty password). Zerion supports Monad mainnet, and its positions
 * endpoint returns a wallet's fungible holdings *with metadata and USD
 * valuation* — exactly the "what does this wallet actually own?" question
 * Intent Pay needs.
 *
 * Scope is deliberately narrow: Zerion improves *discovery and intelligence*.
 * It never decides execution. Balances that will actually be spent are
 * confirmed against Monad on-chain data (see discovery.discoverWalletBalances),
 * because an indexed third party can lag the chain.
 */

const TTL_MS = 30 * 1000;

/**
 * Provider outcome. `error` means Zerion was configured and reachable in
 * principle but the request failed — the caller must NOT interpret that as
 * "this wallet holds nothing".
 */
export type ZerionStatus = "ok" | "disabled" | "error";

export type ZerionResult = {
  assets: ZerionAsset[];
  status: ZerionStatus;
  /** Why it failed, when status is "error". */
  reason?: string;
};

const cache = new TtlCache<string, ZerionResult>(TTL_MS);

export type ZerionAsset = {
  symbol: string;
  name: string;
  address: Address;
  decimals: number;
  /** Decimal string amount held. */
  amount: string;
  /** USD value as reported by Zerion (may be 0 when unpriced). */
  usd: number;
  /** Zerion's price for the token, when provided. */
  priceUsd: number | null;
  /** Zerion's verified flag, surfaced as intelligence (never as "trusted"). */
  verified: boolean;
  logoURI?: string;
};

type Position = {
  attributes?: {
    quantity?: { numeric?: string; float?: number; decimals?: number };
    value?: number | null;
    price?: number | null;
    fungible_info?: {
      symbol?: string;
      name?: string;
      icon?: { url?: string };
      flags?: { verified?: boolean };
      implementations?: {
        chain_id?: string;
        address?: string;
        decimals?: number;
      }[];
    };
  };
  relationships?: { chain?: { data?: { id?: string } } };
};

type PositionsResponse = { data?: Position[] };

/** Zerion chain slug for Monad mainnet. */
function chainId(): string {
  return process.env.ZERION_MONAD_CHAIN_ID ?? "monad";
}

export function zerionEnabled(): boolean {
  return Boolean(process.env.ZERION_API_KEY) && process.env.ZERION_ENABLED !== "0";
}

function authHeader(): string {
  const key = process.env.ZERION_API_KEY ?? "";
  // Zerion: API key as the Basic-auth username, empty password.
  return `Basic ${Buffer.from(`${key}:`).toString("base64")}`;
}

/**
 * Fetch + normalize a wallet's Monad fungible positions, reporting *why* it
 * returned nothing.
 *
 * The caller must distinguish: `disabled` (no credentials — Zerion never had a
 * chance), `error` (configured but the request failed — the wallet's holdings
 * are *unknown*, not empty), and `ok` (an authoritative, possibly empty, list).
 */
export async function fetchZerionResult(
  address: string,
  _network: MonadNetwork = "mainnet",
): Promise<ZerionResult> {
  if (!zerionEnabled()) return { assets: [], status: "disabled" };
  if (!isEvmAddress(address)) return { assets: [], status: "ok" };
  const key = address.toLowerCase();

  return cache.get(key, async () => {
    try {
      const chain = chainId();
      const url =
        `https://api.zerion.io/v1/wallets/${address}/positions/` +
        `?filter[positions]=only_simple&currency=usd&sort=value` +
        `&filter[chain_ids]=${encodeURIComponent(chain)}`;
      const res = await fetchWithTimeout(url, {
        headers: { accept: "application/json", authorization: authHeader() },
        timeoutMs: 7000,
      });
      // A non-OK response is a provider failure — never an empty wallet.
      if (!res.ok) {
        return { assets: [], status: "error", reason: `Zerion responded ${res.status}` };
      }
      const json = (await res.json()) as PositionsResponse;
      if (!Array.isArray(json.data)) {
        return { assets: [], status: "error", reason: "Unexpected Zerion response shape" };
      }

      const out: ZerionAsset[] = [];
      const seen = new Set<string>();
      for (const p of json.data) {
        const a = p?.attributes;
        const info = a?.fungible_info;
        const symbol = info?.symbol?.trim();
        const name = info?.name?.trim();
        if (!symbol || !name) continue;

        // The implementation must be on this chain and have a real address.
        const impl = (info?.implementations ?? []).find(
          (i) => (i.chain_id ?? "").toLowerCase() === chain.toLowerCase() && i.address,
        );
        const addr = (impl?.address ?? "").toLowerCase();
        if (!isEvmAddress(addr)) continue;
        if (seen.has(addr)) continue;
        seen.add(addr);

        const decimals = Number.isInteger(impl?.decimals)
          ? (impl!.decimals as number)
          : Number.isInteger(a?.quantity?.decimals)
            ? (a!.quantity!.decimals as number)
            : 18;
        const amount =
          a?.quantity?.numeric ??
          (typeof a?.quantity?.float === "number" ? String(a.quantity.float) : "0");
        const usd = typeof a?.value === "number" && Number.isFinite(a.value) ? a.value : 0;
        const priceUsd = typeof a?.price === "number" && Number.isFinite(a.price) ? a.price : null;

        out.push({
          symbol,
          name,
          address: addr as Address,
          decimals,
          amount,
          usd,
          priceUsd,
          verified: Boolean(info?.flags?.verified),
          logoURI: info?.icon?.url,
        });
      }
      return { assets: out, status: "ok" };
    } catch (err) {
      return { assets: [], status: "error", reason: (err as Error)?.message ?? "Zerion unreachable" };
    }
  });
}

/**
 * Back-compat wrapper: the asset list only. Same semantics as before — a
 * failure yields [], so callers that only need assets never break. New callers
 * that must tell failure apart from empty should use `fetchZerionResult`.
 */
export async function fetchZerionAssets(
  address: string,
  network: MonadNetwork = "mainnet",
): Promise<ZerionAsset[]> {
  return (await fetchZerionResult(address, network)).assets;
}

export type ZerionPortfolio = {
  status: ZerionStatus;
  /** Total portfolio value across Monad positions, as reported by Zerion. */
  totalUsd: number;
  /** Per-chain USD breakdown (Monad). */
  byChain: { chainId: string; usd: number }[];
  reason?: string;
};

/**
 * Zerion portfolio valuation for a wallet on Monad.
 *
 * This is enrichment only: the composer never executes against it. It exists so
 * wallet intelligence can show a real cross-position value (the `/portfolio`
 * endpoint) rather than summing local, possibly-stale balances. A provider
 * failure yields `status: "error"` — never a fabricated zero.
 */
export async function fetchZerionPortfolio(
  address: string,
  _network: MonadNetwork = "mainnet",
): Promise<ZerionPortfolio> {
  if (!zerionEnabled()) return { status: "disabled", totalUsd: 0, byChain: [] };
  if (!isEvmAddress(address)) return { status: "ok", totalUsd: 0, byChain: [] };
  try {
    const chain = chainId();
    const url =
      `https://api.zerion.io/v1/wallets/${address}/portfolio/` +
      `?currency=usd&filter[chain_ids]=${encodeURIComponent(chain)}`;
    const res = await fetchWithTimeout(url, {
      headers: { accept: "application/json", authorization: authHeader() },
      timeoutMs: 7000,
    });
    if (!res.ok) {
      return { status: "error", totalUsd: 0, byChain: [], reason: `Zerion responded ${res.status}` };
    }
    const json = (await res.json()) as {
      data?: {
        attributes?: {
          total?: { positions?: number };
          positions_distribution_by_chain?: Record<string, number>;
        };
      };
    };
    const attrs = json.data?.attributes;
    const totalUsd =
      typeof attrs?.total?.positions === "number" && Number.isFinite(attrs.total.positions)
        ? attrs.total.positions
        : 0;
    const byChain = Object.entries(attrs?.positions_distribution_by_chain ?? {})
      .filter(([, v]) => typeof v === "number" && Number.isFinite(v))
      .map(([chainId, usd]) => ({ chainId, usd }));
    return { status: "ok", totalUsd, byChain };
  } catch (err) {
    return {
      status: "error",
      totalUsd: 0,
      byChain: [],
      reason: (err as Error)?.message ?? "Zerion unreachable",
    };
  }
}

/**
 * Normalize a Zerion asset into the app's TokenConfig, registering it so it
 * becomes payable/searchable without a code change.
 */
export function tokenFromZerion(asset: ZerionAsset): TokenConfig {
  return registerToken({
    symbol: asset.symbol,
    name: asset.name,
    address: asset.address,
    decimals: asset.decimals,
    fallbackUsd: 0,
    tint: tintForAddress(asset.address),
    source: "wallet",
    logoURI: asset.logoURI,
  });
}
