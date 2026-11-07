import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStore, setStore } from "@/lib/store";

import {
  emailConfigured,
  emailTransportKind,
  sendEmail,
  smtpConfig,
  smtpFailureReason,
} from "@/lib/developer/email";
import { startTestSmtpServer, type TestSmtpServer } from "./helpers/smtpServer";

/**
 * The SMTP email provider (Gmail-compatible authenticated TLS).
 *
 * These tests drive the **real** transport against a real in-process TLS SMTP
 * server — not a stub of `nodemailer` — so connection, STARTTLS, authentication
 * and the envelope are all exercised. What must hold:
 *
 *   - `EMAIL_PROVIDER=smtp` selects SMTP; an incomplete configuration selects
 *     **nothing** and refuses to send (never a fabricated success).
 *   - 465 is implicit TLS; other ports require STARTTLS.
 *   - a delivered message reports success and the server actually received it;
 *     a rejected authentication, an unreachable host and a refused recipient each
 *     report a specific, credential-free failure.
 *   - the password never appears in a result.
 *   - Resend and the dev-only capture transport keep working, and an unknown
 *     `EMAIL_PROVIDER` value disables email rather than silently falling back.
 */

const EMAIL = "dev@example.com";
const FROM = "jonathanebi05@gmail.com";

const SMTP_VARS = [
  "EMAIL_PROVIDER",
  "EMAIL_FROM",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_TLS_CA",
  "RESEND_API_KEY",
  "INTENT_PAY_EMAIL_CAPTURE",
] as const;

let saved: Record<string, string | undefined>;
let server: TestSmtpServer | undefined;

beforeEach(() => {
  saved = {};
  for (const k of SMTP_VARS) saved[k] = process.env[k];
  for (const k of SMTP_VARS) delete (process.env as Record<string, string | undefined>)[k];
  (process.env as Record<string, string | undefined>).NODE_ENV = "test";
  setStore(new SqliteStore(":memory:"));
});

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
  for (const k of SMTP_VARS) {
    if (saved[k] === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else (process.env as Record<string, string | undefined>)[k] = saved[k];
  }
  setStore(new SqliteStore(":memory:"));
});

/** Point the transport at a running test server. */
function configureSmtp(s: TestSmtpServer, overrides: Record<string, string | undefined> = {}) {
  process.env.EMAIL_PROVIDER = "smtp";
  process.env.EMAIL_FROM = FROM;
  process.env.SMTP_HOST = "127.0.0.1";
  process.env.SMTP_PORT = String(s.port);
  process.env.SMTP_USER = "user@example.com";
  process.env.SMTP_PASS = "app-password";
  process.env.SMTP_TLS_CA = s.certBase64;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else (process.env as Record<string, string | undefined>)[k] = v;
  }
}

