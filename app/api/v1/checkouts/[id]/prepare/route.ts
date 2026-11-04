import { NextResponse } from "next/server";
import { isEvmAddress } from "@/lib/format";
import { apiError, apiOk, readJson, requireDeveloper } from "@/lib/developer/apiAuth";
import { checkLimit, tooManyResponse } from "@/lib/developer/rateLimits";
import { currentState, getIntent } from "@/lib/developer/intents";
import { getCheckout } from "@/lib/developer/checkouts";
import { prepareIntent } from "@/lib/developer/engine";
import { isTerminal } from "@/lib/developer/intentLifecycle";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/checkouts/:id/prepare — build the calls for the customer's wallet.
 *
 * Body: `{ sender: "0x…", payToken?: "USDC" }`.
 *
 * Convenience over the intent-level prepare: it resolves the checkout, checks it
 * is still payable, and builds the plan for the supplied customer wallet. The
 * plan is rebuilt from the intent's frozen parameters, so the calls can never
 * diverge from what the merchant defined. **Nothing is signed or sent** — only
 * the customer's wallet can authorize the transaction.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireDeveloper(req);
  if (!auth.ok) return auth.response;

  const limited = await checkLimit(auth.auth.developer.id, "prepare");
  if (!limited.ok) {
    const { body, headers } = tooManyResponse(limited.resetAt);
    return NextResponse.json(body, { status: 429, headers });
  }

  const { id } = await params;
  const checkout = await getCheckout(auth.auth.developer.id, id);
  if (!checkout) return apiError("not_found", "No such checkout.", auth.requestId);

  const intent = await getIntent(auth.auth.developer.id, checkout.intentId);
  if (!intent) return apiError("not_found", "The bound intent no longer exists.", auth.requestId);

  const state = await currentState(intent.id);
  if (isTerminal(state)) return apiError("invalid_state", `This checkout is ${state}.`, auth.requestId);
  if (state === "submitted" || state === "confirmed" || state === "verified") {
    return apiError("invalid_state", "This checkout already has a submitted transaction.", auth.requestId);
  }
  if (!intent.authorizedParams) {
    return apiError("invalid_state", "This checkout is not ready to be paid yet.", auth.requestId);
  }

  const body = await readJson(req);
  const sender = typeof body?.sender === "string" ? body.sender.trim() : "";
  if (!isEvmAddress(sender)) {
    return apiError("invalid_request", "`sender` must be the wallet address that will sign.", auth.requestId, "sender");
  }
  const payToken = typeof body?.payToken === "string" && body.payToken.trim() ? body.payToken.trim() : null;

  const result = await prepareIntent(intent, sender, payToken);
  if (!result.ok) {
    return apiError(
      result.code === "route_unavailable" ? "route_unavailable" : result.code === "provider_error" ? "provider_error" : "invalid_request",
      result.message,
      auth.requestId,
    );
  }

  return apiOk({
    checkoutId: checkout.id,
    state,
    sender: result.plan.sender,
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
    note: "Prepared only. The customer's wallet must sign and broadcast these calls; then submit and verify.",
  });
}
