/**
 * Outbound email for developer signup.
 *
 * Intent Pay has no email infrastructure of its own, and this module never
 * pretends otherwise: when no provider is configured, `emailConfigured()` is
 * false and the registration route refuses with an honest
 * `email_unavailable` rather than accepting an account it cannot verify.
 *
 * Four transports exist; exactly one is active at a time:
 *
 *   - **smtp** — authenticated TLS SMTP, sent through `nodemailer`. Selected by
 *     `EMAIL_PROVIDER=smtp` (or auto-detected when the `SMTP_*` variables and
 *     `EMAIL_FROM` are present). Port 465 uses implicit TLS; any other port
 *     requires STARTTLS (`requireTLS`), so credentials are never sent over a
 *     plaintext socket. Works with a Gmail App Password and any standards SMTP
 *     host. `nodemailer` is imported lazily, so it is only loaded when SMTP is
 *     actually selected.
 *   - **resend** — an HTTP API (`RESEND_API_KEY` + `EMAIL_FROM`). Selected
 *     automatically when both are set. No SDK dependency; a single `fetch`.
 *   - **capture** — a test/development-only in-memory outbox
 *     (`INTENT_PAY_EMAIL_CAPTURE=1`, refused when `NODE_ENV=production`). It
 *     records messages so the test suite can exercise the real verification flow
 *     without a paid provider and without returning a token in an API response.
 *   - **none** — nothing is configured (or the requested provider is incomplete);
 *     the caller must fail honestly.
 *
 * Credentials (`SMTP_PASS`, `RESEND_API_KEY`) live only in the process
 * environment. They are never logged, returned, or included in any message — the
 * transport never logs a token, a key, a password or a link, and a failure is
 * reported as a fixed, credential-free sentence.
 */

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

export type EmailTransportKind = "smtp" | "resend" | "capture" | "none";

/** A captured message, for the test/dev outbox only. */
export type CapturedEmail = EmailMessage & { at: number };

/** The resolved SMTP settings. Holds the password; never serialize this. */
export type SmtpConfig = {
  host: string;
  port: number;
  /** Implicit TLS (port 465). */
  secure: boolean;
  /** Require STARTTLS before authenticating (any non-implicit-TLS port). */
  requireTLS: boolean;
  user: string;
  pass: string;
  from: string;
  /** Optional CA (PEM) to trust a private/self-signed host; unset for Gmail. */
  ca?: string;
};

/** Bounded timeouts so a hung SMTP host cannot hold a request open. */
const SMTP_CONNECTION_TIMEOUT_MS = 10_000;
const SMTP_GREETING_TIMEOUT_MS = 10_000;
const SMTP_SOCKET_TIMEOUT_MS = 20_000;

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

/**
 * The explicit provider request, if any.
 *
 * `invalid` marks a set-but-unknown value (a typo). It is deliberately *not*
 * treated as "unset": silently falling back to another provider would send mail
 * through a host the operator did not choose. An unknown value disables email
 * (the routes then refuse honestly) instead.
 */
function emailProviderSetting(): "smtp" | "resend" | "capture" | "invalid" | undefined {
  const raw = process.env.EMAIL_PROVIDER?.trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === "smtp" || raw === "resend" || raw === "capture") return raw;
  return "invalid";
}

