import { NextResponse } from "next/server";
import { discoverWalletBalances, ensureCatalog } from "@/lib/server/discovery";
import { getRoutingProvider } from "@/lib/providers";
import type { MonadNetwork } from "@/lib/config/chains";
import { isEvmAddress } from "@/lib/format";
import { fetchZerionResult, tokenFromZerion, zerionEnabled } from "@/lib/server/zerion";

export const dynamic = "force-dynamic";

/**
 * Real balances for an address on Monad.
 *
 * Asset discovery has two inputs, and they have different jobs:
 *   - Zerion (when configured) tells us *which* assets a wallet holds, with
 *     metadata and valuation — rich intelligence across Monad.
 *   - Monad on-chain reads give the *authoritative* balance for every candidate.
 *
 * Zerion widens the search; the chain decides the number. A token Zerion lists
 * but the wallet doesn'''t actually hold is dropped, because execution depends on
 * the on-chain balance, not the indexer'''s.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const address = url.searchParams.get("address") ?? "";
  const network: MonadNetwork = "mainnet";

  if (!isEvmAddress(address)) {
    return NextResponse.json(
      { ok: false, message: "A valid address is required." },
      { status: 400 },
    );
  }
  try {
    // Discover against the runtime catalog so a wallet's non-shipped holdings
    // (e.g. a token added to the official list after deploy) are still found.
    await ensureCatalog(network);
    const provider = getRoutingProvider(network);

    // Zerion asset intelligence (best-effort). We distinguish a *failure* from
    // an genuinely empty wallet: a configured-but-failing Zerion means the
    // wallet's cross-token holdings are unknown, not absent, and we say so.
    const zerion = await fetchZerionResult(address, network);
    const zerionAssets = zerion.assets;
    const externalAssets = zerionAssets.map(tokenFromZerion);
    const zerionByAddress = new Map(
      zerionAssets.map((a) => [a.address.toLowerCase(), a]),
    );

    const { balances } = await discoverWalletBalances(
      address as `0x${string}`,
      network,
      (token) => provider.priceUsd(token, network),
      externalAssets,
    );

    return NextResponse.json({
      ok: true,
      address,
      network,
      count: balances.length,
      /** Which intelligence sources actually contributed. */
      sources: {
        onchain: true,
        zerion: zerion.status === "ok" && zerionAssets.length > 0,
        zerionConfigured: zerionEnabled(),
        /** "ok" | "disabled" | "error" — a failure is never an empty wallet. */
        zerionStatus: zerion.status,
        zerionError: zerion.status === "error" ? zerion.reason : undefined,
      },
      balances: balances.map((b) => {
        const z = zerionByAddress.get(b.token.address.toLowerCase());
        return {
          token: b.token,
          amount: b.amount,
          usd: b.usd,
          discovered: b.discovered,
          priceSource: b.priceSource,
          /** Zerion's own valuation, when it saw this asset. */
          zerionUsd: z?.usd,
          verified: z?.verified,
        };
      }),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, message: (err as Error)?.message ?? "Failed to read balances." },
      { status: 502 },
    );
  }
}
