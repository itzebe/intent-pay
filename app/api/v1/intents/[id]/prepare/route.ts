import { NextResponse } from "next/server";
import { isEvmAddress } from "@/lib/format";
import { apiError, apiOk, readJson, requireDeveloper } from "@/lib/developer/apiAuth";
import { checkLimit, tooManyResponse } from "@/lib/developer/rateLimits";
import { currentState, getIntent, transition } from "@/lib/developer/intents";
import { prepareIntent } from "@/lib/developer/engine";
import { isTerminal } from "@/lib/developer/intentLifecycle";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/intents/:id/prepare — build the transaction calls for a wallet.
 *
 * Body: `{ sender: "0x…", payToken?: "USDC" }`.
 *
 * The response contains the encoded `{to, data, value}` calls, in order, that the
 * caller's wallet must send, plus the guaranteed minimum the recipient receives.
 * **Nothing is signed or sent here** — a credential cannot authorize a
 * transaction; only the wallet the caller controls can. The plan is rebuilt from
 * the intent's frozen parameters, so a prepared transaction can never diverge
 * from what was authorized.
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
  const record = await getIntent(auth.auth.developer.id, id);
  if (!record) return apiError("not_found", "No such intent.", auth.requestId);

  const state = await currentState(record.id);
  if (isTerminal(state)) return apiError("invalid_state", `This intent is ${state}.`, auth.requestId);

  const body = await readJson(req);
  const sender = typeof body?.sender === "string" ? body.sender.trim() : "";
  if (!isEvmAddress(sender)) {
    return apiError("invalid_request", "`sender` must be the wallet address that will sign.", auth.requestId, "sender");
  }
  const payToken = typeof body?.payToken === "string" && body.payToken.trim() ? body.payToken.trim() : null;

  const result = await prepareIntent(record, sender, payToken);
  if (!result.ok) {
    return apiError(
      result.code === "route_unavailable" ? "route_unavailable" : result.code === "provider_error" ? "provider_error" : "invalid_request",
      result.message,
      auth.requestId,
    );
  }

  // Advance the lifecycle only once a real, executable plan exists. A repeated
  // prepare is allowed (prepared → prepared) so a caller can refresh a stale
  // quote without losing the intent.
  const current = await currentState(record.id);
  if (current !== "prepared") {
    if (current === "created") await transition(record, "validating", null);
    const afterValidate = await currentState(record.id);
    if (afterValidate === "validating") await transition(record, "validated", null);
    const beforePrepare = await currentState(record.id);
    if (beforePrepare === "validated") await transition(record, "prepared", null);
  } else {
    await transition(record, "prepared", null);
  }

  const newState = await currentState(record.id);
  return apiOk({
    state: newState,
    /** The wallet the calls are prepared for. */
    sender: result.plan.sender,
    /** Send these in order. The wallet signs and broadcasts them itself. */
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
    /** The frozen-parameter fingerprint the wallet approval should display. */
    fingerprint: result.plan.fingerprint,
    /** An explicit reminder that this is not yet a payment. */
    note: "Prepared only. The wallet must sign and broadcast these calls; then authorize and submit.",
  });
}

