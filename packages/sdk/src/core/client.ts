import { ConfigurationError } from "./errors.js";
import { resolveConfig, type IntentPayConfig, type ResolvedConfig } from "./config.js";
import { Transport } from "./transport.js";
import type {
  ApiKeyInfo,
  Capabilities,
  Checkout,
  CheckoutSettlement,
  Intent,
  LifecycleEntry,
  PreparedTransaction,
  SettlementResult,
  ValidationResult,
  Webhook,
  WebhookDelivery,
} from "./types.js";

/**
 * The Intent Pay client.
 *
 * One class, one transport, every `/api/v1` method. The client is stateless and
 * safe to share across requests; it never holds a wallet, a key or a signature.
 *
 * The credential is read once at construction and only ever placed in the
 * `Authorization` header. Every method that needs it calls `requireCredential`,
 * so a missing key fails locally with a clear error rather than a 401 round trip.
 */
export class IntentPay {
  private readonly config: ResolvedConfig;
  private readonly transport: Transport;

  constructor(config: IntentPayConfig = {}) {
    this.config = resolveConfig(config);
    this.transport = new Transport(this.config);
  }

  private requireCredential(): void {
    if (!this.config.apiKey) {
      throw new ConfigurationError("client_missing_credential", "This method requires an `apiKey`. Provide one when constructing the client.");
    }
  }

  // ── Capabilities ────────────────────────────────────────────────────────────

  /** `GET /api/v1/capabilities` — no credential required. */
  async getCapabilities(): Promise<Capabilities> {
    return this.transport.json<Capabilities>({ method: "GET", path: "/api/v1/capabilities" });
  }

  // ── Intents ─────────────────────────────────────────────────────────────────

  /**
   * `POST /api/v1/intents` — create a payment intent.
   *
   * Pass a stable `idempotencyKey` (or use the same one on a retry) and the
   * server returns the original intent rather than creating a duplicate. The
   * SDK also sends it as the `Idempotency-Key` header, so a retried create is
   * deduplicated even after a timeout.
   */
  async createIntent(input: CreateIntentInput): Promise<CreateIntentResult> {
    this.requireCredential();
    const body: Record<string, unknown> = {
      recipient: input.recipient,
      receiveToken: input.receiveToken,
      amount: input.amount,
      amountMode: input.amountMode ?? "recipient_receives",
    };
    if (input.chainId !== undefined) body.chainId = input.chainId;
    if (input.payToken) body.payToken = input.payToken;
    if (input.reference) body.reference = input.reference;
    if (input.idempotencyKey) body.idempotencyKey = input.idempotencyKey;

    const res = await this.transport.json<{ ok: true; intent: Intent; created: boolean }>({
      method: "POST",
      path: "/api/v1/intents",
      body,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    });
    return { intent: res.intent, created: res.created };
  }

  /** `GET /api/v1/intents/:id` — an intent and its lifecycle history. */
  async getIntent(id: string): Promise<GetIntentResult> {
    this.requireCredential();
    return this.transport.json<GetIntentResult>({ method: "GET", path: `/api/v1/intents/${encodeURIComponent(id)}` });
  }

  /** `GET /api/v1/intents` — this tenant's intents, newest first. */
  async listIntents(): Promise<Intent[]> {
    this.requireCredential();
    const res = await this.transport.json<{ ok: true; intents: Intent[] }>({ method: "GET", path: "/api/v1/intents" });
    return res.intents;
  }

  /**
   * `POST /api/v1/intents/:id/validate` — validate recipient, asset, chain,
   * amount and route against the live catalog.
   *
   * A failed validation is a *successful* call that returns `valid: false` (the
   * intent moves to `rejected`). It is not thrown, so a caller can render the
   * specific reasons.
   */
  async validateIntent(id: string): Promise<ValidationResult> {
    this.requireCredential();
    return this.transport.json<ValidationResult>({ method: "POST", path: `/api/v1/intents/${encodeURIComponent(id)}/validate` });
  }

  /**
   * `POST /api/v1/intents/:id/prepare` — build the calls for a wallet to send.
   *
   * **Nothing is signed or sent.** The result is the ordered `{to,data,value}`
   * calls plus the guaranteed minimum. Preparing does not make a payment, and
   * the SDK never treats it as one.
   */
  async prepareTransaction(id: string, input: PrepareInput): Promise<PreparedTransaction> {
    this.requireCredential();
    const body: Record<string, unknown> = { sender: input.sender };
    if (input.payToken) body.payToken = input.payToken;
    return this.transport.json<PreparedTransaction>({
      method: "POST",
      path: `/api/v1/intents/${encodeURIComponent(id)}/prepare`,
      body,
    });
  }

