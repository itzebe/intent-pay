import { NextResponse } from "next/server";
import { apiError, apiOk, readJson, requireDeveloper } from "@/lib/developer/apiAuth";
import { checkLimit, tooManyResponse } from "@/lib/developer/rateLimits";
import { parseCreateCheckout } from "@/lib/developer/requests";
import { currentState, getIntent } from "@/lib/developer/intents";
import { checkoutEventData, createCheckout, bindIntentForCheckout, listCheckouts, publicCheckout } from "@/lib/developer/checkouts";
import { isTerminal } from "@/lib/developer/intentLifecycle";
import { enqueueEvent } from "@/lib/developer/webhooks";
import { storeCapability } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/checkouts — create a checkout session for an intent.
 *
 * Body: `{ intentId, orderReference?, ttlSeconds?, idempotencyKey? }`.
 *
 * The checkout is the *payable order* the merchant shares with a customer. It
 * stores no payment parameters of its own: the amount, asset and recipient live
 * on the bound intent, are frozen at authorization, and can never be changed
 * through the checkout. The response includes the public `token` (the payment
 * link handle) and the derived `status`/`phase`.
 *
 * The `Idempotency-Key` header (or body field) is unique per developer: a
 * retried create returns the original checkout and its link, never a duplicate.
 */
export async function POST(req: Request) {
  const auth = await requireDeveloper(req);
  if (!auth.ok) return auth.response;
  const { developer } = auth.auth;

  const durable = await storeCapability();
  if (!durable.durable) {
    return apiError("storage_unavailable", durable.reason ?? "Durable storage is unavailable.", auth.requestId);
  }

  const limited = await checkLimit(developer.id, "write");
  if (!limited.ok) {
    const { body, headers } = tooManyResponse(limited.resetAt);
    return NextResponse.json(body, { status: 429, headers });
  }

  const body = await readJson(req);
  if (!body) return apiError("invalid_request", "A JSON request body is required.", auth.requestId);

  const parsed = parseCreateCheckout(body, req.headers.get("idempotency-key"));
  if ("ok" in parsed) return apiError(parsed.code, parsed.message, auth.requestId, parsed.detail);

  // The intent must exist and be owned by this developer — the read is scoped, so
  // another tenant's intent is `not_found`, never a 403 that confirms it exists.
  const intent = await getIntent(developer.id, parsed.intentId);
  if (!intent) return apiError("not_found", "No such intent.", auth.requestId);

  const state = await currentState(intent.id);
  if (isTerminal(state)) return apiError("invalid_state", `This intent is ${state} and cannot back a new checkout.`, auth.requestId);

  const result = await createCheckout(intent, {
    developerId: developer.id,
    intentId: intent.id,
    orderReference: parsed.orderReference,
    ttlMs: parsed.ttlMs ?? undefined,
    idempotencyKey: parsed.idempotencyKey,
  });
  if (!result.ok) {
    return apiError("conflict", "A checkout already exists for this intent.", auth.requestId);
  }

  // Bind the intent to the order: freeze its parameters and advance it to
  // `awaiting_authorization`, so it is payable and its recipient/amount/asset can
  // never change afterwards. Only done for a fresh checkout (a replay is already
  // bound).
  let boundState = state;
  if (result.created) {
    boundState = await bindIntentForCheckout(intent);
    await enqueueEvent({
      developerId: developer.id,
      event: "checkout.created",
      data: checkoutEventData(result.checkout, boundState),
    });
  }

  return apiOk(
    {
      checkout: publicCheckout(result.checkout, boundState),
      /** The public payment link handle. */
      token: result.token,
      created: result.created,
    },
    { status: result.created ? 201 : 200 },
  );
}

/** GET /api/v1/checkouts — this developer's checkouts, newest first. */
export async function GET(req: Request) {
  const auth = await requireDeveloper(req);
  if (!auth.ok) return auth.response;

  const limited = await checkLimit(auth.auth.developer.id, "read");
  if (!limited.ok) {
    const { body, headers } = tooManyResponse(limited.resetAt);
    return NextResponse.json(body, { status: 429, headers });
  }

  const rows = await listCheckouts(auth.auth.developer.id, 50);
  const checkouts = await Promise.all(
    rows.map(async (c) => {
      const state = await currentState(c.intentId);
      const intent = await getIntent(auth.auth.developer.id, c.intentId);
      return {
        ...publicCheckout(c, state),
        amount: intent?.amount ?? null,
        receiveToken: intent?.receiveToken ?? null,
        recipient: intent?.recipient ?? null,
      };
    }),
  );
  return apiOk({ checkouts });
}
