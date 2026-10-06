import { NextResponse } from "next/server";
import type { Address } from "viem";
import { allTokens, SEED_TOKENS } from "@/lib/config/tokens";
import { getRoutingProvider, type AppMode } from "@/lib/providers";
import type { MonadNetwork } from "@/lib/config/chains";
import { resolveToken, searchTokens } from "@/lib/server/discovery";

export const dynamic = "force-dynamic";

/**
 * Token discovery endpoint.
 *
 *  GET /api/tokens                    — the catalog (seed + curated), optionally
 *                                       annotated with live routability
 *  GET /api/tokens?q=usdc             — search by symbol / name / address
 *  GET /api/tokens?address=0x…        — resolve + read metadata for one token
 *
 * Nothing here is an allow-list: a token that is not in the curated list can
 * still be resolved by address, and its routability is determined by the
 * routing layer rather than by membership in an array.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const mode: AppMode = url.searchParams.get("mode") === "live" ? "live" : "demo";
  const network: MonadNetwork = url.searchParams.get("network") === "testnet" ? "testnet" : "mainnet";
  const query = url.searchParams.get("q");
  const address = url.searchParams.get("address");
  const withAvailability = url.searchParams.get("availability") !== "0";

  let routable: Set<string> | null = null;
  if (mode === "live" && withAvailability) {
    try {
      const provider = getRoutingProvider("live", network);
      const keys = await (provider as any).routableKeys?.();
      routable = keys instanceof Set ? (keys as Set<string>) : null;
    } catch {
      routable = null;
    }
  }

  const annotate = (address: string, seed: boolean) => {
    if (routable === null) return seed;
    return routable.has(address.toLowerCase());
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
    return NextResponse.json({
      ok: true,
      mode,
      network,
      found: resolved.exists,
      listed: resolved.listed,
      problem: resolved.problem,
      routable: resolved.exists ? annotate(t.address, Boolean(t.seed)) : false,
      token: {
        symbol: t.symbol,
        name: t.name,
        address: t.address,
        decimals: t.decimals,
        native: Boolean(t.native),
        tint: t.tint,
        logoURI: t.logoURI,
        source: resolved.source,
        seed: Boolean(t.seed),
      },
    });
  }

  // ---- Search -------------------------------------------------------------
  if (query !== null) {
    const results = searchTokens(query, 40).map((r) => ({
      ...r,
      tint: undefined,
      routable: routable === null ? true : routable.has(r.address.toLowerCase()),
    }));
    return NextResponse.json({ ok: true, mode, network, query, results });
  }

  // ---- Catalog ------------------------------------------------------------
  const catalog = allTokens().map((t) => ({
    symbol: t.symbol,
    name: t.name,
    address: t.address,
    decimals: t.decimals,
    native: Boolean(t.native),
    tint: t.tint,
    logoURI: t.logoURI,
    fallbackUsd: t.fallbackUsd,
    source: t.source,
    seed: Boolean(t.seed),
    routable: annotate(t.address, Boolean(t.seed)),
  }));

  return NextResponse.json({
    ok: true,
    mode,
    network,
    /** Seeds are the shipped defaults; the rest is discovered at runtime. */
    seedCount: SEED_TOKENS.length,
    count: catalog.length,
    tokens: catalog,
  });
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
  const network: MonadNetwork = body?.network === "testnet" ? "testnet" : "mainnet";
  const mode: AppMode = body?.mode === "live" ? "live" : "demo";

  const resolved = await resolveToken(address, network);
  if (!resolved) {
    return NextResponse.json(
      { ok: false, code: "unsupported_token", message: "That address isn't a usable token." },
      { status: 200 },
    );
  }
  const t = resolved.token;

  let routable = false;
  if (mode === "live" && resolved.exists) {
    try {
      const keys = await (getRoutingProvider("live", network) as any).routableKeys?.();
      routable = keys instanceof Set ? (keys as Set<string>).has(t.address.toLowerCase()) : false;
    } catch {
      routable = false;
    }
  }

  return NextResponse.json({
    ok: true,
    found: resolved.exists,
    listed: resolved.listed,
    problem: resolved.problem,
    routable,
    token: {
      symbol: t.symbol,
      name: t.name,
      address: t.address as Address,
      decimals: t.decimals,
      native: Boolean(t.native),
      tint: t.tint,
      logoURI: t.logoURI,
      source: resolved.source,
      seed: Boolean(t.seed),
    },
  });
}
