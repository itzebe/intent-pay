import { readJson } from "@/lib/developer/apiAuth";
import { verifyEmailToken } from "@/lib/developer/registration";
import { signupError, signupRateLimit, sameOrigin } from "@/lib/developer/signupGuards";
import { storeCapability } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/developers/verify — exchange a verification token for the first
 * API key.
 *
 * Public (the token is the authorization). The token is single-use and expiring;
 * on success the account is marked verified and its **first key is returned once**
 * — the only time the plaintext secret is ever available. The key is never stored
 * in plaintext and never returned again by any endpoint.
 */
export async function POST(req: Request) {
  if (!sameOrigin(req)) {
    return signupError("forbidden", "This request did not originate from the Intent Pay site.");
  }

  const limited = await signupRateLimit({ bucket: "dev_verify", req, limit: 10, windowMs: 60 * 60 * 1000 });
  if (limited) return limited.response;

  const durable = await storeCapability();
  if (!durable.durable) {
    return signupError("storage_unavailable", "Verification requires durable storage, which is not available on this deployment.");
  }

  const body = await readJson(req);
  const token = typeof body?.token === "string" ? body.token : "";
  if (!token) return signupError("invalid_request", "A verification token is required.", 400, "token");

  const result = await verifyEmailToken(token);
  if (!result.ok) {
    if (result.code === "expired_token") {
      return signupError("expired", "This verification link has expired. Request a new one.", 410);
    }
    if (result.code === "already_verified") {
      return signupError("conflict", "This account is already verified. Sign in with your existing API key.", 409);
    }
    return signupError("invalid_request", "This verification link is not valid.", 400, "token");
  }

  return Response.json(
    {
      ok: true,
      status: "verified",
      developer: {
        id: result.developer.id,
        name: result.developer.name,
        email: result.developer.email,
        status: result.developer.status,
        emailVerifiedAt: result.developer.emailVerifiedAt ? new Date(result.developer.emailVerifiedAt).toISOString() : null,
      },
      apiKey: result.issued.key,
      keyId: result.issued.record.id,
      environment: result.issued.record.environment,
      warning: "Store this key securely. It is shown once and cannot be retrieved again.",
    },
    { status: 201 },
  );
}
