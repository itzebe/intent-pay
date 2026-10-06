import { NextResponse } from "next/server";
import { buildQuote } from "@/lib/server/quote";
import { getRoutingProvider, type AppMode } from "@/lib/providers";
import type { MonadNetwork } from "@/lib/config/chains";
import type { AmountMode, PaymentIntent } from "@/lib/domain/intent";

export const dynamic = "force-dynamic";

/**
 * Intent -> quote. The request carries only the payment intent plus the chosen
 * payment asset; the routing layer decides how to satisfy it.
 */
export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, code: "provider_error", message: "Invalid request." }, { status: 400 });
  }

  const {
    recipient,
    receiveToken,
    receiveAmount,
    amountMode,
    payToken,
    mode = "demo",
    network = "mainnet",
    simulateMove,
  } = body ?? {};

  if (
    typeof recipient !== "string" ||
    typeof receiveToken !== "string" ||
    typeof receiveAmount !== "string" ||
    typeof payToken !== "string" ||
    (amountMode !== "recipient_receives" && amountMode !== "i_spend")
  ) {
    return NextResponse.json(
      { ok: false, code: "provider_error", message: "Missing payment intent fields." },
      { status: 400 },
    );
  }

  const intent: PaymentIntent = {
    recipient,
    receiveToken,
    receiveAmount,
    amountMode: amountMode as AmountMode,
  };

  const appMode: AppMode = mode === "live" ? "live" : "demo";
  const net: MonadNetwork = network === "testnet" ? "testnet" : "mainnet";

  try {
    const result = await buildQuote(
      { intent, payToken, network: net, simulateMove },
      appMode,
      net,
    );

    if (!result.ok) {
      // Enrich a route failure with the sender's available alternatives.
      let alternatives = result.alternatives;
      if (result.code === "route_unavailable" && !alternatives) {
        alternatives = await getRoutingProvider(appMode, net).availableSymbols(net);
      }
      return NextResponse.json({ ...result, alternatives });
    }

    return NextResponse.json({
      ok: true,
      quote: {
        ...result.quote,
        gasLimit: result.quote.gasLimit?.toString(),
        gasPriceWei: result.quote.gasPriceWei?.toString(),
      },
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, code: "provider_error", message: (err as Error)?.message ?? "Could not build a quote." },
      { status: 502 },
    );
  }
}
