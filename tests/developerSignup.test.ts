import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore, SqliteStore, getStore, setStore } from "@/lib/store";
import { SCHEMA_VERSION } from "@/lib/store/types";
import { MIGRATIONS } from "@/lib/store/migrations";

import {
  EMAIL_VERIFICATION_TTL_MS,
  hashVerificationToken,
  normalizeEmail,
  registerDeveloper,
  verifyEmailToken,
} from "@/lib/developer/registration";
import {
  captureEnabled,
  clearCapturedEmails,
  emailConfigured,
  emailTransportKind,
  getCapturedEmails,
  lastCapturedTo,
  sendEmail,
} from "@/lib/developer/email";

import { POST as registerPOST } from "@/app/api/v1/developers/register/route";
import { POST as verifyPOST } from "@/app/api/v1/developers/verify/route";
import { POST as resendPOST } from "@/app/api/v1/developers/resend/route";
import { GET as developersGET, POST as developersPOST } from "@/app/api/v1/developers/route";
import { GET as intentsGET } from "@/app/api/v1/intents/route";
import { POST as keysPOST } from "@/app/api/v1/developers/keys/route";
import { GET as capabilitiesGET } from "@/app/api/v1/capabilities/route";
import { createDeveloperWithKey, issueApiKey } from "@/lib/developer/credentials";

/**
 * Self-service developer registration and API-key management.
 *
 * These tests exercise the real routes and the real store. The properties that
 * matter — and that a plausible-but-wrong implementation would violate — are:
 *
 *   - **no credential before proof.** Registration issues no key; only a verified
 *     email does. An unverified account cannot authenticate even if a key exists.
 *   - **the token is single-use, expiring, and never stored in plaintext.**
 *   - **registration is non-enumerating** — the same response for a new, pending
 *     or already-registered address.
 *   - **an unconfigured email provider fails honestly** (`email_unavailable`),
 *     never a fabricated success.
 *   - **one address, one account** (a unique-constraint invariant, not a race).
 */

const EMAIL = "dev@example.com";
const ADMIN = "test-admin-token-0123456789";

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {
    NODE_ENV: process.env.NODE_ENV,
    INTENT_PAY_DB_PATH: process.env.INTENT_PAY_DB_PATH,
    INTENT_PAY_ADMIN_TOKEN: process.env.INTENT_PAY_ADMIN_TOKEN,
    INTENT_PAY_EMAIL_CAPTURE: process.env.INTENT_PAY_EMAIL_CAPTURE,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    EMAIL_FROM: process.env.EMAIL_FROM,
  };
  // A configured SQLite path makes storeCapability() report `persistent`, which
  // the signup routes require — the same gate production enforces.
  process.env.INTENT_PAY_DB_PATH = "/data/intent-pay.sqlite";
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
  process.env.INTENT_PAY_EMAIL_CAPTURE = "1";
  (process.env as Record<string, string | undefined>).NODE_ENV = "test";
  setStore(new SqliteStore(":memory:"));
  clearCapturedEmails();
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else (process.env as Record<string, string | undefined>)[k] = v;
  }
  setStore(new MemoryStore());
  clearCapturedEmails();
});

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("email validation", () => {
  it("normalizes and accepts a real address, rejecting junk", () => {
    expect(normalizeEmail("  Dev@Example.COM ")).toBe("dev@example.com");
    for (const bad of ["", "no-at", "a@b", "a@b.", "@example.com", "a b@example.com", "x".repeat(300) + "@e.com"]) {
      expect(normalizeEmail(bad), `should reject ${JSON.stringify(bad)}`).toBeNull();
    }
    expect(normalizeEmail(42)).toBeNull();
  });
});

