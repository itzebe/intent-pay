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
const cache = new TtlCache<string, ZerionAsset[]>(TTL_MS);

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
 * Fetch + normalize a wallet's Monad fungible positions.
 *
 * Returns [] on any failure (missing key, network error, non-200). The caller
 * must treat [] as "Zerion contributed nothing" and continue with on-chain
 * data — never as "the wallet is empty".
 */
export async function fetchZerionAssets(
  address: string,
  _network: MonadNetwork = "mainnet",
): Promise<ZerionAsset[]> {
  if (!zerionEnabled() || !isEvmAddress(address)) return [];
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
      if (!res.ok) return [];
      const json = (await res.json()) as PositionsResponse;
      if (!Array.isArray(json.data)) return [];

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
      return out;
    } catch {
      return [];
    }
  });
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
