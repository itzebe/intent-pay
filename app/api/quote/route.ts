import { NextResponse } from "next/server";
import { buildQuote } from "@/lib/server/quote";
import { getRoutingProvider, type AppMode } from "@/lib/providers";
import type { MonadNetwork } from "@/lib/config/chains";
import type { AmountMode, PaymentIntent } from "@/lib/domain/intent";
import { ensureCatalog, resolveToken } from "@/lib/server/discovery";
import { getToken } from "@/lib/config/tokens";

export const dynamic = "force-dynamic";

/**
 * Intent -> quote.
 *
 * The request carries only the payment intent plus the chosen payment asset.
 * Either side may be a symbol ("USDC") or a contract address ("0x…") — an
 * address is resolved against the chain, so a token that was launched after
 * deployment can be quoted without any code change.
 */
export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, code: "provider_error", message: "Invalid request." },
      { status: 400 },
    );
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

  const appMode: AppMode = mode === "live" ? "live" : "demo";
  const net: MonadNetwork = network === "testnet" ? "testnet" : "mainnet";

  try {
    // Install the runtime catalog before resolving, so a symbol that only
    // exists in the live list resolves even if it was never shipped.
    await ensureCatalog(net);

    // Resolve both sides to real token configs (symbol or address).
    const [receiveResolved, payResolved] = await Promise.all([
      resolveToken(receiveToken, net),
      resolveToken(payToken, net),
    ]);

    const receiveConfig = receiveResolved?.token ?? getToken(receiveToken);
    const payConfig = payResolved?.token ?? getToken(payToken);

    if (!receiveConfig || !payConfig) {
      const which = !receiveConfig ? receiveToken : payToken;
      return NextResponse.json({
        ok: false,
        code: "unsupported_token",
        message: `We couldn't find a Monad token for "${which}".`,
      });
    }

    // A token we cannot identify at all must never be presented as payable.
    if (receiveResolved && !receiveResolved.exists) {
      return NextResponse.json({
        ok: false,
        code: "unsupported_token",
        message: receiveResolved.problem ?? "That token doesn't exist on Monad.",
      });
    }

    // The payment asset must also be a real token — otherwise we would quote a
    // payment the sender could never actually sign.
    if (payResolved && !payResolved.exists) {
      return NextResponse.json({
        ok: false,
        code: "unsupported_token",
        message: payResolved.problem ?? "That payment asset doesn't exist on Monad.",
      });
    }

    const intent: PaymentIntent = {
      recipient,
      // Always store the canonical symbol so the UI can display it.
      receiveToken: receiveConfig.symbol,
      receiveAmount,
      amountMode: amountMode as AmountMode,
    };

    const result = await buildQuote(
      {
        intent,
        payToken: payConfig.symbol,
        payTokenConfig: payConfig,
        receiveToken: receiveConfig,
        network: net,
        simulateMove,
      },
      appMode,
      net,
    );

    if (!result.ok) {
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
      {
        ok: false,
        code: "provider_error",
        message: (err as Error)?.message ?? "Could not build a quote.",
      },
      { status: 502 },
    );
  }
}
