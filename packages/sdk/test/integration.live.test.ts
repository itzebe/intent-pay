import { describe, expect, it } from "vitest";
import { IntentPay } from "../src/index.js";

/**
 * Live API integration tests.
 *
 * These run against a real Intent Pay deployment and are **skipped** unless both
 * `INTENTPAY_BASE_URL` and `INTENTPAY_API_KEY` are set, so the default test run
 * needs no network and no credential:
 *
 *     INTENTPAY_BASE_URL=http://localhost:3000 \
 *     INTENTPAY_API_KEY=ipk_live_… \
 *     npx vitest run test/integration.live.test.ts
 *
 * A live run creates a real intent, validates it, prepares a real transaction
 * plan against live Monad routing, and verifies an unknown hash (which must come
 * back `not_found`, never a fabricated success). It never signs or broadcasts —
 * there is no wallet in this process, and the SDK has no code path that could.
 */

const baseUrl = process.env.INTENTPAY_BASE_URL;
const apiKey = process.env.INTENTPAY_API_KEY;
const RECIPIENT = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4";
const FAKE_HASH = "0x" + "1".repeat(64);

const enabled = Boolean(baseUrl && apiKey);
const suite = enabled ? describe : describe.skip;

suite("live API integration", () => {
  const client = () => new IntentPay({ apiKey: apiKey!, baseUrl: baseUrl!, timeoutMs: 30_000 });

  it("reports capabilities for Monad Mainnet", async () => {
    const caps = await client().getCapabilities();
    expect(caps.ok).toBe(true);
    expect(caps.network.chainId).toBe(143);
    expect(caps.networks.map((n) => n.chainId)).toEqual([143]);
    expect(caps.intentStates).toContain("verified");
    expect(caps.webhookEvents).toContain("payment.verified");
    expect(caps.features.credentialCanSign).toBe(false);
  });

  it("walks create → validate → prepare → authorize → submit → verify", async () => {
    const c = client();
    const idempotencyKey = `it-${Date.now()}`;

    const created = await c.createIntent({
      recipient: RECIPIENT,
      receiveToken: "USDC",
      amount: "1",
      idempotencyKey,
    });
    expect(created.created).toBe(true);
    expect(created.intent.state).toBe("created");
    const id = created.intent.id;

    // A replay with the same key returns the same intent, not a new one.
    const replay = await c.createIntent({ recipient: RECIPIENT, receiveToken: "USDC", amount: "1", idempotencyKey });
    expect(replay.created).toBe(false);
    expect(replay.intent.id).toBe(id);

    const validated = await c.validateIntent(id);
    expect(validated.valid).toBe(true);
    expect(validated.state).toBe("validated");

    const prepared = await c.prepareTransaction(id, { sender: RECIPIENT });
    expect(prepared.state).toBe("prepared");
    expect(prepared.calls.length).toBeGreaterThan(0);
    expect(prepared.calls[0]!.to).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(prepared.calls[0]!.data).toMatch(/^0x/);
    expect(prepared.fingerprint).toBeTruthy();
    // Preparation must not be reported as a payment.
    expect(prepared.note).toMatch(/prepared only/i);

    const authorized = await c.authorizeIntent(id);
    expect(authorized.state).toBe("awaiting_authorization");
    expect(authorized.intent.authorized).toBe(true);

    const submitted = await c.submitTransaction(id, { txHash: FAKE_HASH });
    expect(submitted.txHashes).toEqual([FAKE_HASH]);
    expect(submitted.intent.state).toBe("submitted");

    // An unknown hash must be honest — never a fabricated success.
    const verified = await c.verifySettlement(id, { txHash: FAKE_HASH });
    expect(verified.verdict).toBe("not_found");
    expect(verified.state).toBe("submitted");
    expect(verified.retryable).toBe(true);

    const status = await c.getPaymentStatus(id);
    expect(status.settled).toBe(false);
    expect(status.failed).toBe(false);
  });

  it("refuses a non-Monad chain", async () => {
    await expect(
      client().createIntent({ recipient: RECIPIENT, receiveToken: "USDC", amount: "1", chainId: 1 }),
    ).rejects.toMatchObject({ code: "invalid_chain" });
  });

  it("refuses an unauthenticated call", async () => {
    const anon = new IntentPay({ baseUrl: baseUrl! });
    await expect(anon.listIntents()).rejects.toMatchObject({ code: "client_missing_credential" });
  });

  it("rejects a bad credential with unauthorized", async () => {
    const bad = new IntentPay({ apiKey: "ipk_live_aaaaaaaaaaaa." + "0".repeat(32), baseUrl: baseUrl!, maxRetries: 0 });
    await expect(bad.listIntents()).rejects.toMatchObject({ code: "unauthorized", status: 401 });
  });
});