describe("SMTP configuration is honest", () => {
  it("selects smtp only when the required variables are present", () => {
    expect(smtpConfig()).toBeNull();
    expect(emailTransportKind()).toBe("none");

    process.env.EMAIL_PROVIDER = "smtp";
    process.env.EMAIL_FROM = FROM;
    process.env.SMTP_USER = FROM;
    process.env.SMTP_PASS = "secret";
    // No SMTP_HOST/PORT: the Gmail defaults apply.
    const cfg = smtpConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.host).toBe("smtp.gmail.com");
    expect(cfg!.port).toBe(465);
    expect(cfg!.secure).toBe(true);
    expect(cfg!.requireTLS).toBe(false);
    expect(emailTransportKind()).toBe("smtp");
    expect(emailConfigured()).toBe(true);
  });

  it("uses STARTTLS (requireTLS) on a non-465 port and implicit TLS on 465", () => {
    process.env.EMAIL_FROM = FROM;
    process.env.SMTP_USER = FROM;
    process.env.SMTP_PASS = "secret";
    process.env.SMTP_HOST = "smtp.gmail.com";

    process.env.SMTP_PORT = "587";
    expect(smtpConfig()).toMatchObject({ secure: false, requireTLS: true });

    process.env.SMTP_PORT = "465";
    expect(smtpConfig()).toMatchObject({ secure: true, requireTLS: false });
  });

  it("is incomplete — and refuses to send — when a required value is missing", async () => {
    process.env.EMAIL_PROVIDER = "smtp";
    process.env.EMAIL_FROM = FROM;
    process.env.SMTP_USER = FROM;
    // SMTP_PASS is missing.
    expect(smtpConfig()).toBeNull();
    expect(emailTransportKind()).toBe("none");
    expect(emailConfigured()).toBe(false);

    const result = await sendEmail({ to: EMAIL, subject: "x", text: "y" });
    expect(result.ok).toBe(false);
  });

  it("treats a malformed port as unconfigured rather than guessing", () => {
    process.env.EMAIL_PROVIDER = "smtp";
    process.env.EMAIL_FROM = FROM;
    process.env.SMTP_USER = FROM;
    process.env.SMTP_PASS = "secret";
    process.env.SMTP_PORT = "not-a-port";
    expect(smtpConfig()).toBeNull();
    expect(emailTransportKind()).toBe("none");
  });

  it("an unknown EMAIL_PROVIDER disables email instead of falling back", () => {
    // Everything Resend needs is present, but the operator asked for something
    // else — a typo must not silently route mail through another provider.
    process.env.EMAIL_PROVIDER = "smpt";
    process.env.RESEND_API_KEY = "re_test";
    process.env.EMAIL_FROM = FROM;
    expect(emailTransportKind()).toBe("none");
    expect(emailConfigured()).toBe(false);
  });
});

