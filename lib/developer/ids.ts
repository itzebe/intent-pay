import { randomBytes } from "node:crypto";

/**
 * Opaque, prefixed public identifiers for the external developer API.
 *
 * Every id carries a short, stable type prefix (`int_`, `dev_`, `wh_`, …) so a
 * value is self-describing in logs and support tickets, and is generated from a
 * CSPRNG so it can never be enumerated or guessed from another id. The prefix is
 * a *label*, never an authorization: every read is still scoped by the owning
 * developer id.
 */
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

function randomToken(length: number): string {
  // 256 is a multiple of the 36-char alphabet, so the modulo introduces no bias.
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomToken(24)}`;
}

export const newDeveloperId = () => newId("dev");
export const newApiKeyId = () => newId("key");
export const newIntentId = () => newId("int");
export const newIntentEventId = () => newId("evt");
export const newWebhookId = () => newId("wh");
export const newDeliveryId = () => newId("dlv");
export const newCheckoutId = () => newId("chk");
/** A unique event id, stable across a delivery's retries. */
export const newEventId = () => newId("evt");

/** A random secret for a webhook signing key (hex). */
export function newWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("hex")}`;
}

/**
 * A public, unguessable checkout token. 32 bytes of CSPRNG entropy, so a link
 * cannot be enumerated. The plaintext is returned once and only its hash is
 * stored.
 */
export function newCheckoutToken(): string {
  return `chk_${randomBytes(32).toString("hex")}`;
}
