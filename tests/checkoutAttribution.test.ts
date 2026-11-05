import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { secp256k1 } from "@noble/curves/secp256k1";
import { checksumAddress, getAddress, keccak256 } from "viem";
import { publicKeyToAddress } from "viem/accounts";
import { MemoryStore, SqliteStore, setStore } from "@/lib/store";
import { getStore } from "@/lib/store";
import { createDeveloperWithKey } from "@/lib/developer/credentials";
import { createIntent } from "@/lib/developer/intents";
import { allocateAttributionAddress, setPaymentXpub, attributionDestination } from "@/lib/developer/attribution";
import { derivePaymentAddress, derivePaymentAddresses, validatePaymentXpub } from "@/lib/developer/xpub";
import { createCheckout, bindIntentForCheckout, expireCheckoutIfStale, verificationDestination, attributionInfo, publicCheckoutForCustomer } from "@/lib/developer/checkouts";
import { currentState } from "@/lib/developer/intents";

/**
 * Checkout-specific attribution.
 *
 * The load-bearing property: a payment may be accepted only when it landed at the
 * **destination this exact checkout defined**. When a merchant registers a
 * watch-only payment xpub, that destination is a unique address derived for the
 * order, so a transfer to any other address — the merchant's shared recipient
 * included — cannot settle it. Every test here is an attempt to defeat that and
 * is expected to fail to settle.
 *
 * The tests use the real SQLite store (unique constraints, the compare-and-swap
 * index reservation) and the real derivation, so a pass reflects production
 * behaviour rather than a mock's.
 */

// A BIP32 test vector xpub (public only — no spending key anywhere).
const TEST_XPUB =
  "xpub6Ce9NcJvTk36xtLSrJLZqE7wtgA5deCeYs7rSQtreh4cj6ByPtrg9sD7V2FNFLPnf8heNP3FGkeV9qwfzvZNSd54JoNXVsXFYSYwHsnJxqP";
const RECIPIENT = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4";
const USDC_ADDRESS = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";

beforeEach(() => {
  setStore(new SqliteStore(":memory:"));
});
afterEach(() => {
  setStore(new MemoryStore());
});

async function makeDeveloper(name = "Acme"): Promise<string> {
  const { developer } = await createDeveloperWithKey({ name });
  return developer.id;
}

async function makeIntent(developerId: string, recipient = RECIPIENT) {
  const result = await createIntent({
    developerId,
    createdByKeyId: "key_1",
    chainId: 143,
    recipient,
    receiveToken: "USDC",
    receiveTokenAddress: USDC_ADDRESS,
    amountMode: "recipient_receives",
    amount: "5",
  });
  if (!result.ok) throw new Error("intent create failed");
  return result.intent;
}

