import { NextResponse } from "next/server";
import { NETWORKS } from "@/lib/config/chains";
import { SEED_TOKENS } from "@/lib/config/tokens";
import { WEBHOOK_EVENTS, INTENT_STATES } from "@/lib/developer/intentLifecycle";
import { MAX_ATTEMPTS } from "@/lib/developer/webhooks";
import { isProductionEnvironment, testKeysAllowed } from "@/lib/developer/credentials";
import { emailConfigured } from "@/lib/developer/email";
import { adminConfigured } from "@/lib/server/auth";
import { storeCapability } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/capabilities — what the developer API actually supports.
 *
 * The machine-readable counterpart of the honesty surfaces elsewhere in the app:
 * it reports the real chain, the API version, the implemented endpoints, the
 * intent states and webhook events, and whether the store is durable enough to
 * persist intents. It advertises **only implemented** capabilities. No credential
 * is required (it exposes no per-tenant data), and no secret is ever included.
 */
export async function GET() {
  const storage = await storeCapability();
  return NextResponse.json({
    ok: true,
    apiVersion: "v1",
    network: {
      key: "mainnet",
      name: "Monad",
      chainId: NETWORKS.mainnet.chainId,
      explorer: NETWORKS.mainnet.explorer,
    },
    /** Only Monad Mainnet is supported; there is no testnet or fallback. */
    networks: [{ key: "mainnet", chainId: NETWORKS.mainnet.chainId }],
    /** The shipped, always-available assets. More are discovered live. */
    assets: SEED_TOKENS.map((t) => ({
      symbol: t.symbol,
      name: t.name,
      address: t.address,
      decimals: t.decimals,
      native: Boolean(t.native),
    })),
    endpoints: [
      { method: "POST", path: "/api/v1/intents", description: "Create a payment intent." },
      { method: "GET", path: "/api/v1/intents/{id}", description: "Retrieve an intent and its lifecycle." },
      { method: "POST", path: "/api/v1/intents/{id}/validate", description: "Validate recipient, asset, chain and amount." },
      { method: "POST", path: "/api/v1/intents/{id}/prepare", description: "Build the transaction calls for a wallet." },
      { method: "POST", path: "/api/v1/intents/{id}/authorize", description: "Freeze the parameters before signing." },
      { method: "POST", path: "/api/v1/intents/{id}/submit", description: "Record the broadcast transaction hash(es)." },
      { method: "POST", path: "/api/v1/intents/{id}/verify", description: "Independently verify settlement on-chain." },
      { method: "GET", path: "/api/v1/intents", description: "List this developer's intents." },
      { method: "POST", path: "/api/v1/checkouts", description: "Create a merchant checkout session for an intent." },
      { method: "GET", path: "/api/v1/checkouts", description: "List this merchant's checkouts." },
      { method: "GET", path: "/api/v1/checkouts/{id}", description: "Retrieve a checkout and its order status." },
      { method: "POST", path: "/api/v1/checkouts/{id}/prepare", description: "Build the transaction calls for the customer's wallet." },
      { method: "POST", path: "/api/v1/checkouts/{id}/submit", description: "Record the customer's broadcast transaction hash(es)." },
      { method: "POST", path: "/api/v1/checkouts/{id}/verify", description: "Independently verify settlement on-chain." },
      { method: "POST", path: "/api/v1/checkouts/{id}/cancel", description: "Cancel an eligible (unpaid) checkout." },
      { method: "GET", path: "/api/v1/checkouts/{id}/evidence", description: "Settlement evidence for a checkout (re-verified live)." },
      { method: "GET", path: "/api/v1/attribution", description: "Read the checkout-attribution configuration." },
      { method: "POST", path: "/api/v1/attribution", description: "Register or clear the watch-only payment xpub (per-checkout destinations)." },
      { method: "GET", path: "/api/v1/capabilities", description: "This document." },
      { method: "POST", path: "/api/v1/developers/register", description: "Start self-service signup: creates a pending account and emails a verification link." },
      { method: "POST", path: "/api/v1/developers/verify", description: "Exchange a single-use verification token for the first API key." },
      { method: "POST", path: "/api/v1/developers/resend", description: "Re-send a verification email for a pending account." },
      { method: "POST", path: "/api/v1/webhooks", description: "Register a webhook destination." },
      { method: "GET", path: "/api/v1/webhooks", description: "List webhook destinations." },
      { method: "DELETE", path: "/api/v1/webhooks/{id}", description: "Delete a webhook destination." },
      { method: "GET", path: "/api/v1/webhooks/{id}/deliveries", description: "Delivery history for a webhook." },
    ],
    /**
     * Public, unauthenticated endpoints. `/api/checkout/{token}` is the customer's
     * payment page API — authenticated by the payment-link token, never an API
     * key (the customer has no credential and must never be given the merchant's).
     */
    publicEndpoints: [
      { method: "GET", path: "/api/checkout/{token}", description: "The customer's view of a checkout (by payment-link token)." },
      { method: "POST", path: "/api/checkout/{token}/prepare", description: "Build the calls for the customer's wallet." },
      { method: "POST", path: "/api/checkout/{token}/submit", description: "Record the customer's broadcast transaction hash(es)." },
      { method: "POST", path: "/api/checkout/{token}/verify", description: "Independently verify settlement on-chain." },
    ],
    intentStates: INTENT_STATES,
    checkoutStates: ["open", "completed", "expired", "canceled", "failed"],
    webhookEvents: WEBHOOK_EVENTS,
    features: {
      /** Parameters are frozen at authorization and can never change afterwards. */
      frozenParameters: true,
      idempotencyKeys: true,
      /** An independent on-chain settlement verification endpoint. */
      independentVerification: true,
      webhookSigning: "hmac-sha256",
      webhookMaxAttempts: MAX_ATTEMPTS,
      /** A credential prepares a transaction; it can never sign or send one. */
      credentialCanSign: false,
      /** No private-key custody anywhere in the API. */
      keyCustody: false,
      /** Merchant checkout sessions (payment links + QR) over the same intents. */
      merchantCheckouts: true,
      /** The customer's own wallet authorizes every transaction; never the merchant. */
      customerAuthorizesPayment: true,
      /**
       * Checkout-specific attribution. A merchant who registers a watch-only
       * payment xpub gets a **unique destination per checkout**, so a transfer can
       * only settle the order it was created for. Without one, checkouts share the
       * merchant's recipient (weaker); that mode is reported per checkout, never
       * presented as checkout-bound.
       */
      checkoutAttribution: {
        /** Strong attribution is available by registering a payment xpub. */
        checkoutBoundAvailable: true,
        /** No spend key is ever held: derivation is watch-only from the merchant's xpub. */
        custodial: false,
        /** The mode used when a merchant has not registered an xpub. */
        defaultMode: "shared_recipient",
      },
    },
    storage: {
      kind: storage.kind,
      durability: storage.durability,
      durable: storage.durable,
      reason: storage.reason,
    },
    auth: {
      scheme: "bearer",
      header: "Authorization",
      /** Test keys are refused in production unless explicitly overridden. */
      testKeysAccepted: !isProductionEnvironment() || testKeysAllowed(),
      /**
       * Self-service signup is public on every deployment and always requires a
       * verified email before a credential is issued. The administrator token
       * remains an *additional*, operator-only provisioning path.
       */
      signup: "self_serve",
      signupRequiresEmailVerification: true,
      emailVerificationConfigured: emailConfigured(),
      operatorProvisioning: adminConfigured(),
    },
  });
}
