import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore, SqliteStore, setStore } from "@/lib/store";
import {
  authenticateApiKey,
  createDeveloperWithKey,
  issueApiKey,
  parseApiKey,
  revokeApiKey,
  rotateApiKey,
} from "@/lib/developer/credentials";

/**
 * Developer credentials.
 *
 * The guarantees that matter: a key authenticates only with its real secret; the
 * secret is never stored (only a salted hash); a revoked/expired/suspended key
 * fails closed; a test key cannot authenticate in production; and rotation
 * invalidates the old key immediately.
 */
beforeEach(() => {
  process.env.INTENT_PAY_DB_PATH = "/data/intent-pay.sqlite";
  setStore(new SqliteStore(":memory:"));
});
afterEach(() => {
  delete process.env.INTENT_PAY_DB_PATH;
  delete process.env.INTENT_PAY_ALLOW_TEST_KEYS;
  (process.env as Record<string, string | undefined>).NODE_ENV = "test";
  setStore(new MemoryStore());
});

describe("api key format", () => {
  it("parses the scheme, environment, prefix and secret", () => {
    const parsed = parseApiKey("ipk_live_abcdef123456.deadbeefdeadbeefdeadbeef");
    expect(parsed).toMatchObject({ environment: "live", prefix: "abcdef123456", secret: "deadbeefdeadbeefdeadbeef" });
  });

  it("rejects malformed keys", () => {
    expect(parseApiKey("nope")).toBeNull();
    expect(parseApiKey("ipk_prod_abc.def")).toBeNull();
    expect(parseApiKey("")).toBeNull();
  });
});

describe("authentication", () => {
  it("authenticates a freshly issued key and returns its developer", async () => {
    const { developer, issued } = await createDeveloperWithKey({ name: "Acme" });
    const auth = await authenticateApiKey(issued.key);
    expect(auth.ok).toBe(true);
    if (auth.ok) {
      expect(auth.value.developer.id).toBe(developer.id);
      expect(auth.value.key.id).toBe(issued.record.id);
    }
  });

  it("never stores the plaintext secret", async () => {
    const store = new SqliteStore(":memory:");
    setStore(store);
    const { issued } = await createDeveloperWithKey({ name: "Acme" });
    const secret = parseApiKey(issued.key)!.secret;
    const row = await store.findOne("apiKeys", { prefix: parseApiKey(issued.key)!.prefix });
    expect(row).toBeTruthy();
    // The row holds a hash and a salt — never the secret itself.
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(row!.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.secretHash).not.toBe(secret);
  });

  it("rejects a wrong secret, an unknown prefix and a malformed key", async () => {
    const { issued } = await createDeveloperWithKey({ name: "Acme" });
    const parsed = parseApiKey(issued.key)!;
    expect((await authenticateApiKey(`ipk_live_${parsed.prefix}.${"0".repeat(48)}`)).ok).toBe(false);
    expect((await authenticateApiKey("ipk_live_aaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbb")).ok).toBe(false);
    expect((await authenticateApiKey("garbage")).ok).toBe(false);
    expect((await authenticateApiKey(null)).ok).toBe(false);
  });

  it("fails closed for a revoked key", async () => {
    const { issued } = await createDeveloperWithKey({ name: "Acme" });
    await revokeApiKey(issued.record.id);
    const auth = await authenticateApiKey(issued.key);
    expect(auth.ok).toBe(false);
  });

  it("fails closed for an expired key", async () => {
    const { developer } = await createDeveloperWithKey({ name: "Acme" });
    const { key } = await issueApiKey(developer.id, { name: "expiring", expiresAt: Date.now() - 1000 });
    const auth = await authenticateApiKey(key);
    expect(auth.ok).toBe(false);
  });

  it("fails closed for a suspended developer", async () => {
    const { developer, issued } = await createDeveloperWithKey({ name: "Acme" });
    const store = new SqliteStore(":memory:");
    setStore(store);
    const { developer: d2, issued: i2 } = await createDeveloperWithKey({ name: "Suspended" });
    void developer;
    void issued;
    void d2;
    await store.update("apiDevelopers", { id: d2.id }, { status: "suspended" });
    const auth = await authenticateApiKey(i2.key);
    expect(auth.ok).toBe(false);
    if (!auth.ok) expect(auth.code).toBe("forbidden");
  });
});

describe("environment separation", () => {
  it("refuses a test key in production", async () => {
    const { issued } = await createDeveloperWithKey({ name: "Acme", environment: "test" });
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    const auth = await authenticateApiKey(issued.key);
    expect(auth.ok).toBe(false);
    if (!auth.ok) expect(auth.code).toBe("forbidden");
  });

  it("accepts a test key in production only with the explicit override", async () => {
    const { issued } = await createDeveloperWithKey({ name: "Acme", environment: "test" });
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    process.env.INTENT_PAY_ALLOW_TEST_KEYS = "1";
    const auth = await authenticateApiKey(issued.key);
    expect(auth.ok).toBe(true);
  });
});

describe("rotation and revocation", () => {
  it("rotation revokes the old key and issues a working replacement", async () => {
    const { issued } = await createDeveloperWithKey({ name: "Acme" });
    const rotated = await rotateApiKey(issued.record.id);
    expect(rotated).toBeTruthy();
    expect((await authenticateApiKey(issued.key)).ok).toBe(false);
    expect((await authenticateApiKey(rotated!.key)).ok).toBe(true);
  });

  it("issuing a second key leaves the first working", async () => {
    const { developer, issued } = await createDeveloperWithKey({ name: "Acme" });
    const second = await issueApiKey(developer.id, { name: "second" });
    expect((await authenticateApiKey(issued.key)).ok).toBe(true);
    expect((await authenticateApiKey(second.key)).ok).toBe(true);
  });
});
