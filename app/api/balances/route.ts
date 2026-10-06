import { NextResponse } from "next/server";
import { readBalances } from "@/lib/server/balances";
import { getRoutingProvider, type AppMode } from "@/lib/providers";
import type { MonadNetwork } from "@/lib/config/chains";
import { isEvmAddress } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * Real balances for an address on Monad. In demo mode we never pretend to read
 * the chain — demo balances are produced client-side from the demo wallet.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const address = url.searchParams.get("address") ?? "";
  const network = (url.searchParams.get("network") as MonadNetwork) ?? "mainnet";
  const mode = (url.searchParams.get("mode") as AppMode) ?? "live";

  if (!isEvmAddress(address)) {
    return NextResponse.json(
      { ok: false, message: "A valid address is required." },
      { status: 400 },
    );
  }
  if (mode === "demo") {
    return NextResponse.json(
      { ok: false, message: "Demo balances are provided client-side." },
      { status: 400 },
    );
  }

  try {
    const provider = getRoutingProvider("live", network);
    const balances = await readBalances(
      address as `0x${string}`,
      network,
      (token) => provider.priceUsd(token, network),
    );
    return NextResponse.json({ ok: true, address, network, balances });
  } catch (err) {
    return NextResponse.json(
      { ok: false, message: (err as Error)?.message ?? "Failed to read balances." },
      { status: 502 },
    );
  }
}