  /**
   * `POST /api/v1/intents/:id/authorize` — freeze the parameters.
   *
   * After this, the recipient/asset/amount are immutable; a later prepare,
   * submit or verify must match them. Idempotent: re-authorizing returns the
   * same frozen parameters.
   */
  async authorizeIntent(id: string): Promise<AuthorizeResult> {
    this.requireCredential();
    return this.transport.json<AuthorizeResult>({ method: "POST", path: `/api/v1/intents/${encodeURIComponent(id)}/authorize` });
  }

  /**
   * `POST /api/v1/intents/:id/submit` — record the broadcast transaction hash.
   *
   * The wallet broadcasts; this only records the hash. Requires a prior
   * authorization. This call is **non-idempotent**: on a timeout the SDK does not
   * retry, because the transaction may already be recorded — use
   * `getPaymentStatus` to reconcile.
   */
  async submitTransaction(id: string, input: SubmitInput): Promise<SubmitResult> {
    this.requireCredential();
    const body: Record<string, unknown> =
      "txHashes" in input ? { txHashes: input.txHashes } : { txHash: input.txHash };
    return this.transport.json<SubmitResult>({
      method: "POST",
      path: `/api/v1/intents/${encodeURIComponent(id)}/submit`,
      body,
      nonIdempotent: true,
    });
  }

  /**
   * `POST /api/v1/intents/:id/verify` — independently verify settlement on-chain.
   *
   * The server reads the authoritative Monad receipt itself. A `pending`,
   * `not_found` or `unavailable` verdict is returned (not thrown) with
   * `retryable: true`; only `verified` proves the recipient was paid.
   */
  async verifySettlement(id: string, input: VerifyInput = {}): Promise<SettlementResult> {
    this.requireCredential();
    const body = input.txHash ? { txHash: input.txHash } : {};
    return this.transport.json<SettlementResult>({
      method: "POST",
      path: `/api/v1/intents/${encodeURIComponent(id)}/verify`,
      body,
    });
  }

  /**
   * A convenience view of a payment's progress that never overstates it.
   *
   * `settled` is true only for a `verified` intent. `submitted`/`confirmed` are
   * reported honestly as "not yet proven settled".
   */
  async getPaymentStatus(id: string): Promise<PaymentStatus> {
    const { intent, lifecycle } = await this.getIntent(id);
    return {
      id: intent.id,
      state: intent.state,
      settled: intent.state === "verified",
      failed: intent.state === "failed" || intent.state === "rejected" || intent.state === "expired",
      intent,
      lifecycle,
    };
  }

  // ── Webhooks ────────────────────────────────────────────────────────────────

  /** `POST /api/v1/webhooks` — register a destination. The secret is returned once. */
  async createWebhook(input: CreateWebhookInput): Promise<CreateWebhookResult> {
    this.requireCredential();
    return this.transport.json<CreateWebhookResult>({
      method: "POST",
      path: "/api/v1/webhooks",
      body: { url: input.url, events: input.events, ...(input.description ? { description: input.description } : {}) },
    });
  }

  /** `GET /api/v1/webhooks` — list destinations. */
  async listWebhooks(): Promise<Webhook[]> {
    this.requireCredential();
    const res = await this.transport.json<{ ok: true; webhooks: Webhook[] }>({ method: "GET", path: "/api/v1/webhooks" });
    return res.webhooks;
  }

  /** `DELETE /api/v1/webhooks/:id` — remove a destination. */
  async deleteWebhook(id: string): Promise<void> {
    this.requireCredential();
    await this.transport.json<{ ok: true }>({ method: "DELETE", path: `/api/v1/webhooks/${encodeURIComponent(id)}` });
  }

  /** `GET /api/v1/webhooks/:id/deliveries` — the real delivery history. */
  async listWebhookDeliveries(webhookId: string): Promise<WebhookDelivery[]> {
    this.requireCredential();
    const res = await this.transport.json<{ ok: true; deliveries: WebhookDelivery[] }>({
      method: "GET",
      path: `/api/v1/webhooks/${encodeURIComponent(webhookId)}/deliveries`,
    });
    return res.deliveries;
  }

  // ── Checkouts (merchant orders) ─────────────────────────────────────────────

  /**
   * `POST /api/v1/checkouts` — create a payable order for an intent.
   *
   * The returned `token` is the public payment-link handle to share with the
   * customer. Creating a checkout freezes the intent's parameters and makes it
   * payable; the amount, asset and recipient can never change afterwards.
   *
   * Pass a stable `idempotencyKey` so a retried create returns the original
   * checkout and its link rather than a duplicate.
   */
  async createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult> {
    this.requireCredential();
    return this.transport.json<CreateCheckoutResult>({
      method: "POST",
      path: "/api/v1/checkouts",
      body: {
        intentId: input.intentId,
        ...(input.orderReference ? { orderReference: input.orderReference } : {}),
        ...(input.ttlSeconds !== undefined ? { ttlSeconds: input.ttlSeconds } : {}),
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      },
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    });
  }

