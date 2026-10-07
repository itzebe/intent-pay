import { NextResponse } from "next/server";
import { ensureCatalog } from "@/lib/server/discovery";
import { optimizePayment } from "@/lib/server/optimizer";
import type { AppMode } from "@/lib/providers";
import type { MonadNetwork } from "@/lib/config/chains";
import type { AmountMode, Balance, PaymentIntent } from "@/lib/domain/intent";
import { getToken } from "@/lib/config/tokens";

export const dynamic = "force-dynamic";

/**
 * POST /api/optimize — the gas-aware payment optimizer.
 *
 * Given the intent and the wallet's holdings, returns every funded asset ranked
 * as a way to pay (best first). This is what lets the composer *recommend* the
 * best payment asset — weighing route availability, amount, and network cost —
 * instead of making the user choose.
 */
export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, message: "Invalid request." }, { status: 400 });
  }

  const network: MonadNetwork = body?.network === "testnet" ? "testnet" : "mainnet";
  const mode: AppMode = body?.mode === "live" ? "live" : "demo";
  const amountMode: AmountMode =
    body?.amountMode === "i_spend" ? "i_spend" : "recipient_receives";

  const intent: PaymentIntent = {
    recipient: String(body?.recipient ?? ""),
    receiveToken: String(body?.receiveToken ?? ""),
    receiveAmount: String(body?.receiveAmount ?? ""),
    amountMode,
  };

  // Rebuild Balance objects from the wire payload (resolve metadata by symbol).
  const rawBalances: any[] = Array.isArray(body?.balances) ? body.balances : [];
  const balances: Balance[] = [];
  for (const b of rawBalances) {
    const symbol = b?.token?.symbol ?? b?.symbol;
    const token = symbol ? getToken(symbol) : undefined;
    if (!token) continue;
    balances.push({
      token,
      amount: String(b?.amount ?? "0"),
      usd: Number(b?.usd ?? 0),
    });
  }

  try {
    await ensureCatalog(network);
    const result = await optimizePayment(intent, balances, mode, network);
    return NextResponse.json({ ok: true, network, ...result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, message: (err as Error)?.message ?? "Could not evaluate payment options." },
      { status: 502 },
    );
  }
}