describe("registration issues no credential", () => {
  it("creates a pending account and a token, and stores only the token hash", async () => {
    const result = await registerDeveloper({ name: "Acme", email: EMAIL });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.developer.emailVerifiedAt).toBeNull();

    // No API key exists yet — this is the whole point of the two-step flow.
    expect(await getStore().count("apiKeys", { developerId: result.developer.id })).toBe(0);

    // The plaintext token is returned once and never persisted.
    expect(result.token).toMatch(/^ipv_/);
    const row = await getStore().findOne("apiEmailVerifications", { developerId: result.developer.id });
    expect(row).toBeTruthy();
    expect(row!.tokenHash).toBe(hashVerificationToken(result.token));
    expect(row!.tokenHash).not.toContain(result.token);
    // A database dump contains no working link.
    expect(JSON.stringify(row)).not.toContain(result.token.slice(4));
  });

  it("re-arms a pending account instead of creating a duplicate", async () => {
    const first = await registerDeveloper({ email: EMAIL });
    const second = await registerDeveloper({ email: EMAIL });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.developer.id).toBe(first.developer.id);
    expect(second.resent).toBe(true);
    // Exactly one live challenge — the old link no longer exists.
    expect(await getStore().count("apiEmailVerifications", { developerId: first.developer.id })).toBe(1);
    expect(await getStore().count("apiDevelopers", { email: EMAIL })).toBe(1);
  });

  it("refuses a second account for an already-verified address", async () => {
    const first = await registerDeveloper({ email: EMAIL });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await verifyEmailToken(first.token);
    const again = await registerDeveloper({ email: EMAIL });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.code).toBe("already_registered");
  });
});

describe("verification issues the first key exactly once", () => {
  it("verifies the account, returns a usable key, and consumes the token", async () => {
    const reg = await registerDeveloper({ email: EMAIL });
    if (!reg.ok) throw new Error("registration failed");
    const verified = await verifyEmailToken(reg.token);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.developer.emailVerifiedAt).not.toBeNull();
    expect(verified.issued.key).toMatch(/^ipk_live_/);

    // The freshly issued key authenticates the API immediately.
    const authed = await intentsGET(
      new Request("http://localhost/api/v1/intents", { headers: { authorization: `Bearer ${verified.issued.key}` } }),
    );
    expect(authed.status).toBe(200);

    // Single-use: the same link cannot mint a second key.
    const replay = await verifyEmailToken(reg.token);
    expect(replay.ok).toBe(false);
    expect(await getStore().count("apiEmailVerifications", { developerId: reg.developer.id })).toBe(0);
  });

  it("rejects an expired token", async () => {
    const reg = await registerDeveloper({ email: EMAIL });
    if (!reg.ok) throw new Error("registration failed");
    const later = Date.now() + EMAIL_VERIFICATION_TTL_MS + 1000;
    const verified = await verifyEmailToken(reg.token, later);
    expect(verified.ok).toBe(false);
    if (verified.ok) return;
    expect(verified.code).toBe("expired_token");
  });

  it("rejects an unknown token", async () => {
    const verified = await verifyEmailToken("ipv_deadbeef");
    expect(verified.ok).toBe(false);
    if (verified.ok) return;
    expect(verified.code).toBe("invalid_token");
  });
});

