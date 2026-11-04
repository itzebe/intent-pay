import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore, SqliteStore, setStore } from "@/lib/store";

import { POST as developersPOST } from "@/app/api/v1/developers/route";
import { GET as intentsGET } from "@/app/api/v1/intents/route";

/**
 * Self-serve developer provisioning (`POST /api/v1/developers`).
 *
 * This is the only way an outside integrator can mint an API key, and it is the
 * gate that keeps production from becoming an open signup. Two properties matter
 * and are asserted here:
 *
 *   - in production it is **closed** unless the operator has configured
 *     `INTENT_PAY_ADMIN_TOKEN`, and then it needs the correct token (a missing
 *     secret must never mean "no auth");
 *   - the key it returns is immediately usable to authenticate the API.
 *
 * A missing admin token must fail *closed* (403), never open.
 */

const ADMIN = "test-admin-token-0123456789";

function req(opts: { authorization?: string; body?: unknown } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.authorization) headers.authorization = opts.authorization;
  return new Request("http://localhost/api/v1/developers", {
    method: "POST",
    headers,
    body: opts.body === undefined ? JSON.stringify({ name: "Acme" }) : JSON.stringify(opts.body),
  });
}

let savedNodeEnv: string | undefined;
let savedAdmin: string | undefined;

beforeEach(() => {
  process.env.INTENT_PAY_DB_PATH = "/data/intent-pay.sqlite";
  setStore(new SqliteStore(":memory:"));
  savedNodeEnv = process.env.NODE_ENV;
  savedAdmin = process.env.INTENT_PAY_ADMIN_TOKEN;
});

afterEach(() => {
  delete process.env.INTENT_PAY_DB_PATH;
  setStore(new MemoryStore());
  if (savedNodeEnv === undefined) delete (process.env as Record<string, string | undefined>).NODE_ENV;
  else (process.env as Record<string, string | undefined>).NODE_ENV = savedNodeEnv;
  if (savedAdmin === undefined) delete process.env.INTENT_PAY_ADMIN_TOKEN;
  else process.env.INTENT_PAY_ADMIN_TOKEN = savedAdmin;
});

describe("developer provisioning", () => {
  it("fails closed in production when no admin token is configured", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    delete process.env.INTENT_PAY_ADMIN_TOKEN;
    const res = await developersPOST(req());
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error.code).toBe("forbidden");
  });

  it("refuses a wrong admin token in production", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    process.env.INTENT_PAY_ADMIN_TOKEN = ADMIN;
    const res = await developersPOST(req({ authorization: "Bearer not-the-token" }));
    expect(res.status).toBe(403);
  });

  it("issues a working key with the correct admin token in production", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    process.env.INTENT_PAY_ADMIN_TOKEN = ADMIN;
    const res = await developersPOST(req({ authorization: `Bearer ${ADMIN}` }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.apiKey).toMatch(/^ipk_live_/);
    expect(json.developer.id).toMatch(/^dev_/);

    // The freshly issued key authenticates the API immediately.
    const authed = await intentsGET(
      new Request("http://localhost/api/v1/intents", { headers: { authorization: `Bearer ${json.apiKey}` } }),
    );
    expect(authed.status).toBe(200);
  });

  it("is open outside production so the API is easy to try locally", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "development";
    delete process.env.INTENT_PAY_ADMIN_TOKEN;
    const res = await developersPOST(req());
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.apiKey).toMatch(/^ipk_live_/);
  });
});
