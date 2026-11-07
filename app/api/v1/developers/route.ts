import { adminAuthorized, adminConfigured } from "@/lib/server/auth";
import { apiError, apiOk, readJson, requireDeveloper } from "@/lib/developer/apiAuth";
import { createDeveloperWithKey, isProductionEnvironment, listApiKeys } from "@/lib/developer/credentials";
import { normalizeEmail } from "@/lib/developer/registration";
import { storeCapability } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/developers — create a developer account and its first API key.
 *
 * In **production** this requires the admin token (`INTENT_PAY_ADMIN_TOKEN`,
 * `Authorization: Bearer <token>`): it is the **operator-provisioned** path, kept
 * for support and bulk onboarding, and it stays administrator-only. Public
 * self-service signup is a separate flow (`/api/v1/developers/register` →
 * `/api/v1/developers/verify`), so an ordinary visitor never needs this token and
 * this endpoint never becomes an open bypass. Outside production it is open, so
 * the API is easy to try locally. The plaintext key is returned **once**; it is
 * never retrievable again.
 *
 * A developer account is a tenant: it owns its keys, intents and webhooks, and
 * no tenant can see another's.
 */
export async function POST(req: Request) {
  if (isProductionEnvironment()) {
    if (!adminConfigured()) {
      return apiError("forbidden", "Operator provisioning is not enabled on this deployment.", undefined);
    }
    if (!adminAuthorized(req.headers.get("authorization"))) {
      return apiError(
        "forbidden",
        "Operator provisioning requires the admin token. Self-service signup is available at the developer portal.",
        undefined,
      );
    }
  }

  const durable = await storeCapability();
  if (!durable.durable) {
    return apiError("storage_unavailable", durable.reason ?? "Durable storage is unavailable.");
  }

  const body = await readJson(req);
  const name = typeof body?.name === "string" && body.name.trim() ? body.name.trim().slice(0, 120) : "developer";
  const environment = body?.environment === "test" ? "test" : "live";
  // The operator may attach an email; because the operator vouches for the
  // account directly, it is marked verified so the credential is immediately
  // usable. (Without an email the account is unaffected by the verification gate.)
  const email = normalizeEmail(body?.email);

  const { developer, issued } = await createDeveloperWithKey({
    name,
    email,
    emailVerifiedAt: email ? Date.now() : null,
    environment,
  });
  return apiOk(
    {
      developer: { id: developer.id, name: developer.name, email: developer.email, status: developer.status },
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
 * and status of each key. The account's own email and verification state are
 * returned (they are the caller's own identity, never another tenant's).
 */
export async function GET(req: Request) {
  const auth = await requireDeveloper(req);
  if (!auth.ok) return auth.response;

  const keys = await listApiKeys(auth.auth.developer.id);
  return apiOk({
    developer: {
      id: auth.auth.developer.id,
      name: auth.auth.developer.name,
      email: auth.auth.developer.email,
      emailVerified: auth.auth.developer.emailVerifiedAt !== null,
      emailVerifiedAt: auth.auth.developer.emailVerifiedAt
        ? new Date(auth.auth.developer.emailVerifiedAt).toISOString()
        : null,
      status: auth.auth.developer.status,
      createdAt: new Date(auth.auth.developer.createdAt).toISOString(),
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