  /** `GET /api/v1/checkouts/:id` — retrieve an order and its lifecycle. */
  async getCheckout(id: string): Promise<GetCheckoutResult> {
    this.requireCredential();
    return this.transport.json<GetCheckoutResult>({ method: "GET", path: `/api/v1/checkouts/${encodeURIComponent(id)}` });
  }

  /** `GET /api/v1/checkouts` — list this merchant's orders, newest first. */
  async listCheckouts(): Promise<Checkout[]> {
    this.requireCredential();
    const res = await this.transport.json<{ ok: true; checkouts: Checkout[] }>({ method: "GET", path: "/api/v1/checkouts" });
    return res.checkouts;
  }

  // ── Checkout attribution (per-order destinations) ────────────────────────────

  /**
   * `GET /api/v1/attribution` — read the checkout-attribution configuration.
   *
   * Reports whether checkout-bound attribution is enabled and previews the next
   * destinations. The registered xpub itself is never returned.
   */
  async getAttribution(): Promise<AttributionConfig> {
    this.requireCredential();
    const res = await this.transport.json<{ ok: true; attribution: AttributionConfig }>({ method: "GET", path: "/api/v1/attribution" });
    return res.attribution;
  }

  /**
   * `POST /api/v1/attribution` — register (or clear) the watch-only payment xpub.
   *
   * Pass a BIP32 **public** extended key (`xpub…`) to give every checkout a unique
   * destination, or `null` to disable. A private key or seed phrase is refused by
   * the server, so Intent Pay can never be handed a spending key.
   */
  async setAttribution(paymentXpub: string | null): Promise<AttributionConfig> {
    this.requireCredential();
    const res = await this.transport.json<{ ok: true; attribution: AttributionConfig }>({
      method: "POST",
      path: "/api/v1/attribution",
      body: { paymentXpub },
    });
    return res.attribution;
  }

  /**
   * `POST /api/v1/checkouts/:id/prepare` — build the calls for the customer's wallet.
   *
   * **Builds only.** The customer's wallet must sign and broadcast; the merchant
   * credential can never authorize a payment.
   */
  async prepareCheckout(id: string, input: PrepareInput): Promise<PreparedTransaction> {
    this.requireCredential();
    return this.transport.json<PreparedTransaction>({
      method: "POST",
      path: `/api/v1/checkouts/${encodeURIComponent(id)}/prepare`,
      body: { sender: input.sender, ...(input.payToken ? { payToken: input.payToken } : {}) },
    });
  }

  /** `POST /api/v1/checkouts/:id/submit` — record the customer's broadcast hash(es). */
  async submitCheckout(id: string, input: SubmitInput): Promise<SubmitResult> {
    this.requireCredential();
    const body = "txHash" in input ? { txHash: input.txHash } : { txHashes: input.txHashes };
    return this.transport.json<SubmitResult>({
      method: "POST",
      path: `/api/v1/checkouts/${encodeURIComponent(id)}/submit`,
      body,
      nonIdempotent: true,
    });
  }

  /**
   * `POST /api/v1/checkouts/:id/verify` — independently verify settlement.
   *
   * Only a `verified` verdict completes the order. `pending`/`not_found`/
   * `unavailable` are returned with `retryable: true`; the order is never
   * falsely completed.
   */
  async verifyCheckout(id: string, input: VerifyInput = {}): Promise<CheckoutVerifyResult> {
    this.requireCredential();
    const body = input.txHash ? { txHash: input.txHash } : {};
    return this.transport.json<CheckoutVerifyResult>({
      method: "POST",
      path: `/api/v1/checkouts/${encodeURIComponent(id)}/verify`,
      body,
    });
  }

  /** `POST /api/v1/checkouts/:id/cancel` — cancel an unpaid order. */
  async cancelCheckout(id: string): Promise<{ checkout: Checkout; canceled: boolean }> {
    this.requireCredential();
    return this.transport.json<{ checkout: Checkout; canceled: boolean }>({
      method: "POST",
      path: `/api/v1/checkouts/${encodeURIComponent(id)}/cancel`,
      body: {},
    });
  }

  /** `GET /api/v1/checkouts/:id/evidence` — settlement evidence, re-verified live. */
  async getCheckoutEvidence(id: string): Promise<CheckoutEvidence> {
    this.requireCredential();
    return this.transport.json<CheckoutEvidence>({
      method: "GET",
      path: `/api/v1/checkouts/${encodeURIComponent(id)}/evidence`,
    });
  }

  // ── Account ─────────────────────────────────────────────────────────────────

