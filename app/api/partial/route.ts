import { NextResponse } from "next/server";
import type { Address } from "viem";
import type { MonadNetwork } from "@/lib/config/chains";
import { ensureCatalog, resolveToken } from "@/lib/server/discovery";
import { buildPartialLegs } from "@/lib/server/partial";
import { splitPayment } from "@/lib/domain/partialBalance";

export const dynamic = "force-dynamic";

/**
 * Partial-balance planning.
 *
 * Given a target asset + amount the recipient should receive, the amount the
 * wallet already holds of it, and a funded source asset, return the two real
 * legs (a direct transfer of the held part and a swap for the shortfall).
 *
 * Every amount and rate comes from a live quote; nothing is fabricated. When
 * there is no route for the shortfall we return a failure so the caller refuses
 * rather than pretending the split can execute.
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

  const network: MonadNetwork = "mainnet";
  const targetAddress = typeof body?.targetTokenAddress === "string" ? body.targetTokenAddress : "";
  const targetSymbol = typeof body?.targetToken === "string" ? body.targetToken : "";
  const targetAmount = typeof body?.targetAmount === "string" ? body.targetAmount : "";
  const held = typeof body?.held === "string" ? body.held : "0";
  const sourceAddress = typeof body?.sourceTokenAddress === "string" ? body.sourceTokenAddress : "";
  const sourceSymbol = typeof body?.sourceToken === "string" ? body.sourceToken : "";
  const sender = typeof body?.sender === "string" ? body.sender : "";

  if (!targetAmount || !held || (!targetAddress && !targetSymbol) || (!sourceAddress && !sourceSymbol)) {
    return NextResponse.json(
      { ok: false, code: "invalid_amount", message: "Missing partial-payment fields." },
      { status: 400 },
    );
  }

  try {
    await ensureCatalog(network);
    const [targetResolved, sourceResolved] = await Promise.all([
      resolveToken(targetAddress || targetSymbol, network),
      resolveToken(sourceAddress || sourceSymbol, network),
    ]);
    if (!targetResolved?.exists || !sourceResolved?.exists) {
      return NextResponse.json({
        ok: false,
        code: "unsupported_token",
        message: "One of the tokens for this split couldn't be resolved on Monad.",
      });
    }

    const targetToken = targetResolved.token;
    const sourceToken = sourceResolved.token;
    const split = splitPayment(targetAmount, held, targetToken.decimals);
    if (split.mode === "direct") {
      return NextResponse.json({ ok: true, split, direct: true, legs: null });
    }

    const result = await buildPartialLegs({
      targetToken,
      targetAmount,
      held,
      sourceToken,
      sender: (sender || "0x0000000000000000000000000000000000000000") as Address,
      network,
    });
    if (!result.ok) {
      return NextResponse.json({ ok: false, code: result.code, message: result.message });
    }

    const { directQuote, swapQuote } = result.legs;
    // Both legs are returned in full so the client can rebuild the *same*
    // protected plan locally (real per-leg bounds) from fresh data, exactly as
    // it does for a single-leg quote.
    const serialize = (q: typeof directQuote) => ({
      ...q,
      gasLimit: q.gasLimit?.toString(),
      gasPriceWei: q.gasPriceWei?.toString(),
    });
    return NextResponse.json({
      ok: true,
      split,
      direct: false,
      legs: {
        // The held part: a same-asset transfer.
        held: { amount: split.held, token: targetToken.symbol, address: targetToken.address },
        // The shortfall: a real swap from the source asset.
        shortfall: {
          amount: split.shortfall,
          token: targetToken.symbol,
          address: targetToken.address,
        },
        source: { symbol: sourceToken.symbol, address: sourceToken.address },
        directQuote: serialize(directQuote),
        swapQuote: serialize(swapQuote),
      },
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        code: "provider_error",
        message: (err as Error)?.message ?? "Could not plan the split payment.",
      },
      { status: 502 },
    );
  }
}
