import { readJson } from "@/lib/developer/apiAuth";
import { emailConfigured, sendEmail, emailTransportKind } from "@/lib/developer/email";
import { normalizeEmail, resendVerification } from "@/lib/developer/registration";
import { signupError, signupRateLimit, sameOrigin } from "@/lib/developer/signupGuards";
import { verificationEmail, verificationLink } from "@/lib/developer/signup";
import { getStore, storeCapability } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/developers/resend — re-send a verification email.
 *
 * Public. It re-arms an **existing pending** registration only: it never creates
 * an account (that is `/register`), and a verified address is never re-armed.
 * Re-arming replaces the previous token, so a resend cannot accumulate valid
 * links. The response is identical whether or not a pending account exists, so
 * it cannot be used for enumeration.
 */
export async function POST(req: Request) {
  if (!sameOrigin(req)) {
    return signupError("forbidden", "This request did not originate from the Intent Pay site.");
  }

  // A tighter limit than registration: a resend must not become an email bomb.
  const limited = await signupRateLimit({ bucket: "dev_resend", req, limit: 3, windowMs: 60 * 60 * 1000 });
  if (limited) return limited.response;

  const durable = await storeCapability();
  if (!durable.durable) {
    return signupError("storage_unavailable", "Self-service signup requires durable storage, which is not available on this deployment.");
  }

  const body = await readJson(req);
  const email = normalizeEmail(body?.email);
  if (!email) return signupError("invalid_request", "A valid email address is required.", 400, "email");

  if (!emailConfigured()) {
    return signupError(
      "email_unavailable",
      "Email verification is not configured on this deployment, so self-service signup is unavailable.",
    );
  }

  // Only a pending account is re-armed; an unknown or verified address is a no-op
  // answered with the same body.
  const developer = await getStore().findOne("apiDevelopers", { email });
  if (developer && developer.emailVerifiedAt === null) {
    const result = await resendVerification(developer.id);
    if (result.ok) {
      const sent = await sendEmail(verificationEmail({ to: email, link: verificationLink(result.token) }));
      if (!sent.ok) return signupError("provider_error", sent.reason, 502);
    }
  }

  return Response.json(
    {
      ok: true,
      status: "verification_sent",
      email,
      emailTransport: emailTransportKind(),
      message: "If that address has a pending registration, a new verification email is on its way.",
    },
    { status: 202 },
  );
}