/** Decode an optional base64 CA certificate (`SMTP_TLS_CA`). */
function smtpCa(): string | undefined {
  const b64 = process.env.SMTP_TLS_CA?.trim();
  if (!b64) return undefined;
  try {
    const pem = Buffer.from(b64, "base64").toString("utf8");
    return pem.includes("BEGIN CERTIFICATE") ? pem : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The resolved SMTP settings, or null when the configuration is incomplete.
 *
 * Incomplete means any required value is missing or malformed — never "use a
 * default that might send mail anyway". A null here makes the transport `none`,
 * so the routes refuse with `email_unavailable` rather than reporting a success
 * that never happened.
 */
export function smtpConfig(): SmtpConfig | null {
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS;
  const from = process.env.EMAIL_FROM?.trim();
  if (!user || !pass || !from) return null;

  const host = process.env.SMTP_HOST?.trim() || "smtp.gmail.com";
  const portRaw = process.env.SMTP_PORT?.trim();
  const port = portRaw ? Number.parseInt(portRaw, 10) : 465;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;

  // 465 is implicit TLS; every other port must upgrade with STARTTLS. Either way
  // the credentials only ever cross an encrypted socket.
  const secure = port === 465;
  return { host, port, secure, requireTLS: !secure, user, pass, from, ca: smtpCa() };
}

/** Which transport would send right now. */
export function emailTransportKind(): EmailTransportKind {
  const explicit = emailProviderSetting();
  if (explicit === "invalid") return "none";
  if (explicit === "smtp") return smtpConfig() ? "smtp" : "none";
  if (explicit === "resend") return resendConfigured() ? "resend" : "none";
  if (explicit === "capture") return captureEnabled() ? "capture" : "none";

  // No explicit choice: auto-detect. Resend first (the historical default), then
  // SMTP, then the dev-only capture outbox.
  if (resendConfigured()) return "resend";
  if (smtpConfig()) return "smtp";
  if (captureEnabled()) return "capture";
  return "none";
}

/** Whether a real verification email can be delivered. */
export function emailConfigured(): boolean {
  return emailTransportKind() !== "none";
}

export type SendResult = { ok: true; transport: EmailTransportKind } | { ok: false; reason: string };

/** The minimal nodemailer surface this module uses. */
type SmtpTransport = {
  sendMail(mail: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html?: string;
  }): Promise<{ accepted?: unknown[]; rejected?: unknown[]; response?: string }>;
  close?: () => void;
};

/**
 * Build a nodemailer transport. `nodemailer` is imported lazily so it is never
 * loaded (or bundled into a route) unless SMTP is actually selected.
 */
async function createSmtpTransport(cfg: SmtpConfig): Promise<SmtpTransport> {
  const { default: nodemailer } = await import("nodemailer");
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    requireTLS: cfg.requireTLS,
    auth: { user: cfg.user, pass: cfg.pass },
    ...(cfg.ca ? { tls: { ca: cfg.ca } } : {}),
    connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
    socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
  });
}

/**
 * A fixed, credential-free reason for a failed SMTP send.
 *
 * The provider's own message is never surfaced: it can embed the host, the user
 * name, or the server's full reply. Only the machine-readable `code` is used, and
 * only to pick one of a few honest sentences.
 */
export function smtpFailureReason(err: unknown): string {
  const code = (err as { code?: unknown } | undefined)?.code;
  switch (code) {
    case "EAUTH":
      return "The email server rejected the authentication credentials.";
    case "ECONNECTION":
    case "ESOCKET":
    case "ETIMEDOUT":
    case "ECONNREFUSED":
    case "ECONNRESET":
    case "EDNS":
      return "The email server could not be reached.";
    case "EENVELOPE":
      return "The email server rejected the message.";
    default:
      return "The email could not be sent.";
  }
}

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
  if (kind === "smtp") {
    return sendViaSmtp(message);
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

/**
 * Send through authenticated TLS SMTP.
 *
 * Success means the server accepted the recipient for delivery. A send that
 * throws (bad credentials, unreachable host) or that the server rejects is a
 * failure with a fixed, credential-free reason — never a fabricated success.
 */
async function sendViaSmtp(message: EmailMessage): Promise<SendResult> {
  const cfg = smtpConfig();
  if (!cfg) {
    return { ok: false, reason: "SMTP is selected but not fully configured." };
  }
  let transport: SmtpTransport | undefined;
  try {
    transport = await createSmtpTransport(cfg);
    const info = await transport.sendMail({
      from: cfg.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
    });
    // "Sent" means the server accepted the recipient — a rejection (empty
    // `accepted`) is a failure, never a success.
    const accepted = Array.isArray(info.accepted) ? info.accepted.length : 0;
    if (accepted === 0) {
      return { ok: false, reason: "The email server did not accept the message." };
    }
    return { ok: true, transport: "smtp" };
  } catch (err) {
    return { ok: false, reason: smtpFailureReason(err) };
  } finally {
    // No connection pooling: release the socket so a serverless invocation does
    // not leave a handle open.
    try {
      transport?.close?.();
    } catch {
      /* closing is best-effort */
    }
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
