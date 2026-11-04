import { adminAuthorized, adminConfigured } from "@/lib/server/auth";
import { apiError, apiOk, readJson, requireDeveloper } from "@/lib/developer/apiAuth";
import { createDeveloperWithKey, isProductionEnvironment, listApiKeys } from "@/lib/developer/credentials";
import { storeCapability } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/developers — create a developer account and its first API key.
 *
 * In **production** this requires the admin token (`INTENT_PAY_ADMIN_TOKEN`,
 * `Authorization: Bearer <token>`), so self-serve signup can never become an
 * open production bypass. Outside production it is open, so the API is easy to
 * try locally. The plaintext key is returned **once**; it is never retrievable
 * again.
 *
 * A developer account is a tenant: it owns its keys, intents and webhooks, and
 * no tenant can see another's.
 */
export async function POST(req: Request) {
  if (isProductionEnvironment()) {
    if (!adminConfigured()) {
      return apiError("forbidden", "Developer signup is not enabled on this deployment.", undefined);
    }
    if (!adminAuthorized(req.headers.get("authorization"))) {
      return apiError("forbidden", "Developer signup requires the admin token.", undefined);
    }
  }

  const durable = await storeCapability();
  if (!durable.durable) {
    return apiError("storage_unavailable", durable.reason ?? "Durable storage is unavailable.");
  }

  const body = await readJson(req);
  const name = typeof body?.name === "string" && body.name.trim() ? body.name.trim().slice(0, 120) : "developer";
  const environment = body?.environment === "test" ? "test" : "live";

  const { developer, issued } = await createDeveloperWithKey({ name, environment });
  return apiOk(
    {
      developer: { id: developer.id, name: developer.name, status: developer.status },
      apiKey: issued.key,
      keyId: issued.record.id,
      environment: issued.record.environment,
      warning: "Store this key securely. It is shown once and cannot be retrieved again.",
    },
    { status: 201 },
  );
}

/**
 * GET /api/v1/developers — this developer's account and keys.
 *
 * Never returns a key secret or hash: only the public prefix, label, environment
 * and status of each key.
 */
export async function GET(req: Request) {
  const auth = await requireDeveloper(req);
  if (!auth.ok) return auth.response;

  const keys = await listApiKeys(auth.auth.developer.id);
  return apiOk({
    developer: {
      id: auth.auth.developer.id,
      name: auth.auth.developer.name,
      status: auth.auth.developer.status,
    },
    keys: keys.map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      environment: k.environment,
      status: k.status,
      createdAt: new Date(k.createdAt).toISOString(),
      lastUsedAt: k.lastUsedAt ? new Date(k.lastUsedAt).toISOString() : null,
      revokedAt: k.revokedAt ? new Date(k.revokedAt).toISOString() : null,
    })),
  });
}

