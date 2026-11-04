import { NextResponse } from "next/server";
import { apiError, apiOk, readJson, requireDeveloper } from "@/lib/developer/apiAuth";
import { checkLimit, tooManyResponse } from "@/lib/developer/rateLimits";
import { parseCreateIntent, publicIntent } from "@/lib/developer/requests";
import { createIntent, listIntents, currentState } from "@/lib/developer/intents";
import { ensureCatalog, resolveToken } from "@/lib/server/discovery";
import { storeCapability } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/intents — create a payment intent.
 *
 * The intent is a *request*, not a transaction. Creating it never prepares,
 * signs or sends anything. The idempotency key (header `Idempotency-Key` or the
 * body field) is unique per developer, so a retried create returns the original
 * intent rather than a duplicate.
 *
 * Durability: an intent is meaningless if it cannot be remembered, so creation
 * is refused (503) when the store is not durable rather than returning an intent
 * that would vanish on the next cold start.
 */
export async function POST(req: Request) {
  const auth = await requireDeveloper(req);
  if (!auth.ok) return auth.response;
  const { developer, key } = auth.auth;

  const durable = await storeCapability();
  if (!durable.durable) {
    return apiError("storage_unavailable", durable.reason ?? "Durable storage is unavailable.", auth.requestId);
  }

  const limited = await checkLimit(developer.id, "create_intent");
  if (!limited.ok) {
    const { body, headers } = tooManyResponse(limited.resetAt);
    return NextResponse.json(body, { status: 429, headers });
  }

  const body = await readJson(req);
  if (!body) return apiError("invalid_request", "A JSON request body is required.", auth.requestId);

  const parsed = parseCreateIntent(body, req.headers.get("idempotency-key"));
  if ("ok" in parsed) return apiError(parsed.code, parsed.message, auth.requestId, parsed.detail);

  // Resolve the receive asset now so its canonical address is recorded on the
  // intent. A symbol we cannot resolve is refused rather than stored as a guess.
  await ensureCatalog("mainnet");
  const resolved = await resolveToken(parsed.receiveToken, "mainnet");
  if (!resolved || !resolved.exists) {
    return apiError("unsupported_token", resolved?.problem ?? `We couldn't find a Monad token for "${parsed.receiveToken}".`, auth.requestId, "receiveToken");
  }
  const result = await createIntent({
    developerId: developer.id,
    createdByKeyId: key.id,
    chainId: parsed.chainId,
    recipient: parsed.recipient,
    receiveToken: resolved.token.symbol,
    receiveTokenAddress: resolved.token.address,
    amountMode: parsed.amountMode,
    amount: parsed.amount,
    payToken: parsed.payToken,
    reference: parsed.reference,
    idempotencyKey: parsed.idempotencyKey,
  });

  if (!result.ok) {
    return apiError("idempotency_conflict", "That idempotency key was already used with different parameters.", auth.requestId);
  }

  return apiOk(
    {
      intent: publicIntent(result.intent, result.state),
      /** True when this response is the original create (not an idempotent replay). */
      created: result.created,
    },
    { status: result.created ? 201 : 200 },
  );
}

/**
 * GET /api/v1/intents — list this developer's intents, newest first.
 *
 * Scoped strictly to the authenticated developer; there is no parameter that can
 * widen it to another tenant.
 */
export async function GET(req: Request) {
  const auth = await requireDeveloper(req);
  if (!auth.ok) return auth.response;

  const limited = await checkLimit(auth.auth.developer.id, "read");
  if (!limited.ok) {
    const { body, headers } = tooManyResponse(limited.resetAt);
    return NextResponse.json(body, { status: 429, headers });
  }

  const rows = await listIntents(auth.auth.developer.id, 50);
  const intents = await Promise.all(rows.map(async (r) => publicIntent(r, await currentState(r.id))));
  return apiOk({ intents });
}
