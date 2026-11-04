import { apiError, apiOk, readJson, requireDeveloper } from "@/lib/developer/apiAuth";
import { issueApiKey, listApiKeys, revokeApiKey, rotateApiKey } from "@/lib/developer/credentials";
import { storeCapability } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/developers/keys — issue, rotate or revoke an API key.
 *
 * Body:
 *   `{ action: "create", name?, environment? }` → a new key (secret shown once).
 *   `{ action: "rotate", keyId }`               → the old key is revoked and a
 *                                                  replacement is issued (secret
 *                                                  shown once).
 *   `{ action: "revoke", keyId }`               → the key is revoked.
 *
 * A developer can only manage its own keys. Rotation and revocation take effect
 * immediately: the next authenticated request with the old secret fails.
 */
export async function POST(req: Request) {
  const auth = await requireDeveloper(req);
  if (!auth.ok) return auth.response;

  const durable = await storeCapability();
  if (!durable.durable) {
    return apiError("storage_unavailable", durable.reason ?? "Durable storage is unavailable.", auth.requestId);
  }

  const body = await readJson(req);
  if (!body) return apiError("invalid_request", "A JSON request body is required.", auth.requestId);
  const action = typeof body.action === "string" ? body.action : "";
  const keyId = typeof body.keyId === "string" ? body.keyId : "";

  if (action === "create") {
    const environment = body.environment === "test" ? "test" : "live";
    const issued = await issueApiKey(auth.auth.developer.id, {
      name: typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 120) : "New key",
      environment,
    });
    return apiOk(
      { key: issued.key, keyId: issued.record.id, environment: issued.record.environment, warning: "Store this key securely. It is shown once." },
      { status: 201 },
    );
  }

  if (action === "rotate") {
    // Only the developer's own key can be rotated.
    const keys = await listApiKeys(auth.auth.developer.id);
    if (!keys.some((k) => k.id === keyId)) return apiError("not_found", "No such key.", auth.requestId);
    const issued = await rotateApiKey(keyId);
    if (!issued) return apiError("not_found", "No such key.", auth.requestId);
    return apiOk(
      { key: issued.key, keyId: issued.record.id, rotatedFrom: keyId, environment: issued.record.environment, warning: "Store this key securely. The previous key is revoked." },
      { status: 201 },
    );
  }

  if (action === "revoke") {
    const keys = await listApiKeys(auth.auth.developer.id);
    if (!keys.some((k) => k.id === keyId)) return apiError("not_found", "No such key.", auth.requestId);
    const ok = await revokeApiKey(keyId);
    if (!ok) return apiError("not_found", "No such key.", auth.requestId);
    return apiOk({ revoked: true, keyId });
  }

  return apiError("invalid_request", '`action` must be "create", "rotate" or "revoke".', auth.requestId, "action");
}
