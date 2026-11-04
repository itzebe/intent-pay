import { NextResponse } from "next/server";
import { NETWORKS } from "@/lib/config/chains";
import { SEED_TOKENS } from "@/lib/config/tokens";
import { WEBHOOK_EVENTS, INTENT_STATES } from "@/lib/developer/intentLifecycle";
import { MAX_ATTEMPTS } from "@/lib/developer/webhooks";
import { isProductionEnvironment, testKeysAllowed } from "@/lib/developer/credentials";
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
      { method: "GET", path: "/api/v1/capabilities", description: "This document." },
      { method: "POST", path: "/api/v1/webhooks", description: "Register a webhook destination." },
      { method: "GET", path: "/api/v1/webhooks", description: "List webhook destinations." },
      { method: "DELETE", path: "/api/v1/webhooks/{id}", description: "Delete a webhook destination." },
      { method: "GET", path: "/api/v1/webhooks/{id}/deliveries", description: "Delivery history for a webhook." },
    ],
    intentStates: INTENT_STATES,
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
      signup: isProductionEnvironment() ? "admin" : "open",
    },
  });
}
