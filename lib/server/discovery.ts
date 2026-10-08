import { decodeAbiParameters, parseAbiParameters, type Address } from "viem";
import { getPublicClient } from "@/lib/server/rpc";
import type { MonadNetwork } from "@/lib/config/chains";
import { NATIVE_ADDRESS } from "@/lib/config/chains";
import {
  allTokens,
  configFromCurated,
  curatedCatalog,
  getToken,
  getTokenByAddress,
  registerToken,
  setActiveCatalog,
  tintForAddress,
  type TokenConfig,
} from "@/lib/config/tokens";
import { isEvmAddress } from "@/lib/format";
import { getCatalog } from "./tokenList";

/**
 * Token discovery layer.
 *
 * Separates three ideas that must never be conflated:
 *   1. the token exists on Monad (contract has code),
 *   2. we can identify it (metadata resolved),
 *   3. it is payable (a liquidity route can satisfy a payment).
 *
 * This module answers 1 and 2, plus "is it in the official list". Route
 * availability (3) is answered by the routing provider, because that is where
 * liquidity lives.
 */

/**
 * Ensure the runtime catalog is installed from the discovery source. Safe to
 * call on every request — the source is cached and de-duplicated.
 */
export async function ensureCatalog(network: MonadNetwork = "mainnet"): Promise<{
  count: number;
  source: string;
}> {
  const catalog = await getCatalog(network);
  setActiveCatalog(catalog.tokens, catalog.version);
  return { count: catalog.tokens.length, source: catalog.source };
}

export type ResolvedToken = {
  token: TokenConfig;
  /** True when a contract with code was found (or it's the native asset). */
  exists: boolean;
  /** Where the metadata came from. */
  source: "native" | "seed" | "list" | "onchain" | "wallet";
  /** True when the token came from the official Monad token list. */
  listed: boolean;
  /** Set when the address has no contract / is not a usable token. */
  problem?: string;
};

const METADATA_TTL_MS = 6 * 60 * 60 * 1000; // 6h — discovery is cached, not permanent
const metadataCache = new Map<string, { value: ResolvedToken; at: number }>();

function keyOf(address: string): string {
  return (address ?? "").toLowerCase();
}