describe("xpub validation (no spending key is ever accepted)", () => {
  it("accepts a public extended key", () => {
    expect(validatePaymentXpub(TEST_XPUB).ok).toBe(true);
  });

  it("refuses a private extended key (xprv)", () => {
    const res = validatePaymentXpub("xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/private key/i);
  });

  it("refuses a seed phrase", () => {
    const res = validatePaymentXpub("seed abandon abandon abandon about");
    expect(res.ok).toBe(false);
  });

  it("refuses a malformed string", () => {
    expect(validatePaymentXpub("not-an-xpub").ok).toBe(false);
    expect(validatePaymentXpub("").ok).toBe(false);
  });

  it("refuses a testnet extended key (wrong network for Monad mainnet)", () => {
    const tpub = TEST_XPUB.replace(/^xpub/, "tpub");
    expect(validatePaymentXpub(tpub).ok).toBe(false);
  });
});

describe("watch-only derivation", () => {
  it("derives distinct, deterministic addresses", () => {
    const a0 = derivePaymentAddress(TEST_XPUB, 0);
    const a1 = derivePaymentAddress(TEST_XPUB, 1);
    expect(a0).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(a0).not.toBe(a1);
    // Deterministic: the same index always yields the same address.
    expect(derivePaymentAddress(TEST_XPUB, 0)).toBe(a0);
    expect(derivePaymentAddresses(TEST_XPUB, 0, 2)).toEqual([a0, a1]);
  });

  it("refuses a negative or fractional index", () => {
    expect(() => derivePaymentAddress(TEST_XPUB, -1)).toThrow();
    expect(() => derivePaymentAddress(TEST_XPUB, 1.5)).toThrow();
  });

  it("derives non-hardened children only (a hardened path cannot be derived from an xpub)", () => {
    // `derivePaymentAddress` uses the non-hardened branch `m/0/<index>`; the
    // library refuses a hardened step from a public key, which is the boundary
    // that keeps a leaked xpub from reaching the merchant's other accounts.
    expect(() => derivePaymentAddress(TEST_XPUB, 0)).not.toThrow();
    const root = HDKey.fromExtendedKey(TEST_XPUB);
    expect(() => root.derive("m/0'")).toThrow();
  });
});

/**
 * The derivation must agree with the merchant's own wallet. These are *known*
 * addresses from the canonical Hardhat/Anvil test mnemonic
 * (`test test test … junk`), whose `m/44'/60'/0'` account xpub is `TEST_XPUB`.
 * `m/0/<i>` from that account xpub is exactly the merchant wallet's normal
 * receive path (`m/44'/60'/0'/0/<i>`), so the expected values are fixed by an
 * independent implementation, not by ours.
 *
 * The address is the last 20 bytes of `keccak256` over the **uncompressed** key.
 * A regression here — hashing the compressed point instead — yields addresses
 * the merchant cannot spend from, so a literal-vector assertion is the only
 * thing that catches it (a self-consistent "two derivations agree" check cannot).
 */
describe("known-address vectors (the merchant's wallet controls every destination)", () => {
  const VECTORS: [number, string][] = [
    [0, "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"],
    [1, "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"],
    [2, "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"],
  ];

  it("derives the merchant's real receive addresses for indices 0, 1, 2", () => {
    for (const [index, expected] of VECTORS) {
      expect(derivePaymentAddress(TEST_XPUB, index)).toBe(expected);
    }
  });

  it("agrees with a full-path derivation from the mnemonic (m/44'/60'/0'/0/i)", () => {
    const master = HDKey.fromMasterSeed(
      mnemonicToSeedSync("test test test test test test test test test test test junk"),
    );
    for (const [index, expected] of VECTORS) {
      const full = master.derive(`m/44'/60'/0'/0/${index}`);
      const body = Buffer.from(secp256k1.ProjectivePoint.fromHex(full.publicKey!).toRawBytes(false))
        .toString("hex")
        .slice(2);
      expect(derivePaymentAddress(TEST_XPUB, index)).toBe(checksumAddress(`0x${keccak256(`0x${body}`).slice(-40)}`));
      expect(derivePaymentAddress(TEST_XPUB, index)).toBe(expected);
    }
  });

  it("returns a checksum-valid address that round-trips through getAddress", () => {
    const address = derivePaymentAddress(TEST_XPUB, 0) as `0x${string}`;
    // A wrong (compressed-key) derivation still *looks* like an address, so the
    // guard is the literal vector above; here we pin the EIP-55 checksum shape.
    expect(getAddress(address)).toBe(address);
    expect(address).toBe(checksumAddress(address));
  });
});

describe("index reservation (unique destination per checkout)", () => {
  it("hands out each index exactly once", async () => {
    const dev = await makeDeveloper();
    await setPaymentXpub(dev, TEST_XPUB);
    const a = await allocateAttributionAddress(dev);
    const b = await allocateAttributionAddress(dev);
    expect(a?.index).toBe(0);
    expect(b?.index).toBe(1);
    expect(a?.address).not.toBe(b?.address);
    // Derivation is case-insensitive for identity; the checkout record stores lower-case.
    expect(a?.address.toLowerCase()).toBe(derivePaymentAddress(TEST_XPUB, 0).toLowerCase());
  });

  it("returns null when no xpub is registered (honest fallback)", async () => {
    const dev = await makeDeveloper();
    expect(await allocateAttributionAddress(dev)).toBeNull();
  });

  it("reserves unique indices under concurrency", async () => {
    const dev = await makeDeveloper();
    await setPaymentXpub(dev, TEST_XPUB);
    const results = await Promise.all(Array.from({ length: 8 }, () => allocateAttributionAddress(dev)));
    const indices = results.map((r) => r!.index).sort((x, y) => x - y);
    expect(indices).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    const addresses = new Set(results.map((r) => r!.address.toLowerCase()));
    expect(addresses.size).toBe(8);
  });

  it("refuses to register a private key or seed", async () => {
    const dev = await makeDeveloper();
    const res = await setPaymentXpub(dev, "xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi");
    expect(res.ok).toBe(false);
    const cleared = await getStore().findOne("apiDevelopers", { id: dev });
    expect(cleared?.paymentXpub).toBeNull();
  });

  it("can clear a registered xpub", async () => {
    const dev = await makeDeveloper();
    await setPaymentXpub(dev, TEST_XPUB);
    const res = await setPaymentXpub(dev, null);
    expect(res.ok).toBe(true);
    const cleared = await getStore().findOne("apiDevelopers", { id: dev });
    expect(cleared?.paymentXpub).toBeNull();
  });
});

describe("checkout binding to a unique destination", () => {
  it("gives a checkout-bound order its own derived destination", async () => {
    const dev = await makeDeveloper();
    await setPaymentXpub(dev, TEST_XPUB);
    const intent = await makeIntent(dev);
    const result = await createCheckout(intent, { developerId: dev, intentId: intent.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { checkout } = result;
    expect(checkout.attributionAddress).toBe(derivePaymentAddress(TEST_XPUB, 0).toLowerCase());
    expect(checkout.derivationIndex).toBe(0);
    expect(attributionInfo(checkout).mode).toBe("checkout_bound");
  });

  it("falls back to shared_recipient when no xpub is registered", async () => {
    const dev = await makeDeveloper();
    const intent = await makeIntent(dev);
    const result = await createCheckout(intent, { developerId: dev, intentId: intent.id });
    if (!result.ok) throw new Error("create failed");
    expect(result.checkout.attributionAddress).toBeNull();
    expect(attributionInfo(result.checkout).mode).toBe("shared_recipient");
  });

  it("reports the required destination as the derived address for a bound order", async () => {
    const dev = await makeDeveloper();
    await setPaymentXpub(dev, TEST_XPUB);
    const intent = await makeIntent(dev);
    const result = await createCheckout(intent, { developerId: dev, intentId: intent.id });
    if (!result.ok) throw new Error("create failed");
    const expected = derivePaymentAddress(TEST_XPUB, 0).toLowerCase();
    expect(verificationDestination(result.checkout, intent)).toBe(expected);
    expect(attributionInfo(result.checkout).destination).toBe(expected);
  });

  it("rewrites the intent recipient to the derived destination before freezing", async () => {
    const dev = await makeDeveloper();
    await setPaymentXpub(dev, TEST_XPUB);
    const intent = await makeIntent(dev);
    const result = await createCheckout(intent, { developerId: dev, intentId: intent.id });
    if (!result.ok) throw new Error("create failed");
    await bindIntentForCheckout(intent, result.checkout.attributionAddress);
    const reloaded = await getStore().findOne("apiIntents", { id: intent.id });
    expect(reloaded?.recipient).toBe(derivePaymentAddress(TEST_XPUB, 0).toLowerCase());
  });

  it("never reuses a destination across orders", async () => {
    const dev = await makeDeveloper();
    await setPaymentXpub(dev, TEST_XPUB);
    const i1 = await makeIntent(dev);
    const c1 = await createCheckout(i1, { developerId: dev, intentId: i1.id });
    const i2 = await makeIntent(dev);
    const c2 = await createCheckout(i2, { developerId: dev, intentId: i2.id });
    if (!c1.ok || !c2.ok) throw new Error("create failed");
    expect(c1.checkout.attributionAddress).not.toBe(c2.checkout.attributionAddress);
  });
});

describe("public checkout view (customer sees the real destination)", () => {
  it("shows the derived destination as the recipient", async () => {
    const dev = await makeDeveloper();
    await setPaymentXpub(dev, TEST_XPUB);
    const intent = await makeIntent(dev);
    const result = await createCheckout(intent, { developerId: dev, intentId: intent.id });
    if (!result.ok) throw new Error("create failed");
    await bindIntentForCheckout(intent, result.checkout.attributionAddress);
    const state = await currentState(intent.id);
    const view = publicCheckoutForCustomer(result.checkout, intent, state) as Record<string, unknown>;
    expect(view.recipient).toBe(derivePaymentAddress(TEST_XPUB, 0).toLowerCase());
    expect((view.attribution as { mode: string }).mode).toBe("checkout_bound");
  });

  it("shows the shared recipient when attribution is off", async () => {
    const dev = await makeDeveloper();
    const intent = await makeIntent(dev);
    const result = await createCheckout(intent, { developerId: dev, intentId: intent.id });
    if (!result.ok) throw new Error("create failed");
    await bindIntentForCheckout(intent, result.checkout.attributionAddress);
    const state = await currentState(intent.id);
    const view = publicCheckoutForCustomer(result.checkout, intent, state) as Record<string, unknown>;
    expect((view.recipient as string).toLowerCase()).toBe(RECIPIENT.toLowerCase());
    expect((view.attribution as { mode: string }).mode).toBe("shared_recipient");
  });
});

describe("attributionDestination helper", () => {
  it("normalizes a destination and treats blank as null", () => {
    expect(attributionDestination("0xABC")).toBe("0xabc");
    expect(attributionDestination(null)).toBeNull();
    expect(attributionDestination("   ")).toBeNull();
  });
});

/**
 * Healing a destination produced by the superseded compressed-key derivation.
 *
 * A pre-fix order stored a destination that was keccak-hashed over the 33-byte
 * compressed key instead of the 64-byte uncompressed point, so it is an address
 * the merchant's wallet cannot spend from. `BUGGY` below reproduces that exact
 * computation, so the test pins the real defect rather than a description of it.
 * The heal must fix a still-unpaid order and must never touch one with a payment.
 */
describe("self-heal of a pre-fix destination", () => {
  function buggyAddress(index: number): string {
    const child = HDKey.fromExtendedKey(TEST_XPUB).derive(`m/0/${index}`);
    // The old code: viem's publicKeyToAddress on a 33-byte compressed key.
    return publicKeyToAddress(`0x${Buffer.from(child.publicKey!).toString("hex")}`).toLowerCase();
  }

  it("rewrites a stale frozen destination back to the merchant's real address", async () => {
    const dev = await makeDeveloper();
    await setPaymentXpub(dev, TEST_XPUB);
    const intent = await makeIntent(dev);
    const result = await createCheckout(intent, { developerId: dev, intentId: intent.id });
    if (!result.ok) throw new Error("create failed");

    // Simulate the pre-fix freeze: the order's stored destination (and the frozen
    // recipient) is the wrong address.
    const buggy = buggyAddress(0);
    await getStore().update("apiCheckouts", { id: result.checkout.id }, { attributionAddress: buggy });
    result.checkout.attributionAddress = buggy;
    await bindIntentForCheckout(intent, buggy);
    expect((await getStore().findOne("apiIntents", { id: intent.id }))!.recipient.toLowerCase()).toBe(buggy);

    await expireCheckoutIfStale(result.checkout);

    const correct = derivePaymentAddress(TEST_XPUB, 0).toLowerCase();
    const healedCheckout = await getStore().findOne("apiCheckouts", { id: result.checkout.id });
    const healedIntent = await getStore().findOne("apiIntents", { id: intent.id });
    expect(healedCheckout!.attributionAddress).toBe(correct);
    expect(healedIntent!.recipient.toLowerCase()).toBe(correct);
    // The frozen parameters move with the recipient, so the verifier reads the
    // same destination the customer is now shown.
    expect(JSON.parse(healedIntent!.authorizedParams!).recipient).toBe(correct);
    expect(verificationDestination(healedCheckout!, healedIntent!)).toBe(correct);
  });

  it("never rewrites an order that already has a submitted payment", async () => {
    const dev = await makeDeveloper();
    await setPaymentXpub(dev, TEST_XPUB);
    const intent = await makeIntent(dev);
    const result = await createCheckout(intent, { developerId: dev, intentId: intent.id });
    if (!result.ok) throw new Error("create failed");
    const buggy = buggyAddress(0);
    await getStore().update("apiCheckouts", { id: result.checkout.id }, { attributionAddress: buggy });
    result.checkout.attributionAddress = buggy;
    await bindIntentForCheckout(intent, buggy);
    // A submitted payment freezes the order: the heal must leave it untouched.
    const { transition } = await import("@/lib/developer/intents");
    await transition(intent, "submitted", null, Date.now(), { silent: true });

    await expireCheckoutIfStale(result.checkout);

    const after = await getStore().findOne("apiCheckouts", { id: result.checkout.id });
    expect(after!.attributionAddress).toBe(buggy);
  });

  it("is a no-op when the stored destination is already correct", async () => {
    const dev = await makeDeveloper();
    await setPaymentXpub(dev, TEST_XPUB);
    const intent = await makeIntent(dev);
    const result = await createCheckout(intent, { developerId: dev, intentId: intent.id });
    if (!result.ok) throw new Error("create failed");
    await bindIntentForCheckout(intent, result.checkout.attributionAddress);
    const before = (await getStore().findOne("apiIntents", { id: intent.id }))!.authorizedParams;

    await expireCheckoutIfStale(result.checkout);

    const after = (await getStore().findOne("apiIntents", { id: intent.id }))!.authorizedParams;
    expect(after).toBe(before);
  });
});
