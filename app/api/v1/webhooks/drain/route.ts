import { adminAuthorized, adminConfigured } from "@/lib/server/auth";
import { apiError, apiOk } from "@/lib/developer/apiAuth";
import { deliverDue } from "@/lib/developer/webhooks";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/webhooks/drain — deliver every webhook that is due.
 *
 * Webhook delivery is asynchronous: an event enqueues a delivery row and this
 * endpoint performs the due attempts (with the retry schedule applied). It is
 * invoked by a scheduler (a Vercel cron) or manually by an operator, and is
 * gated by the admin token so an anonymous caller cannot drive outbound traffic.
 *
 * When no scheduler is configured the deliveries simply accumulate as `pending`
 * and are drained on the next call — nothing is lost, and no delivery is ever
 * reported as sent without a real HTTP response.
 */
export async function POST(req: Request) {
  if (!adminConfigured()) {
    return apiError("forbidden", "Webhook draining is not enabled on this deployment.");
  }
  if (!adminAuthorized(req.headers.get("authorization"))) {
    return apiError("forbidden", "Webhook draining requires the admin token.");
  }
  const summary = await deliverDue(Date.now(), { limit: 50 });
  return apiOk({ drained: summary });
}
