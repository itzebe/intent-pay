import { NextResponse } from "next/server";
import { isEvmAddress } from "@/lib/format";
import { apiError, apiOk, readJson } from "@/lib/developer/apiAuth";
import { checkLimit, tooManyResponse } from "@/lib/developer/rateLimits";
import { currentState, getIntent } from "@/lib/developer/intents";
import { expireCheckoutIfStale, getCheckoutByToken } from "@/lib/developer/checkouts";
import { prepareIntent } from "@/lib/developer/engine";
import { isTerminal } from "@/lib/developer/intentLifecycle";
import { isValidCheckoutToken } from "@/lib/developer/checkoutToken";

export const dynamic = "force-dynamic";

/**
 * POST /api/checkout/:token/prepare — build the calls for the customer's wallet.
 *
 * Body: `{ sender: "0x…", payToken?: "USDC" }`.
 *
 * Token-authenticated (the customer has no API key). Builds the plan for the
 * supplied customer wallet from the intent's frozen parameters, so the calls can
 * never diverge from what the merchant defined. **Nothing is signed or sent** —
 * only the customer's own wallet can authorize the transaction. The route never
 * accepts a recipient/amount/asset override.
 */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!isValidCheckoutToken(token)) return apiError("not_found", "No such checkout.");

  const limited = await checkLimit(token, "checkout_public");
  if (!limited.ok) {
    const { body, headers } = tooManyResponse(limited.resetAt);
    return NextResponse.json(body, { status: 429, headers });
  }

  const checkout = await getCheckoutByToken(token);
  if (!checkout) return apiError("not_found", "No such checkout.");

  await expireCheckoutIfStale(checkout);
  const intent = await getIntent(checkout.developerId, checkout.intentId);
  if (!intent) return apiError("not_found", "This checkout's payment no longer exists.");

  const state = await currentState(intent.id);
  if (isTerminal(state)) return apiError("invalid_state", `This checkout is ${state}.`);
  if (state === "submitted" || state === "confirmed" || state === "verified") {
    return apiError("invalid_state", "This checkout already has a submitted transaction.");
  }
  if (!intent.authorizedParams) return apiError("invalid_state", "This checkout is not ready to be paid yet.");

  const body = await readJson(req);
  const sender = typeof body?.sender === "string" ? body.sender.trim() : "";
  if (!isEvmAddress(sender)) return apiError("invalid_request", "`sender` must be the wallet address that will sign.", undefined, "sender");
  const payToken = typeof body?.payToken === "string" && body.payToken.trim() ? body.payToken.trim() : null;

  const result = await prepareIntent(intent, sender, payToken);
  if (!result.ok) {
    return apiError(
      result.code === "route_unavailable" ? "route_unavailable" : result.code === "provider_error" ? "provider_error" : "invalid_request",
      result.message,
    );
  }

  return apiOk({
    calls: result.plan.calls.map((c) => ({ to: c.to, data: c.data ?? "0x", value: (c.value ?? 0n).toString() })),
    steps: result.plan.steps,
    quote: {
      payToken: result.plan.payToken,
      payAmount: result.plan.payAmount,
      receiveToken: result.plan.receiveToken,
      receiveAmount: result.plan.receiveAmount,
      minimumReceived: result.plan.minimumReceived,
      slippageBps: result.plan.slippageBps,
      networkCostUsd: result.plan.networkCostUsd,
    },
    fingerprint: result.plan.fingerprint,
    note: "Prepared only. Your wallet must sign and broadcast these calls.",
  });
}
