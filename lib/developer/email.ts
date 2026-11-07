/**
 * Outbound email for developer signup.
 *
 * Intent Pay has no email infrastructure of its own, and this module never
 * pretends otherwise: when no provider is configured, `emailConfigured()` is
 * false and the registration route refuses with an honest
 * `email_unavailable` rather than accepting an account it cannot verify.
 *
 * Two transports exist:
 *
 *   - **resend** — an HTTP API (`RESEND_API_KEY` + `EMAIL_FROM`). Selected
 *     automatically when both are set. No SDK dependency; a single `fetch`.
 *   - **capture** — a test/development-only in-memory outbox
 *     (`INTENT_PAY_EMAIL_CAPTURE=1`, refused when `NODE_ENV=production`). It
 *     records messages so the test suite can exercise the real verification flow
 *     without a paid provider and without returning a token in an API response.
 *
 * The transport never logs a token, a key or a link.
 */

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

export type EmailTransportKind = "resend" | "capture" | "none";

/** A captured message, for the test/dev outbox only. */
export type CapturedEmail = EmailMessage & { at: number };

const outbox: CapturedEmail[] = [];

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/** The capture transport is a development affordance and never runs in production. */
export function captureEnabled(): boolean {
  return process.env.INTENT_PAY_EMAIL_CAPTURE === "1" && !isProduction();
}

function resendConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

/** Which transport would send right now. */
export function emailTransportKind(): EmailTransportKind {
  if (resendConfigured()) return "resend";
  if (captureEnabled()) return "capture";
  return "none";
}

/** Whether a real verification email can be delivered. */
export function emailConfigured(): boolean {
  return emailTransportKind() !== "none";
}

export type SendResult = { ok: true; transport: EmailTransportKind } | { ok: false; reason: string };

/**
 * Send one email. Returns a structured result — never throws — so the caller can
 * report an honest failure instead of a fabricated success.
 */
export async function sendEmail(message: EmailMessage): Promise<SendResult> {
  const kind = emailTransportKind();
  if (kind === "none") {
    return { ok: false, reason: "No email provider is configured on this deployment." };
  }
  if (kind === "capture") {
    outbox.push({ ...message, at: Date.now() });
    return { ok: true, transport: "capture" };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
      }),
    });
    if (!res.ok) {
      // Never surface the provider body: it can echo the recipient or an id.
      return { ok: false, reason: `The email provider rejected the request (${res.status}).` };
    }
    return { ok: true, transport: "resend" };
  } catch {
    return { ok: false, reason: "The email provider could not be reached." };
  }
}

/** The captured outbox (test/dev only). Never available in production. */
export function getCapturedEmails(): CapturedEmail[] {
  if (!captureEnabled()) return [];
  return outbox.slice();
}

/** Clear the captured outbox (test/dev only). */
export function clearCapturedEmails(): void {
  outbox.length = 0;
}

/** The most recent captured message for an address, if any (test/dev only). */
export function lastCapturedTo(email: string): CapturedEmail | undefined {
  if (!captureEnabled()) return undefined;
  const target = email.trim().toLowerCase();
  for (let i = outbox.length - 1; i >= 0; i -= 1) {
    if (outbox[i].to.toLowerCase() === target) return outbox[i];
  }
  return undefined;
}
