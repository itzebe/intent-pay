import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getStore } from "@/lib/store";
import type { ApiDeveloperRecord, ApiKeyRecord } from "@/lib/store/types";
import { newApiKeyId, newDeveloperId } from "./ids";

/**
 * Developer credentials.
 *
 * An external application authenticates with an API key of the form
 *
 *     ipk_<environment>_<prefix>.<secret>
 *
 * `ipk` is the scheme marker, `<environment>` is `live` or `test`, `<prefix>` is
 * a public, non-secret handle used to look the key up, and `<secret>` is the
 * only part that proves possession. **Only a salted hash of the secret is
 * stored** — the plaintext secret is returned exactly once, at creation, and is
 * never persisted, logged, or included in any API response afterwards.
 *
 * Hashing uses SHA-256 with a per-key random salt. A password hash (bcrypt/
 * scrypt) is deliberately *not* used here: an API key is a 256-bit random value,
 * not a human-chosen password, so it has no guessable structure and needs no
 * work factor. The comparison is constant-time.
 */

const SCHEME = "ipk";
/** The public prefix length. Long enough to avoid collisions, short enough to show. */
const PREFIX_LEN = 12;
const SECRET_BYTES = 32;

export type ApiKeyEnvironment = "live" | "test";

/** The one-time result of creating a key: the plaintext secret is here and nowhere else. */
export type IssuedApiKey = {
  /** The full key, shown once. */
  key: string;
  record: ApiKeyRecord;
};

