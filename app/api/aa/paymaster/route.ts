import { NextResponse } from "next/server";
import { getPaymasterProvider, paymasterChainId } from "@/lib/server/paymaster";
import { findGasToken, normalizeSupportedTokens, gasTokenConfig } from "@/lib/server/paymaster/capabilities";
import { ENTRY_POINT_V07, ENTRY_POINT_V08 } from "@/lib/aa/abis";
import { filterUserOperation } from "@/lib/aa/userOp";

export const dynamic = "force-dynamic";

/**
 * POST /api/aa/paymaster — ERC-20 paymaster data proxy.
 *
 * The browser cannot hold the Pimlico key, so the bundler client's paymaster
 * `getPaymasterData` / `getPaymasterStubData` calls are forwarded here. The gas
 * token is validated against the provider's *live* supported set first: an
 * unsupported token is refused, so the app can never attach paymaster fields
 * for a token the paymaster doesn't accept.
 */
const ALLOWED = new Set(["pm_getPaymasterData", "pm_getPaymasterStubData"]);

/**
 * GET /api/aa/paymaster?token=0x… — the live ERC-20 gas quote for a token.
 *
 * Returns the paymaster address, exchange rate and postOp gas the browser needs
 * to compute the *bounded* allowance before signing. The token is validated
 * against the provider's live supported set, exactly as the POST path does.
 */
export async function GET(req: Request) {
  const chainId = paymasterChainId();
  const provider = getPaymasterProvider();
  if (!provider || !provider.configured()) {
    return NextResponse.json(
      { ok: false, message: "Gas abstraction isn't configured (PIMLICO_API_KEY is not set)." },
      { status: 503 },
    );
  }

  const tokenAddress = new URL(req.url).searchParams.get("token");
  if (!tokenAddress) {
    return NextResponse.json({ ok: false, message: "A gas token is required." }, { status: 400 });
  }

  const discovery = await provider.supportedTokens(chainId);
  const normalized = normalizeSupportedTokens(discovery, chainId);
  const token = findGasToken(normalized.tokens, chainId, tokenAddress);
  if (!token) {
    return NextResponse.json(
      { ok: false, message: `The paymaster doesn't accept ${tokenAddress} for gas on Monad.` },
      { status: 400 },
    );
  }

  const quote = await provider.gasQuote({ chainId, entryPoint: ENTRY_POINT_V08, token });
  if (!quote) {
    return NextResponse.json({ ok: false, message: "The paymaster did not return a gas quote." }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
    quote: {
      paymaster: quote.paymaster,
      token: gasTokenConfig(token),
      exchangeRate: quote.exchangeRate.toString(),
      postOpGas: quote.postOpGas.toString(),
      balanceSlot: quote.balanceSlot ? quote.balanceSlot.toString() : null,
      allowanceSlot: quote.allowanceSlot ? quote.allowanceSlot.toString() : null,
    },
  });
}

export async function POST(req: Request) {
  const chainId = paymasterChainId();
  const provider = getPaymasterProvider();
  if (!provider || !provider.configured()) {
    return NextResponse.json(
      { ok: false, message: "Gas abstraction isn't configured (PIMLICO_API_KEY is not set)." },
      { status: 503 },
    );
  }

  let body: {
    method?: string;
    userOperation?: Record<string, unknown>;
    entryPoint?: string;
    token?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, message: "Invalid JSON body." }, { status: 400 });
  }

  const method = body.method;
  const tokenAddress = body.token;
  const entryPoint = (body.entryPoint ?? ENTRY_POINT_V08) as `0x${string}`;
  if (!method || !ALLOWED.has(method)) {
    return NextResponse.json({ ok: false, message: `Method not allowed: ${method ?? "(none)"}` }, { status: 400 });
  }
  if (!tokenAddress) {
    return NextResponse.json({ ok: false, message: "A gas token is required." }, { status: 400 });
  }
  if (entryPoint.toLowerCase() !== ENTRY_POINT_V08.toLowerCase() && entryPoint.toLowerCase() !== ENTRY_POINT_V07.toLowerCase()) {
    return NextResponse.json({ ok: false, message: "Unsupported EntryPoint for this app." }, { status: 400 });
  }

  // Validate the token against the provider's live set — never trust the client.
  const discovery = await provider.supportedTokens(chainId);
  const normalized = normalizeSupportedTokens(discovery, chainId);
  const token = findGasToken(normalized.tokens, chainId, tokenAddress);
  if (!token) {
    return NextResponse.json(
      { ok: false, message: `The paymaster doesn't accept ${tokenAddress} for gas on Monad.` },
      { status: 400 },
    );
  }

  // Forward only real UserOperation fields — Pimlico rejects unknown keys, and
  // the client must never be able to inject transport-only fields.
  const userOperation = filterUserOperation(body.userOperation ?? {});
  const quote = await provider.quote({
    chainId,
    entryPoint,
    token,
    userOperation,
  });
  if (!quote) {
    return NextResponse.json({ ok: false, message: "The paymaster did not return a quote." }, { status: 502 });
  }

  // The 7702 account uses EntryPoint v0.8, which the wallet expects as a single
  // `paymaster` + `paymasterData` pair.
  return NextResponse.json({
    ok: true,
    result: {
      paymaster: quote.paymaster,
      paymasterData: quote.paymasterData,
      paymasterPostOpGasLimit: quote.paymasterPostOpGasLimit
        ? "0x" + quote.paymasterPostOpGasLimit.toString(16)
        : undefined,
      paymasterVerificationGasLimit: quote.paymasterVerificationGasLimit
        ? "0x" + quote.paymasterVerificationGasLimit.toString(16)
        : undefined,
      token: gasTokenConfig(token),
      tokenAmount: quote.tokenAmountDecimal,
      exchangeRate: quote.exchangeRate.toString(),
      postOpGas: quote.postOpGas ? quote.postOpGas.toString() : "0",
      balanceSlot: quote.balanceSlot ? quote.balanceSlot.toString() : null,
      allowanceSlot: quote.allowanceSlot ? quote.allowanceSlot.toString() : null,
      validUntil: quote.validUntil,
    },
  });
}
