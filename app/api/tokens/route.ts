import { NextResponse } from "next/server";
import { TOKENS } from "@/lib/config/tokens";
import { getRoutingProvider } from "@/lib/providers";

export const dynamic = "force-dynamic";

/**
 * Supported tokens, derived from configuration (never hardcoded in the UI).
 * When `mode=live` we also annotate which tokens currently have a liquid route
 * on Monad, so the selector can show honest availability.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") === "live" ? "live" : "demo";

  let available: string[] | null = null;
  if (mode === "live") {
    try {
      available = await getRoutingProvider("live", "mainnet").availableSymbols("mainnet");
    } catch {
      available = null;
    }
  }

  return NextResponse.json({
    ok: true,
    mode,
    network: "mainnet",
    tokens: TOKENS.map((t) => ({
      symbol: t.symbol,
      name: t.name,
      address: t.address,
      decimals: t.decimals,
      native: Boolean(t.native),
      tint: t.tint,
      fallbackUsd: t.fallbackUsd,
      routable: available ? available.includes(t.symbol) : true,
    })),
  });
}
