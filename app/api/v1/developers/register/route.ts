import { readJson } from "@/lib/developer/apiAuth";
import { emailConfigured, sendEmail, emailTransportKind } from "@/lib/developer/email";
import { normalizeEmail, registerDeveloper } from "@/lib/developer/registration";
import { signupError, signupRateLimit, sameOrigin } from "@/lib/developer/signupGuards";
import { verificationEmail, verificationLink } from "@/lib/developer/signup";
import { storeCapability } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/developers/register — start self-service signup.
 *
 * Public: no administrator token, no API key. Creates a **pending** developer
 * account and emails a single-use verification link. **No API key is issued
 * here** — the credential is only minted once the address is proven (see
 * `/api/v1/developers/verify`), so an unverified (possibly forged) email can
 * never obtain one.
 *
 * The response is deliberately the same for a new address, a pending one and an
 * already-verified one ("a verification email is on its way"), so the endpoint
 * cannot be used to enumerate which addresses have accounts. Only the input
 * format and abuse limits produce a different status.
 */
export async function POST(req: Request) {
  if (!sameOrigin(req)) {
    return signupError("forbidden", "This request did not originate from the Intent Pay site.");
  }

  const limited = await signupRateLimit({ bucket: "dev_register", req, limit: 5, windowMs: 60 * 60 * 1000 });
  if (limited) return limited.response;

  const durable = await storeCapability();
  if (!durable.durable) {
    return signupError("storage_unavailable", "Self-service signup requires durable storage, which is not available on this deployment.");
  }

  const body = await readJson(req);
  const email = normalizeEmail(body?.email);
  if (!email) {
    return signupError("invalid_request", "A valid email address is required.", 400, "email");
  }

  // A verification email is the whole point of signup; without a provider we
  // refuse honestly rather than accept an account we can never verify.
  if (!emailConfigured()) {
    return signupError(
      "email_unavailable",
      "Email verification is not configured on this deployment, so self-service signup is unavailable. The operator must configure an email provider.",
    );
  }

  const result = await registerDeveloper({
    name: typeof body?.name === "string" ? body.name : undefined,
    email,
  });

  // `already_registered` means a verified account owns the address. Do not create
  // or re-arm anything, and do not reveal it — send the owner a notice instead.
  if (!result.ok && result.code === "already_registered") {
    await sendEmail({
      to: email,
      subject: "Your Intent Pay developer account",
      text:
        "An Intent Pay developer account already exists for this address.\n\n" +
        "If this was you, sign in to the developer portal with your existing API key. " +
        "If you no longer have it, contact the operator.\n\n" +
        "If this was not you, you can ignore this message.",
    });
    return respond(email);
  }

  if (!result.ok) {
    return signupError("invalid_request", "A valid email address is required.", 400, "email");
  }

  const link = verificationLink(result.token);
  const sent = await sendEmail(verificationEmail({ to: email, link }));
  if (!sent.ok) {
    // The account is pending but no email left. Report the real failure rather
    // than a success the developer would wait on forever.
    return signupError("provider_error", sent.reason, 502);
  }

  return respond(email, result.resent);
}

/** The uniform, non-enumerating success body. */
function respond(email: string, resent = false) {
  return Response.json(
    {
      ok: true,
      status: "verification_sent",
      email,
      resent,
      emailTransport: emailTransportKind(),
      message: "If that address can be registered, a verification email is on its way. Open the link to receive your API key.",
    },
    { status: 202 },
  );
}
