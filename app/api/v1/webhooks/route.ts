import { NextResponse } from "next/server";
import { apiError, apiOk, readJson, requireDeveloper } from "@/lib/developer/apiAuth";
import { checkLimit, tooManyResponse } from "@/lib/developer/rateLimits";
import { createWebhook, listWebhooks } from "@/lib/developer/webhooks";
import { validateWebhookUrl, publicWebhook } from "@/lib/developer/requests";
import { WEBHOOK_EVENTS } from "@/lib/developer/intentLifecycle";
import { storeCapability } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/webhooks — register a webhook destination.
 *
 * Body: `{ url, events: ["intent.created", …] | ["*"], description? }`.
 *
 * The signing secret is generated server-side and returned **once**, here. It is
 * never returned again, so the caller must store it. Deliveries are signed with
 * `X-IntentPay-Signature` (see the developer docs for the verification recipe).
 */
export async function POST(req: Request) {
  const auth = await requireDeveloper(req);
  if (!auth.ok) return auth.response;

  const durable = await storeCapability();
  if (!durable.durable) {
    return apiError("storage_unavailable", durable.reason ?? "Durable storage is unavailable.", auth.requestId);
  }

  const limited = await checkLimit(auth.auth.developer.id, "webhook");
  if (!limited.ok) {
    const { body, headers } = tooManyResponse(limited.resetAt);
    return NextResponse.json(body, { status: 429, headers });
  }

  const body = await readJson(req);
  if (!body) return apiError("invalid_request", "A JSON request body is required.", auth.requestId);

  const urlCheck = validateWebhookUrl(typeof body.url === "string" ? body.url : "");
  if (!urlCheck.ok) return apiError("invalid_request", urlCheck.message, auth.requestId, "url");

  const eventsInput = Array.isArray(body.events) ? body.events.filter((e): e is string => typeof e === "string") : [];
  if (eventsInput.length === 0) {
    return apiError("invalid_request", `Provide at least one event, or "*". Valid events: ${WEBHOOK_EVENTS.join(", ")}.`, auth.requestId, "events");
  }
  const unknown = eventsInput.filter((e) => e !== "*" && !(WEBHOOK_EVENTS as readonly string[]).includes(e));
  if (unknown.length > 0) {
    return apiError("invalid_request", `Unknown event(s): ${unknown.join(", ")}.`, auth.requestId, "events");
  }

  const { webhook, secret } = await createWebhook({
    developerId: auth.auth.developer.id,
    url: urlCheck.url,
    events: eventsInput,
    description: typeof body.description === "string" ? body.description : null,
  });

  return apiOk({ webhook: publicWebhook(webhook), secret }, { status: 201 });
}

/** GET /api/v1/webhooks — list this developer's webhook destinations. */
export async function GET(req: Request) {
  const auth = await requireDeveloper(req);
  if (!auth.ok) return auth.response;

  const limited = await checkLimit(auth.auth.developer.id, "read");
  if (!limited.ok) {
    const { body, headers } = tooManyResponse(limited.resetAt);
    return NextResponse.json(body, { status: 429, headers });
  }

  const hooks = await listWebhooks(auth.auth.developer.id);
  return apiOk({ webhooks: hooks.map(publicWebhook) });
}