/** Decode a string OR bytes32 return value (both are common in the wild). */
function decodeText(hex: string | undefined): string | undefined {
  if (!hex || hex === "0x") return undefined;
  try {
    return decodeAbiParameters(parseAbiParameters("string"), hex as `0x${string}`)[0];
  } catch {
    /* fall through to bytes32 */
  }
  try {
    const raw = hex.slice(2);
    const bytes = raw.match(/.{2}/g) ?? [];
    const text = Buffer.from(bytes.join(""), "hex")
      .toString("utf8")
      .replace(/\0+$/, "")
      .trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}

async function rawCall(
  network: MonadNetwork,
  to: string,
  data: `0x${string}`,
): Promise<string | undefined> {
  try {
    const client = getPublicClient(network);
    const res = await client.call({ to: to as Address, data });
    return res.data ?? undefined;
  } catch {
    return undefined;
  }
}

/** ERC-20 function selectors, read as raw eth_call data. */
const SELECTOR = {
  symbol: "0x95d89b41",
  name: "0x06fdde03",
  decimals: "0x313ce567",
} as const;

/**
 * Read a token's own metadata straight from its contract.
 *
 * This is the authoritative read used both for tokens we have never seen and
 * for confirming metadata an external source (Zerion) reported. Returns null
 * when the contract has no code or does not expose ERC-20 decimals — never a
 * guessed value.
 */
async function readOnChainMetadata(
  address: string,
  network: MonadNetwork,
): Promise<{ symbol?: string; name?: string; decimals: number } | null> {
  const client = getPublicClient(network);
  const code = await client.getBytecode({ address: address as Address }).catch(() => undefined);
  if (!code || code === "0x") return null;

  const [symbolHex, nameHex, decimalsHex] = await Promise.all([
    rawCall(network, address, SELECTOR.symbol),
    rawCall(network, address, SELECTOR.name),
    rawCall(network, address, SELECTOR.decimals),
  ]);

  const decimals = parseUint(decimalsHex);
  if (decimals === null || decimals < 0 || decimals > 36) return null;

  return {
    symbol: decodeText(symbolHex),
    name: decodeText(nameHex),
    decimals,
  };
}

/** Parse an eth_call word into a number, or null when it is empty/malformed. */
function parseUint(hex: string | undefined): number | null {
  if (!hex || hex === "0x" || hex.length <= 2) return null;
  try {
    const n = Number(BigInt(hex));
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Confirm a known token's metadata on chain (used for external sources). */
async function confirmOnChain(
  address: string,
  network: MonadNetwork,
): Promise<{ symbol?: string; name?: string; decimals: number } | null> {
  return readOnChainMetadata(address, network);
}

/**
 * Resolve a token from a contract address by reading the chain. Used for
 * addresses that are not in the official list — the "new token tomorrow" case.
 */
export async function resolveByAddress(
  address: string,
  network: MonadNetwork = "mainnet",
): Promise<ResolvedToken> {
  const cacheKey = `${network}:${keyOf(address)}`;
  const cached = metadataCache.get(cacheKey);
  if (cached && Date.now() - cached.at < METADATA_TTL_MS) return cached.value;

  const finish = (value: ResolvedToken) => {
    metadataCache.set(cacheKey, { value, at: Date.now() });
    return value;
  };

  if (!isEvmAddress(address)) {
    return {
      token: placeholder(address),
      exists: false,
      source: "onchain",
      listed: false,
      problem: "That doesn't look like a Monad contract address.",
    };
  }

  if (keyOf(address) === keyOf(NATIVE_ADDRESS)) {
    const native = getToken("MON")!;
    return finish({ token: native, exists: true, source: "native", listed: true });
  }

  // Already known (seed / list / previously discovered) — no need to hit the RPC.
  const known = getTokenByAddress(address);
  if (known && known.source !== "onchain") {
    // A token an external intelligence source (Zerion) reported carries that
    // source's decimals, which are *not* authoritative. Before we let it be
    // spent, confirm the contract's own decimals on chain so a wrong scale can
    // never cause a mis-scaled payment. On failure we keep the reported value
    // but mark it unverified rather than inventing one.
    if (known.source === "wallet") {
      const verified = await confirmOnChain(address, network);
      if (verified) {
        registerToken({
          ...known,
          decimals: verified.decimals,
          symbol: verified.symbol ?? known.symbol,
          name: verified.name ?? known.name,
          source: "onchain",
        });
        return finish({
          token: getTokenByAddress(address)!,
          exists: true,
          source: "onchain",
          listed: curatedHas(address),
        });
      }
    }
    return finish({
      token: known,
      exists: true,
      source: known.source ?? "list",
      listed: Boolean(known.seed) || curatedHas(address),
    });
  }

  const meta = await readOnChainMetadata(address, network);
  if (!meta) {
    // Distinguish "no contract" from "contract without ERC-20 decimals" by a
    // second, cheap code check — the user-facing reason differs.
    const client = getPublicClient(network);
    const code = await client.getBytecode({ address: address as Address }).catch(() => undefined);
    const hasCode = Boolean(code && code !== "0x");
    return finish({
      token: placeholder(address),
      exists: hasCode,
      source: "onchain",
      listed: false,
      problem: hasCode
        ? "That contract doesn't expose standard ERC-20 decimals."
        : "No token contract exists at that address on Monad.",
    });
  }

  const curated = curatedCatalog().find((c) => keyOf(c.address) === keyOf(address));
  const symbol = meta.symbol ?? curated?.symbol ?? "UNKNOWN";
  const name = meta.name ?? curated?.name ?? "Unknown token";

  const token = registerToken({
    symbol,
    name,
    address: address as Address,
    decimals: meta.decimals,
    fallbackUsd: 0,
    tint: tintForAddress(address),
    source: "onchain",
    logoURI: curated?.logoURI,
  });

  return finish({
    token,
    exists: true,
    source: "onchain",
    listed: Boolean(curated),
  });
}

/** Resolve by address, or by symbol/name using the curated catalog. */
export async function resolveToken(
  input: string,
  network: MonadNetwork = "mainnet",
): Promise<ResolvedToken | null> {
  const value = (input ?? "").trim();
  if (!value) return null;

  if (isEvmAddress(value)) return resolveByAddress(value, network);

  const known = getToken(value);
  if (known) {
    return {
      token: known,
      exists: true,
      source: known.source ?? "list",
      listed: curatedHas(known.address) || Boolean(known.seed),
    };
  }

  const match = curatedCatalog().find(
    (c) => c.symbol.toLowerCase() === value.toLowerCase(),
  );
  if (match) {
    const token = configFromCurated(match);
    return { token, exists: true, source: "list", listed: true };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Symbol resolution with ambiguity detection
//
// A token launched after deployment is not in the catalog. When the user names
// it by ticker or name we search the live catalog and the runtime registry.
// Crucially, if *several distinct contracts* share that ticker we must NOT
// guess: we return them all and ask the user to pick (or paste an address).
// Identity is always (chain, contract address) — never symbol.
// ---------------------------------------------------------------------------

export type AmbiguousMatch = {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  listed: boolean;
  source?: string;
  logoURI?: string;
};

export type SymbolResolution =
  | { status: "resolved"; token: TokenConfig; listed: boolean; source: string }
  | { status: "ambiguous"; query: string; matches: AmbiguousMatch[] }
  | { status: "not_found"; query: string };

/**
 * Resolve a ticker/name the user typed to a single token, or report honestly
 * that it is ambiguous or unknown. Never guesses between two same-symbol
 * contracts.
 *
 * Order of attack:
 *   1. exact symbol in the runtime registry (a previously resolved token),
 *   2. exact symbol in the live catalog,
 *   3. exact name match in the live catalog,
 *   4. a single substring match — only when it is unambiguous.
 */
export function resolveSymbol(query: string, _network: MonadNetwork = "mainnet"): SymbolResolution {
  const needle = (query ?? "").trim();
  if (!needle) return { status: "not_found", query: needle };
  const lower = needle.toLowerCase();

  // Everything we know: the live catalog plus anything registered at runtime
  // (a pasted address, a wallet-scanned asset). De-duplicated by contract.
  const byAddress = new Map<string, AmbiguousMatch>();
  const add = (e: AmbiguousMatch) => {
    const k = keyOf(e.address);
    const existing = byAddress.get(k);
    // A listed entry wins over an unlisted one for display metadata.
    if (existing && existing.listed && !e.listed) return;
    byAddress.set(k, e);
  };

  for (const c of curatedCatalog()) {
    add({
      address: c.address,
      symbol: c.symbol,
      name: c.name,
      decimals: c.decimals,
      listed: true,
      source: "list",
      logoURI: c.logoURI,
    });
  }
  for (const t of allTokens()) {
    add({
      address: t.address,
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
      listed: curatedHas(t.address) || Boolean(t.seed),
      source: t.source,
      logoURI: t.logoURI,
    });
  }
  const all = [...byAddress.values()];

  const finish = (matches: AmbiguousMatch[]): SymbolResolution => {
    if (matches.length === 0) return { status: "not_found", query: needle };
    if (matches.length > 1) return { status: "ambiguous", query: needle, matches };
    const m = matches[0];
    // Register so the token is resolvable app-wide afterwards.
    const token = registerToken({
      symbol: m.symbol,
      name: m.name,
      address: m.address as Address,
      decimals: m.decimals,
      fallbackUsd: 0,
      tint: tintForAddress(m.address),
      source: (m.source as TokenConfig["source"]) ?? "list",
      logoURI: m.logoURI,
    });
    return { status: "resolved", token, listed: m.listed, source: m.source ?? "list" };
  };

  // 1 + 2. Exact symbol.
  const exactSymbol = all.filter((e) => e.symbol.toLowerCase() === lower);
  if (exactSymbol.length) return finish(exactSymbol);

  // 3. Exact name.
  const exactName = all.filter((e) => e.name.toLowerCase() === lower);
  if (exactName.length) return finish(exactName);

  // 4. Unambiguous substring on symbol or name.
  const partial = all.filter(
    (e) => e.symbol.toLowerCase().includes(lower) || e.name.toLowerCase().includes(lower),
  );
  if (partial.length) return finish(partial);

  return { status: "not_found", query: needle };
}

/** A metadata-less placeholder — never invents a symbol or name. */
function placeholder(address: string): TokenConfig {
  return {
    symbol: "Unknown",
    name: "Unknown token",
    address: (isEvmAddress(address) ? address : NATIVE_ADDRESS) as Address,
    decimals: 18,
    fallbackUsd: 0,
    tint: tintForAddress(address),
    source: "onchain",
  };
}

let curatedIndex: Set<string> | null = null;
function curatedHas(address: string): boolean {
  if (!curatedIndex) {
    curatedIndex = new Set(curatedCatalog().map((c) => keyOf(c.address)));
  }
  return curatedIndex.has(keyOf(address));
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export type TokenSearchResult = {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
  listed: boolean;
  /** Where the metadata came from (list / seed / onchain / wallet). */
  source?: string;
};

/**
 * Search the catalog *and* the runtime registry by symbol, name, or address.
 *
 * Results are a *starting point* — the caller still asks the routing layer
 * whether each is payable. Including the registry means a token the user
 * pasted (or that was found in their wallet) is searchable afterwards, not
 * just the official list.
 */
export function searchTokens(query: string, limit = 30): TokenSearchResult[] {
  const needle = (query ?? "").trim().toLowerCase();

  const entries: TokenSearchResult[] = curatedCatalog().map((e) => ({
    address: e.address,
    symbol: e.symbol,
    name: e.name,
    decimals: e.decimals,
    logoURI: e.logoURI,
    listed: true,
    source: "list",
  }));

  // Merge anything discovered at runtime that the catalog doesn't contain.
  const seen = new Set(entries.map((e) => keyOf(e.address)));
  for (const t of allTokens()) {
    const k = keyOf(t.address);
    if (seen.has(k)) continue;
    seen.add(k);
    entries.push({
      address: t.address,
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
      logoURI: t.logoURI,
      listed: false,
      source: t.source,
    });
  }

  const scored: { score: number; entry: TokenSearchResult }[] = [];
  for (const e of entries) {
    const sym = e.symbol.toLowerCase();
    const name = e.name.toLowerCase();
    const addr = e.address.toLowerCase();
    let score = -1;
    if (!needle) score = 0;
    else if (sym === needle) score = 0;
    else if (sym.startsWith(needle)) score = 1;
    else if (sym.includes(needle)) score = 2;
    else if (name.startsWith(needle)) score = 3;
    else if (name.includes(needle)) score = 4;
    else if (addr.includes(needle)) score = 5;
    if (score >= 0) scored.push({ score, entry: e });
  }

  scored.sort((a, b) => a.score - b.score || a.entry.symbol.localeCompare(b.entry.symbol));
  return scored.slice(0, limit).map(({ entry }) => entry);
}

// ---------------------------------------------------------------------------
// Wallet asset discovery
// ---------------------------------------------------------------------------

export type DiscoveredBalance = {
  token: TokenConfig;
  amount: string;
  raw: bigint;
  /** True when the token came from the curated list (not a seed). */
  discovered: boolean;
  /** Where the USD price came from (stable/market/dex/onchain/fallback). */
  priceSource?: string;
};

const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/**
 * Find which Monad tokens a wallet actually holds.
 *
 * The public Monad RPC caps eth_getLogs at a 100-block range, so a
 * log-based asset scan is not viable. Instead we multicall `balanceOf` across
 * the discovered catalog (seed + official list) plus any assets an external
 * intelligence source (Zerion) reported — then keep only non-zero balances.
 *
 * On-chain balances are authoritative: a token Zerion lists but the chain says
 * the wallet does not hold is dropped. Zerion widens *which* tokens we look at;
 * the chain decides the amount.
 */
export async function discoverWalletBalances(
  address: Address,
  network: MonadNetwork,
  priceOf: (token: TokenConfig) => Promise<{ usd: number; source?: string }>,
  externalAssets: TokenConfig[] = [],
): Promise<{ balances: (DiscoveredBalance & { usd: number })[] }> {
  const client = getPublicClient(network);

  const byKey = new Map<string, TokenConfig>();
  const add = (t: TokenConfig) => {
    if (!byKey.has(keyOf(t.address))) byKey.set(keyOf(t.address), t);
  };
  for (const c of curatedCatalog()) add(configFromCurated(c));
  // Anything already registered but not in the catalog (e.g. pasted).
  for (const t of allTokens()) add(t);
  // Assets discovered by an external intelligence provider.
  for (const t of externalAssets) add(t);

  const candidates = [...byKey.values()];
  const erc20 = candidates.filter((t) => !t.native);

  const results = await client
    .multicall({
      contracts: erc20.map((t) => ({
        address: t.address as Address,
        abi: ERC20_ABI,
        functionName: "balanceOf" as const,
        args: [address] as const,
      })),
      allowFailure: true,
      batchSize: 64,
    })
    .catch(() => [] as Awaited<ReturnType<typeof client.multicall>>);

  const held: DiscoveredBalance[] = [];
  const native = getToken("MON")!;
  try {
    const raw = await client.getBalance({ address });
    held.push({ token: native, amount: formatRaw(raw, native.decimals), raw, discovered: false });
  } catch {
    /* ignore */
  }

  erc20.forEach((token, i) => {
    const r = (results as any[])[i];
    if (!r || r.status !== "success") return;
    const raw = r.result as bigint;
    if (raw <= 0n) return;
    held.push({ token, amount: formatRaw(raw, token.decimals), raw, discovered: !token.seed });
  });

  const priced = await Promise.all(
    held.map(async (b) => {
      const price = await priceOf(b.token).catch(() => ({ usd: 0, source: undefined }));
      return {
        ...b,
        usd: Number(b.amount) * (price.usd ?? 0),
        priceSource: price.source,
      };
    }),
  );

  priced.sort((a, b) => b.usd - a.usd);
  return { balances: priced };
}

function formatRaw(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const s = abs.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals) || "0";
  const frac = decimals > 0 ? s.slice(s.length - decimals).replace(/0+$/, "") : "";
  const out = frac ? `${whole}.${frac}` : whole;
  return negative ? `-${out}` : out;
}