describe("SMTP delivery", () => {
  it("delivers a real message and reports success only after the server accepts it", async () => {
    server = await startTestSmtpServer();
    configureSmtp(server);

    const result = await sendEmail({
      to: EMAIL,
      subject: "Verify your Intent Pay developer account",
      text: "Open https://intent-pay-roan.vercel.app/developer/verify?token=ipv_test to continue.",
    });

    expect(result).toEqual({ ok: true, transport: "smtp" });
    expect(server.received).toHaveLength(1);
    expect(server.received[0].to).toEqual([EMAIL]);
    expect(server.received[0].from).toBe(FROM);
    expect(server.lastText()).toContain("token=ipv_test");
  });

  it("reports a rejected authentication with a fixed, credential-free reason", async () => {
    server = await startTestSmtpServer();
    configureSmtp(server, { SMTP_PASS: "wrong-password" });

    const result = await sendEmail({ to: EMAIL, subject: "x", text: "y" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/authentication/i);
    // The password and the raw provider message are never surfaced.
    expect(result.reason).not.toContain("wrong-password");
    expect(server.received).toHaveLength(0);
  });

  it("reports an unreachable server", async () => {
    server = await startTestSmtpServer();
    configureSmtp(server, { SMTP_PORT: "1" }); // nothing listens on port 1

    const result = await sendEmail({ to: EMAIL, subject: "x", text: "y" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/could not be reached/i);
  });

  it("reports a refused recipient rather than a success", async () => {
    server = await startTestSmtpServer({ rejectRecipients: true });
    configureSmtp(server);

    const result = await sendEmail({ to: EMAIL, subject: "x", text: "y" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/reject|accept/i);
  });

  it("never puts the password in a failure reason", async () => {
    server = await startTestSmtpServer();
    configureSmtp(server, { SMTP_PASS: "super-secret-app-password" });

    const result = await sendEmail({ to: EMAIL, subject: "x", text: "y" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).not.toContain("super-secret-app-password");
  });
});

describe("smtpFailureReason maps machine codes to fixed sentences", () => {
  it("maps EAUTH / connection / envelope codes and defaults safely", () => {
    expect(smtpFailureReason({ code: "EAUTH" })).toMatch(/authentication/i);
    for (const code of ["ECONNECTION", "ESOCKET", "ETIMEDOUT", "ECONNREFUSED"]) {
      expect(smtpFailureReason({ code })).toMatch(/could not be reached/i);
    }
    expect(smtpFailureReason({ code: "EENVELOPE" })).toMatch(/rejected the message/i);
    expect(smtpFailureReason(new Error("some raw upstream text"))).toBe("The email could not be sent.");
    // A raw error message is never echoed.
    expect(smtpFailureReason(new Error("leaked@secret"))).not.toContain("leaked@secret");
  });
});

describe("end-to-end signup through SMTP", () => {
  it("registers, delivers a real verification email, and issues a key only after verify", async () => {
    const { POST: registerPOST } = await import("@/app/api/v1/developers/register/route");
    const { POST: verifyPOST } = await import("@/app/api/v1/developers/verify/route");

    // The signup routes require a *durable* store — the same gate production
    // enforces. An explicit SQLite path makes storeCapability() report persistent.
    process.env.INTENT_PAY_DB_PATH = "/data/intent-pay.sqlite";

    server = await startTestSmtpServer();
    configureSmtp(server);

    const post = (path: string, body: unknown) =>
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    const reg = await registerPOST(post("/api/v1/developers/register", { name: "Acme", email: EMAIL }));
    expect(reg.status).toBe(202);
    const regBody = await reg.json();
    expect(regBody.status).toBe("verification_sent");
    expect(regBody.emailTransport).toBe("smtp");
    // The token is never returned in the API response.
    expect(JSON.stringify(regBody)).not.toMatch(/ipv_/);

    // The message really went out over SMTP, and it carries the link.
    expect(server.received).toHaveLength(1);
    expect(server.received[0].to).toEqual([EMAIL]);
    const token = /token=(ipv_[a-f0-9]+)/.exec(server.lastText())?.[1];
    expect(token, "the delivered email must contain a verification link").toBeTruthy();

    // Only now is a credential issued — and only once.
    const verified = await verifyPOST(post("/api/v1/developers/verify", { token }));
    expect(verified.status).toBe(201);
    const verifiedBody = await verified.json();
    expect(verifiedBody.apiKey).toMatch(/^ipk_live_/);

    // Single-use: the same link cannot mint a second key.
    const replay = await verifyPOST(post("/api/v1/developers/verify", { token }));
    expect(replay.status).toBe(400);

    delete process.env.INTENT_PAY_DB_PATH;
  });

  it("refuses signup honestly when SMTP is selected but incomplete", async () => {
    const { POST: registerPOST } = await import("@/app/api/v1/developers/register/route");
    process.env.INTENT_PAY_DB_PATH = "/data/intent-pay.sqlite";
    process.env.EMAIL_PROVIDER = "smtp";
    process.env.EMAIL_FROM = FROM;
    process.env.SMTP_USER = FROM;
    // SMTP_PASS missing → transport none → honest refusal, no account created.

    const res = await registerPOST(
      new Request("http://localhost/api/v1/developers/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: EMAIL }),
      }),
    );
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("email_unavailable");

    delete process.env.INTENT_PAY_DB_PATH;
  });
});

describe("other transports are preserved", () => {
  it("keeps Resend when its key and from-address are set", () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.EMAIL_FROM = FROM;
    expect(emailTransportKind()).toBe("resend");
  });

  it("prefers an explicit EMAIL_PROVIDER over auto-detection", () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.EMAIL_FROM = FROM;
    process.env.SMTP_USER = FROM;
    process.env.SMTP_PASS = "secret";
    process.env.EMAIL_PROVIDER = "smtp";
    expect(emailTransportKind()).toBe("smtp");

    process.env.EMAIL_PROVIDER = "resend";
    expect(emailTransportKind()).toBe("resend");
  });

  it("never enables the capture transport in production", () => {
    process.env.INTENT_PAY_EMAIL_CAPTURE = "1";
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    expect(emailTransportKind()).toBe("none");
  });
});
