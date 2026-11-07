import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore, SqliteStore, setStore } from "@/lib/store";
import {
  canTransition,
  isTerminal,
  isAuthorizedOrBeyond,
  STATE_EVENT,
  INTENT_STATES,
  WEBHOOK_EVENTS,
  isWebhookEvent,
  type IntentState,
} from "@/lib/developer/intentLifecycle";
import { canonicalParams, createIntent, currentState, freezeParams, getIntent, intentFingerprint, transition } from "@/lib/developer/intents";

/**
 * The intent lifecycle state machine.
 *
 * These tests pin the two load-bearing rules: a prepared transaction is not a
 * payment, and a submitted/confirmed transaction is not a verified settlement.
 * They also prove the state can only be advanced through a legal edge, and that
 * the frozen parameters are immutable once set.
 */

const RECIPIENT = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4";

beforeEach(() => {
  setStore(new SqliteStore(":memory:"));
});
afterEach(() => {
  setStore(new MemoryStore());
});

async function makeIntent() {
  const store = new SqliteStore(":memory:");
  setStore(store);
  // A real developer row is required by the foreign key.
  await store.insert("apiDevelopers", { id: "dev_1", name: "Test", email: null, emailVerifiedAt: null, status: "active", paymentXpub: null, nextDerivationIndex: 0, createdAt: Date.now(), updatedAt: Date.now() });
  const result = await createIntent({
    developerId: "dev_1",
    createdByKeyId: "key_1",
    chainId: 143,
    recipient: RECIPIENT,
    receiveToken: "USDC",
    receiveTokenAddress: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
    amountMode: "recipient_receives",
    amount: "5",
  });
  if (!result.ok) throw new Error("create failed");
  return result.intent;
}

describe("state machine", () => {
  it("allows the happy path and forbids skipping steps", () => {
    expect(canTransition("created", "validating")).toBe(true);
    expect(canTransition("validating", "validated")).toBe(true);
    expect(canTransition("validated", "prepared")).toBe(true);
    expect(canTransition("prepared", "awaiting_authorization")).toBe(true);
    expect(canTransition("awaiting_authorization", "submitted")).toBe(true);
    expect(canTransition("submitted", "confirmed")).toBe(true);
    expect(canTransition("confirmed", "verified")).toBe(true);
    // No skipping: you cannot verify what was never submitted.
    expect(canTransition("created", "verified")).toBe(false);
    expect(canTransition("prepared", "submitted")).toBe(false);
    expect(canTransition("submitted", "verified")).toBe(false);
    expect(canTransition("created", "prepared")).toBe(false);
  });

  it("treats verified/rejected/expired/failed as terminal", () => {
    for (const s of ["verified", "rejected", "expired", "failed"] as IntentState[]) {
      expect(isTerminal(s)).toBe(true);
    }
    expect(isTerminal("submitted")).toBe(false);
  });

  it("marks authorization and everything past it as frozen", () => {
    expect(isAuthorizedOrBeyond("prepared")).toBe(false);
    expect(isAuthorizedOrBeyond("awaiting_authorization")).toBe(true);
    expect(isAuthorizedOrBeyond("submitted")).toBe(true);
    expect(isAuthorizedOrBeyond("verified")).toBe(true);
  });

  it("maps every webhook event to exactly one state", () => {
    const events = Object.values(STATE_EVENT);
    expect(new Set(events).size).toBe(events.length);
    for (const e of events) expect(isWebhookEvent(e!)).toBe(true);
    expect(WEBHOOK_EVENTS).toContain("payment.verified");
    expect(INTENT_STATES).toContain("awaiting_authorization");
  });
});

describe("intent persistence and transitions", () => {
  it("starts created and advances only through legal edges", async () => {
    const intent = await makeIntent();
    expect(await currentState(intent.id)).toBe("created");

    const bad = await transition(intent, "verified");
    expect(bad.ok).toBe(false);
    expect(await currentState(intent.id)).toBe("created");

    expect((await transition(intent, "validating")).ok).toBe(true);
    expect((await transition(intent, "validated")).ok).toBe(true);
    expect(await currentState(intent.id)).toBe("validated");
  });

  it("is tenant-scoped: another developer cannot read the intent", async () => {
    const intent = await makeIntent();
    expect(await getIntent("dev_1", intent.id)).toBeTruthy();
    expect(await getIntent("dev_2", intent.id)).toBeNull();
  });

  it("freezes the parameters and never mutates them afterwards", async () => {
    const intent = await makeIntent();
    expect(intent.authorizedParams).toBeNull();
    await freezeParams(intent);
    const frozen = intent.authorizedParams;
    expect(frozen).toBe(canonicalParams(intent));
    // Freezing again is a no-op.
    await freezeParams(intent);
    expect(intent.authorizedParams).toBe(frozen);
    const fp = intentFingerprint(intent);
    expect(fp).toMatch(/^int_[0-9a-f]{8}$/);
  });

  it("produces a stable fingerprint from the frozen parameters", async () => {
    const intent = await makeIntent();
    const before = intentFingerprint(intent);
    await freezeParams(intent);
    expect(intentFingerprint(intent)).toBe(before);
  });
});
