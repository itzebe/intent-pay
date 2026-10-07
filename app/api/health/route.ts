import { NextResponse } from "next/server";
import { NETWORKS } from "@/lib/config/chains";

export const dynamic = "force-dynamic";

export async function GET() {
  const configured = Boolean(process.env.MONAD_RPC_URL ?? true);
  return NextResponse.json({
    ok: true,
    app: "monad-intent-pay",
    chain: "monad",
    networks: {
      mainnet: { chainId: NETWORKS.mainnet.chainId, rpc: NETWORKS.mainnet.chain.rpcUrls.default.http[0] },
    },
    liveRouting: configured,
    time: new Date().toISOString(),
  });
}
