import { NextResponse } from "next/server";
import type { Address } from "viem";
import { allTokens, SEED_TOKENS, catalogVersion, type TokenConfig } from "@/lib/config/tokens";
import { getRoutingProvider } from "@/lib/providers";
import type { MonadNetwork } from "@/lib/config/chains";
import { ensureCatalog, resolveToken, searchTokens } from "@/lib/server/discovery";
import { getCatalog } from "@/lib/server/tokenList";
import { getTokenIntelligence } from "@/lib/domain/tokenState";
import { probeTokenRisk } from "@/lib/server/tokenRisk";
import { WMON_ADDRESS } from "@/lib/providers/constants";

export const dynamic = "force-dynamic";

/**
 * Token discovery endpoint.
 *
 *  GET /api/tokens                    — the catalog (seed + official list),
 *                                       annotated with live routability
 *  GET /api/tokens?q=usdc             — search by symbol / name / address
 *  GET /api/tokens?address=0x…        — resolve + read metadata for one token
 *
 * The catalog comes from the *runtime* discovery source, not a shipped array,
 * so a token added upstream after deployment is searchable with no rebuild.
 * Nothing here is an allow-list: an address that is not listed can still be
 * resolved on chain, and routability is decided by the routing layer.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const network: MonadNetwork = "mainnet";
  const query = url.searchParams.get("q");
  const address = url.searchParams.get("address");
  const withAvailability = url.searchParams.get("availability") !== "0";

  // Install the runtime catalog (fetched + cached by the discovery source).
  const catalogInfo = await ensureCatalog(network);

  // Tri-state availability: true (probed + liquid), false (probed, no
  // liquidity), null (not probed yet — the answer comes from a real quote).
  let routability: Map<string, boolean> | null = null;
  if (withAvailability) {
    try {
      const provider = getRoutingProvider(network);
      routability = await (provider as any).routability?.() ?? null;
    } catch {
      routability = null;
    }
  }

  const annotate = (addr: string, pool: string): boolean | null => {
    if (routability === null) return null;
    const v = routability.get(addr.toLowerCase()) ?? routability.get(pool.toLowerCase());
    return typeof v === "boolean" ? v : null;
  };

  // ---- Resolve a single address ------------------------------------------
  if (address) {
    const resolved = await resolveToken(address, network);
    if (!resolved) {
      return NextResponse.json(
        { ok: false, code: "unsupported_token", message: "That address isn't a usable token." },
        { status: 200 },
      );
    }
    const t = resolved.token;

    // Genuinely probe this *specific* token's routability when asked, instead
    // of reporting "unknown" because it wasn't in a batch-probed graph. This is
    // what lets a token launched after deployment answer "can I pay with it?"
    // without ever having been added to a source list.
    let routable = annotate(t.address, poolKeyOf(t));
    if (resolved.exists && routable === null) {
      try {
        routable = await getRoutingProvider(network).isRoutable?.(t, network) ?? null;
      } catch {
        routable = null;
      }
    }

    const intelligence = resolved.exists
      ? await getTokenIntelligence(t, { network, routable })
      : null;

    // Real execution-risk assessment for the token (liquidity, transfer
    // simulation, route). Returned so the UI can block on evidence, not a guess.
    const risk = resolved.exists
      ? await probeTokenRisk({ network, token: t, hasRoute: routable === true }).catch(() => null)
      : null;

    return NextResponse.json({
      ok: true,
      network,
      found: resolved.exists,
      listed: resolved.listed,
      problem: resolved.problem,
      routable: resolved.exists ? routable : false,
      state: intelligence?.state ?? "UNKNOWN",
      stateFlags: intelligence?.flags ?? ["UNKNOWN"],
      payable: intelligence?.payable ?? false,
      catalog: { count: catalogInfo.count, source: catalogInfo.source, version: catalogVersion() },
      price: intelligence?.price ?? null,
      risk,
      token: serializeToken(t, resolved.source),
    });
  }

  // ---- Search -------------------------------------------------------------
  if (query !== null) {
    const results = searchTokens(query, 40).map((r) => ({
      ...r,
      routable: annotate(r.address, r.address),
    }));
    return NextResponse.json({
      ok: true,
      network,
      query,
      catalog: { count: catalogInfo.count, source: catalogInfo.source, version: catalogVersion() },
      results,
    });
  }

  // ---- Catalog ------------------------------------------------------------
  const catalog = allTokens().map((t) => ({
    ...serializeToken(t, t.source),
    fallbackUsd: t.fallbackUsd,
    routable: annotate(t.address, poolKeyOf(t)),
  }));

  return NextResponse.json({
    ok: true,
    network,
    /** Seeds are the shipped defaults; the rest is discovered at runtime. */
    seedCount: SEED_TOKENS.length,
    count: catalog.length,
    /** Where the catalog came from: the live list or the shipped fallback. */
    catalog: { count: catalogInfo.count, source: catalogInfo.source, version: catalogVersion() },
    tokens: catalog,
  });
}

function poolKeyOf(t: { native?: boolean; address: string }): string {
  // Native MON is pooled as WMON; compare on the pool address.
  return t.native ? WMON_ADDRESS.toLowerCase() : t.address;
}

function serializeToken(t: TokenConfig, source?: string) {
  return {
    symbol: t.symbol,
    name: t.name,
    address: t.address as Address,
    decimals: t.decimals,
    native: Boolean(t.native),
    tint: t.tint,
    logoURI: t.logoURI,
    source: source ?? t.source,
    seed: Boolean(t.seed),
  };
}

/** POST /api/tokens — register a token the user pasted (server-side metadata read). */
export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, message: "Invalid request." }, { status: 400 });
  }
  const address = String(body?.address ?? "");
  const network: MonadNetwork = "mainnet";

  await ensureCatalog(network);

  const resolved = await resolveToken(address, network);
  if (!resolved) {
    return NextResponse.json(
      { ok: false, code: "unsupported_token", message: "That address isn't a usable token." },
      { status: 200 },
    );
  }
  const t = resolved.token;

  let routable: boolean | null = null;
  if (resolved.exists) {
    try {
      const map = (await (getRoutingProvider(network) as any).routability?.()) as
        | Map<string, boolean>
        | null;
      if (map) routable = map.get(t.address.toLowerCase()) ?? map.get(poolKeyOf(t)) ?? null;
      else routable = null;
    } catch {
      routable = null;
    }
  }

  // Live price resolution (market -> DEX -> on-chain), independent of routing.
  const intelligence = resolved.exists
    ? await getTokenIntelligence(t, { network, routable, probeRoute: routable === null })
    : null;

  return NextResponse.json({
    ok: true,
    found: resolved.exists,
    listed: resolved.listed,
    problem: resolved.problem,
    routable,
    state: intelligence?.state ?? "UNKNOWN",
    stateFlags: intelligence?.flags ?? ["UNKNOWN"],
    payable: intelligence?.payable ?? false,
    price: intelligence?.price ?? null,
    catalog: { count: (await getCatalog(network)).tokens.length, version: catalogVersion() },
    token: serializeToken(t, resolved.source),
  });
}