  /** `GET /api/v1/developers` — this tenant and its key metadata (never secrets). */
  async getAccount(): Promise<AccountInfo> {
    this.requireCredential();
    return this.transport.json<AccountInfo>({ method: "GET", path: "/api/v1/developers" });
  }
}

// ── Input / result types ──────────────────────────────────────────────────────

export type CreateIntentInput = {
  /** The Monad address that must receive the payment. */
  recipient: string;
  /** The asset the recipient receives (symbol or contract address). */
  receiveToken: string;
  /**
   * The amount, as a decimal string, **denominated in USD**.
   *
   * Intent Pay is USD-primary: `amount: "5"` means "the recipient receives $5
   * worth of `receiveToken`", not 5 units of it. `amountMode` decides whether
   * that $5 is measured at the recipient (`recipient_receives`) or at the sender
   * (`i_spend`).
   */
  amount: string;
  /** `recipient_receives` (default) or `i_spend`. */
  amountMode?: "recipient_receives" | "i_spend";
  /** Only `143` is accepted; omitted defaults to it server-side. */
  chainId?: number;
  /** Pin the asset the sender spends. Omit to let the router choose. */
  payToken?: string;
  /** Your own correlation reference. */
  reference?: string;
  /** A stable key so a retried create returns the original intent. */
  idempotencyKey?: string;
};

export type CreateIntentResult = { intent: Intent; created: boolean };

export type GetIntentResult = { intent: Intent; lifecycle: LifecycleEntry[] };

export type PrepareInput = { sender: string; payToken?: string };

export type AuthorizeResult = { intent: Intent; authorizedParams: Record<string, unknown>; state: Intent["state"] };

export type SubmitInput = { txHash: string } | { txHashes: string[] };

export type SubmitResult = { intent: Intent; txHashes: string[]; note: string };

export type VerifyInput = { txHash?: string };

export type PaymentStatus = {
  id: string;
  state: Intent["state"];
  /** True only when the recipient was proven paid on-chain. */
  settled: boolean;
  /** True when the payment can no longer succeed. */
  failed: boolean;
  intent: Intent;
  lifecycle: LifecycleEntry[];
};

export type CreateWebhookInput = { url: string; events: string[]; description?: string };

export type CreateWebhookResult = { webhook: Webhook; secret: string };

// ── Checkout (merchant order) input / result types ────────────────────────────

export type CreateCheckoutInput = {
  /** The intent this order is bound to (created first, via `createIntent`). */
  intentId: string;
  /** Your own order id, for reconciliation. */
  orderReference?: string;
  /** Link lifetime in seconds (60–86400). Defaults to 30 minutes. */
  ttlSeconds?: number;
  /** A stable key so a retried create returns the original checkout. */
  idempotencyKey?: string;
};

export type CreateCheckoutResult = {
  checkout: Checkout;
  /** The public payment-link handle to share with the customer. */
  token: string;
  created: boolean;
};

export type GetCheckoutResult = {
  checkout: Checkout;
  intent: {
    id: string;
    state: Intent["state"];
    chainId: number;
    recipient: string;
    receiveToken: string;
    receiveTokenAddress: string;
    amountMode: Intent["amountMode"];
    amount: string;
    payToken: string | null;
    authorized: boolean;
  } | null;
  lifecycle: LifecycleEntry[];
};

/** The merchant's checkout-attribution configuration (never the xpub itself). */
export type AttributionConfig = {
  mode: "checkout_bound" | "shared_recipient";
  checkoutBound: boolean;
  nextDerivationIndex: number;
  /** A short preview of upcoming destinations (empty in shared-recipient mode). */
  preview: string[];
  note?: string;
};

export type CheckoutVerifyResult = {
  verdict: CheckoutSettlement["verdict"];
  /** Present once the order reaches a terminal state. */
  state?: Intent["state"];
  checkout?: Checkout;
  settlement?: CheckoutSettlement;
  delivered?: string | null;
  blockNumber?: number | null;
  retryable?: boolean;
  message?: string;
};

export type CheckoutEvidence = {
  checkout: Checkout;
  intent: {
    id: string;
    state: Intent["state"];
    chainId: number;
    recipient: string;
    receiveToken: string;
    receiveTokenAddress: string;
    amountMode: Intent["amountMode"];
    amount: string;
    payToken: string | null;
    reference: string | null;
    authorized: boolean;
    frozenMatchesCurrent: boolean;
    fingerprint: string;
  };
  authorizedParams: Record<string, unknown> | null;
  txHashes: string[];
  lifecycle: LifecycleEntry[];
  settlement: CheckoutSettlement | null;
  /** True only when the chain proves the payment was delivered. */
  settled: boolean;
};

export type AccountInfo = {
  developer: { id: string; name: string; status: string };
  keys: ApiKeyInfo[];
};