describe("an unverified account cannot use a credential", () => {
  it("refuses authentication for a pending account even if a key exists", async () => {
    // Defence in depth: manufacture the state that must never authenticate.
    const { developer } = await createDeveloperWithKey({ name: "Pending" });
    await getStore().update("apiDevelopers", { id: developer.id }, { email: EMAIL, emailVerifiedAt: null });
    const issued = await issueApiKey(developer.id, { name: "k" });

    const res = await intentsGET(
      new Request("http://localhost/api/v1/intents", { headers: { authorization: `Bearer ${issued.key}` } }),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("forbidden");
  });

  it("leaves an operator-provisioned account (no email) unaffected", async () => {
    const { issued } = await createDeveloperWithKey({ name: "Operator" });
    const res = await intentsGET(
      new Request("http://localhost/api/v1/intents", { headers: { authorization: `Bearer ${issued.key}` } }),
    );
    expect(res.status).toBe(200);
  });
});

describe("POST /api/v1/developers/register", () => {
  it("fails honestly when no email provider is configured", async () => {
    process.env.INTENT_PAY_EMAIL_CAPTURE = "0";
    const res = await registerPOST(post("/api/v1/developers/register", { email: EMAIL }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("email_unavailable");
  });

  it("starts signup and emails a link (never returning the token)", async () => {
    const res = await registerPOST(post("/api/v1/developers/register", { name: "Acme", email: EMAIL }));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe("verification_sent");
    expect(JSON.stringify(body)).not.toMatch(/ipv_/);

    const mail = lastCapturedTo(EMAIL);
    expect(mail).toBeTruthy();
    expect(mail!.text).toMatch(/\/developer\/verify\?token=ipv_/);
  });

  it("is non-enumerating: same response for new, pending and verified addresses", async () => {
    const fresh = await registerPOST(post("/api/v1/developers/register", { email: EMAIL }));
    const pending = await registerPOST(post("/api/v1/developers/register", { email: EMAIL }));
    // Verify the account, then register the same (now verified) address.
    const row = await getStore().findOne("apiDevelopers", { email: EMAIL });
    await getStore().update("apiDevelopers", { id: row!.id }, { emailVerifiedAt: Date.now() });
    const verified = await registerPOST(post("/api/v1/developers/register", { email: EMAIL }));

    for (const res of [fresh, pending, verified]) {
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.status).toBe("verification_sent");
      expect(body.email).toBe(EMAIL);
    }
  });

  it("rejects an invalid email with a typed error", async () => {
    const res = await registerPOST(post("/api/v1/developers/register", { email: "not-an-email" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_request");
  });

  it("rate-limits repeated registrations", async () => {
    let limited = false;
    for (let i = 0; i < 8; i += 1) {
      const res = await registerPOST(post("/api/v1/developers/register", { email: `dev${i}@example.com` }));
      if (res.status === 429) {
        limited = true;
        expect(res.headers.get("Retry-After")).toBeTruthy();
        break;
      }
    }
    expect(limited).toBe(true);
  });

  it("refuses a cross-origin request", async () => {
    const res = await registerPOST(
      post("/api/v1/developers/register", { email: EMAIL }, { origin: "https://evil.example" }),
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /api/v1/developers/verify", () => {
  it("exchanges a token for a one-time key", async () => {
    const reg = await registerDeveloper({ email: EMAIL });
    if (!reg.ok) throw new Error("registration failed");
    const res = await verifyPOST(post("/api/v1/developers/verify", { token: reg.token }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.apiKey).toMatch(/^ipk_live_/);
    expect(typeof body.developer.emailVerifiedAt).toBe("string");
    expect(body.warning).toMatch(/shown once/i);
  });

  it("reports an invalid token and an expired token distinctly", async () => {
    const bad = await verifyPOST(post("/api/v1/developers/verify", { token: "ipv_nope" }));
    expect(bad.status).toBe(400);

    const reg = await registerDeveloper({ email: EMAIL });
    if (!reg.ok) throw new Error("registration failed");
    await getStore().update(
      "apiEmailVerifications",
      { developerId: reg.developer.id },
      { expiresAt: Date.now() - 1000 },
    );
    const expired = await verifyPOST(post("/api/v1/developers/verify", { token: reg.token }));
    expect(expired.status).toBe(410);
    expect((await expired.json()).error.code).toBe("expired");
  });
});

describe("POST /api/v1/developers/resend", () => {
  it("re-sends for a pending account and stays non-enumerating for an unknown one", async () => {
    await registerDeveloper({ email: EMAIL });
    clearCapturedEmails();
    const known = await resendPOST(post("/api/v1/developers/resend", { email: EMAIL }));
    const unknown = await resendPOST(post("/api/v1/developers/resend", { email: "nobody@example.com" }));
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    // The only difference is the address the caller themselves submitted; the
    // status and message never reveal whether an account exists.
    const k = await known.json();
    const u = await unknown.json();
    const { email: kEmail, ...kRest } = k;
    const { email: uEmail, ...uRest } = u;
    expect(kEmail).toBe(EMAIL);
    expect(uEmail).toBe("nobody@example.com");
    expect(kRest).toEqual(uRest);
    expect(lastCapturedTo(EMAIL)).toBeTruthy();
    expect(lastCapturedTo("nobody@example.com")).toBeUndefined();
  });
});

describe("key management stays within the tenant", () => {
  it("lists, rotates and revokes only the caller's own keys", async () => {
    const { developer, issued } = await createDeveloperWithKey({ name: "Mine" });
    const { issued: otherKey } = await createDeveloperWithKey({ name: "Other" });

    const list = await developersGET(
      new Request("http://localhost/api/v1/developers", { headers: { authorization: `Bearer ${issued.key}` } }),
    );
    expect(list.status).toBe(200);
    const listed = await list.json();
    expect(listed.keys).toHaveLength(1);
    expect(listed.developer.id).toBe(developer.id);

    // Cannot rotate another tenant's key.
    const otherList = await developersGET(
      new Request("http://localhost/api/v1/developers", { headers: { authorization: `Bearer ${otherKey.key}` } }),
    );
    const otherKeyId = (await otherList.json()).keys[0].id;
    const forbidden = await keysPOST(
      post("/api/v1/developers/keys", { action: "rotate", keyId: otherKeyId }, { authorization: `Bearer ${issued.key}` }),
    );
    expect(forbidden.status).toBe(404);

    // Rotate own key → old key stops working.
    const rotated = await keysPOST(
      post("/api/v1/developers/keys", { action: "rotate", keyId: issued.record.id }, { authorization: `Bearer ${issued.key}` }),
    );
    expect(rotated.status).toBe(201);
    const newKey = (await rotated.json()).key as string;
    const oldKeyRejected = await intentsGET(
      new Request("http://localhost/api/v1/intents", { headers: { authorization: `Bearer ${issued.key}` } }),
    );
    expect(oldKeyRejected.status).toBe(401);
    const newKeyWorks = await intentsGET(
      new Request("http://localhost/api/v1/intents", { headers: { authorization: `Bearer ${newKey}` } }),
    );
    expect(newKeyWorks.status).toBe(200);
  });
});

describe("operator provisioning still works and reports email honestly", () => {
  it("requires the admin token in production and marks a supplied email verified", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    process.env.INTENT_PAY_ADMIN_TOKEN = ADMIN;
    const res = await developersPOST(
      post("/api/v1/developers", { name: "Acme", email: "ops@example.com" }, { authorization: `Bearer ${ADMIN}` }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.apiKey).toMatch(/^ipk_live_/);
    expect(body.developer.email).toBe("ops@example.com");
    // Operator-vouched email is immediately usable.
    const authed = await intentsGET(
      new Request("http://localhost/api/v1/intents", { headers: { authorization: `Bearer ${body.apiKey}` } }),
    );
    expect(authed.status).toBe(200);
  });
});

describe("capabilities reports the signup model honestly", () => {
  it("advertises self-serve signup with email verification", async () => {
    const res = await capabilitiesGET();
    const body = await res.json();
    expect(body.auth.signup).toBe("self_serve");
    expect(body.auth.signupRequiresEmailVerification).toBe(true);
    expect(body.auth.emailVerificationConfigured).toBe(true); // capture transport is on in this test
    expect(body.endpoints.some((e: { path: string }) => e.path === "/api/v1/developers/register")).toBe(true);
    expect(body.endpoints.some((e: { path: string }) => e.path === "/api/v1/developers/verify")).toBe(true);
  });
});

describe("email transport is honest about configuration", () => {
  it("reports none when unconfigured and refuses to send", async () => {
    process.env.INTENT_PAY_EMAIL_CAPTURE = "0";
    expect(emailConfigured()).toBe(false);
    expect(emailTransportKind()).toBe("none");
    const sent = await sendEmail({ to: EMAIL, subject: "x", text: "y" });
    expect(sent.ok).toBe(false);
  });

  it("prefers resend when a key and from-address are set", () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.EMAIL_FROM = "no-reply@intent-pay.example";
    expect(emailTransportKind()).toBe("resend");
    expect(emailConfigured()).toBe(true);
  });

  it("never enables the capture transport in production", () => {
    process.env.INTENT_PAY_EMAIL_CAPTURE = "1";
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    expect(captureEnabled()).toBe(false);
    expect(getCapturedEmails()).toHaveLength(0);
  });
});

describe("the store schema carries the new invariants", () => {
  it("is at version 6 with a matching migration", () => {
    expect(SCHEMA_VERSION).toBe(6);
    expect(MIGRATIONS.some((m) => m.id === 6)).toBe(true);
  });

  it("enforces one account per verified email", async () => {
    const a = await registerDeveloper({ email: EMAIL });
    if (!a.ok) throw new Error("registration failed");
    // A second, differently-named account cannot take the same email.
    await expect(
      getStore().insert("apiDevelopers", {
        id: "dev_manual",
        name: "Squatter",
        email: EMAIL,
        emailVerifiedAt: null,
        status: "active",
        paymentXpub: null,
        nextDerivationIndex: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    ).rejects.toThrow();
  });
});