function hashSecret(secret: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${secret}`).digest("hex");
}

/** The public, non-secret prefix embedded in a key string. */
export function parseApiKey(key: string): { prefix: string; secret: string; environment: ApiKeyEnvironment } | null {
  // ipk_<env>_<prefix>.<secret>
  const m = /^ipk_(live|test)_([0-9a-z]{6,32})\.([0-9a-z]{16,128})$/.exec((key ?? "").trim());
  if (!m) return null;
  return { environment: m[1] as ApiKeyEnvironment, prefix: m[2], secret: m[3] };
}

/**
 * Create a developer account and its first API key.
 *
 * `environment` defaults to "live"; pass "test" for a development key. The
 * plaintext key is returned once and must be stored by the caller.
 */
export async function createDeveloperWithKey(input: {
  name: string;
  email?: string | null;
  emailVerifiedAt?: number | null;
  environment?: ApiKeyEnvironment;
  keyName?: string;
  now?: number;
}): Promise<{ developer: ApiDeveloperRecord; issued: IssuedApiKey }> {
  const now = input.now ?? Date.now();
  const store = getStore();
  const developer: ApiDeveloperRecord = {
    id: newDeveloperId(),
    name: input.name.slice(0, 120) || "developer",
    email: input.email ?? null,
    emailVerifiedAt: input.emailVerifiedAt ?? null,
    status: "active",
    paymentXpub: null,
    nextDerivationIndex: 0,
    createdAt: now,
    updatedAt: now,
  };
  await store.insert("apiDevelopers", developer);
  const issued = await issueApiKey(developer.id, {
    name: input.keyName ?? "Default key",
    environment: input.environment ?? "live",
    now,
  });
  return { developer, issued };
}

/** Issue an additional key for an existing developer. */
export async function issueApiKey(
  developerId: string,
  input: { name: string; environment?: ApiKeyEnvironment; expiresAt?: number | null; now?: number },
): Promise<IssuedApiKey> {
  const now = input.now ?? Date.now();
  const store = getStore();
  const environment = input.environment ?? "live";
  const prefix = randomBytes(9).toString("hex").slice(0, PREFIX_LEN);
  const secret = randomBytes(SECRET_BYTES).toString("hex");
  const salt = randomBytes(16).toString("hex");
  const record: ApiKeyRecord = {
    id: newApiKeyId(),
    developerId,
    name: input.name.slice(0, 120) || "key",
    prefix,
    secretHash: hashSecret(secret, salt),
    salt,
    environment,
    status: "active",
    expiresAt: input.expiresAt ?? null,
    createdAt: now,
    lastUsedAt: null,
    revokedAt: null,
    updatedAt: now,
  };
  await store.insert("apiKeys", record);
  return { key: `${SCHEME}_${environment}_${prefix}.${secret}`, record };
}

/**
 * Rotate a key: revoke the old one and issue a replacement with the same name,
 * environment and expiry. Returns the new plaintext key once.
 */
export async function rotateApiKey(keyId: string, now = Date.now()): Promise<IssuedApiKey | null> {
  const store = getStore();
  const existing = await store.findOne("apiKeys", { id: keyId });
  if (!existing) return null;
  await store.update("apiKeys", { id: keyId }, { status: "revoked", revokedAt: now, updatedAt: now });
  return issueApiKey(existing.developerId, {
    name: existing.name,
    environment: existing.environment as ApiKeyEnvironment,
    expiresAt: existing.expiresAt,
    now,
  });
}

/** Revoke a key. Idempotent. */
export async function revokeApiKey(keyId: string, now = Date.now()): Promise<boolean> {
  const store = getStore();
  const existing = await store.findOne("apiKeys", { id: keyId });
  if (!existing) return false;
  if (existing.status !== "revoked") {
    await store.update("apiKeys", { id: keyId }, { status: "revoked", revokedAt: now, updatedAt: now });
  }
  return true;
}

/** Keys owned by a developer, newest first. Never includes a hash or salt. */
export async function listApiKeys(developerId: string): Promise<Array<Omit<ApiKeyRecord, "secretHash" | "salt">>> {
  const rows = await getStore().findMany("apiKeys", { developerId }, { orderBy: "createdAt", dir: "desc" });
  return rows.map(({ secretHash: _h, salt: _s, ...rest }) => rest);
}

export type AuthenticatedDeveloper = {
  developer: ApiDeveloperRecord;
  key: ApiKeyRecord;
};

export type AuthFailure = {
  ok: false;
  code: "unauthorized" | "forbidden";
  message: string;
};

export type AuthResult = { ok: true; value: AuthenticatedDeveloper } | AuthFailure;

/** The environment marker that marks a development/test key. */
export const TEST_KEY_ENVIRONMENT: ApiKeyEnvironment = "test";

/**
 * Authenticate a raw API key.
 *
 * Fails closed at every step: an unknown prefix, a wrong secret, a revoked or
 * expired key, or a suspended developer all return `unauthorized` with the same
 * shape, so the response cannot be used to probe which prefixes exist. A **test**
 * key is refused when running in production unless the explicit
 * `INTENT_PAY_ALLOW_TEST_KEYS` override is set — so a development credential can
 * never become a production bypass by accident.
 */
export async function authenticateApiKey(
  rawKey: string | null | undefined,
  now = Date.now(),
): Promise<AuthResult> {
  const parsed = parseApiKey(rawKey ?? "");
  if (!parsed) return { ok: false, code: "unauthorized", message: "A valid API key is required." };

  const store = getStore();
  const record = await store.findOne("apiKeys", { prefix: parsed.prefix });
  if (!record) return { ok: false, code: "unauthorized", message: "Invalid API key." };

  // Constant-time secret comparison, even though the lookup already succeeded.
  const expected = Buffer.from(record.secretHash, "hex");
  const actual = Buffer.from(hashSecret(parsed.secret, record.salt), "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, code: "unauthorized", message: "Invalid API key." };
  }

  if (record.status !== "active") return { ok: false, code: "unauthorized", message: "This API key has been revoked." };
  if (record.expiresAt !== null && record.expiresAt < now) {
    return { ok: false, code: "unauthorized", message: "This API key has expired." };
  }
  if (parsed.environment !== record.environment) {
    return { ok: false, code: "unauthorized", message: "Invalid API key." };
  }

  // A test key must never authenticate against production.
  if (record.environment === TEST_KEY_ENVIRONMENT && isProduction() && !testKeysAllowed()) {
    return {
      ok: false,
      code: "forbidden",
      message: "Test API keys are not accepted in production.",
    };
  }

  const developer = await store.findOne("apiDevelopers", { id: record.developerId });
  if (!developer) return { ok: false, code: "unauthorized", message: "Invalid API key." };
  if (developer.status !== "active") {
    return { ok: false, code: "forbidden", message: "This developer account is suspended." };
  }
  // A self-service account that has not proven its email holds no usable key.
  // (An admin-provisioned account has no email at all and is unaffected; a pending
  // account never receives a key in the first place — this is defence in depth.)
  const hasEmail = typeof developer.email === "string" && developer.email.length > 0;
  const verified = developer.emailVerifiedAt !== null && developer.emailVerifiedAt !== undefined;
  if (hasEmail && !verified) {
    return { ok: false, code: "forbidden", message: "Verify your email address before using this API key." };
  }

  // Best-effort usage stamp; a failure here must never fail authentication.
  try {
    await store.update("apiKeys", { id: record.id }, { lastUsedAt: now });
  } catch {
    /* ignore */
  }

  return { ok: true, value: { developer, key: record } };
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/** The explicit, deliberate override that lets test keys run outside dev. */
export function testKeysAllowed(): boolean {
  return process.env.INTENT_PAY_ALLOW_TEST_KEYS === "1";
}

/** Whether the current environment is production (for capability reporting). */
export function isProductionEnvironment(): boolean {
  return isProduction();
}
