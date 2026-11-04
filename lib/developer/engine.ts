import type { Address } from "viem";
import { NETWORKS } from "@/lib/config/chains";
import { getToken, type TokenConfig } from "@/lib/config/tokens";
import { ensureCatalog, resolveToken } from "@/lib/server/discovery";
import { buildQuote } from "@/lib/server/quote";
import { buildPaymentPlan, planEconomics } from "@/lib/execution/plan";
import { encodeStep, type EncodedCall } from "@/lib/execution/encode";
import { validateRecipient, validateUsdAmount } from "@/lib/domain/validation";
import { resolveSlippageBps } from "@/lib/domain/protection";
import { sanitizeUpstreamError } from "@/lib/server/http";
import type { AmountMode, PaymentIntent } from "@/lib/domain/intent";
import type { ApiIntentRecord } from "@/lib/store/types";
import { intentFingerprint } from "./intents";

/**
 * The developer-API payment engine.
 *
 * This layer reuses the *existing* Intent Pay engine — `buildQuote`, the
 * Uniswap V3 router, `buildPaymentPlan`, `encodeStep` — so an API intent runs the
 * same route, the same on-chain slippage bounds and the same calldata as the
 * browser. It adds only what an external caller needs: a wallet address to
 * prepare *for*, a frozen parameter set, and a plan returned as `{to,data,value}`
 * calls.
 *
 * A credential never authorizes a transaction. `prepare` builds the calls for a
 * wallet the *caller* controls; the wallet signs and broadcasts them. Nothing
 * here holds a key or sends a transaction.
 */

export const MONAD_CHAIN_ID = NETWORKS.mainnet.chainId;

export type PrepareFailure = { ok: false; code: string; message: string; detail?: string };

export type PreparedPlan = {
  /** The wallet that will sign (from the caller's request). */
  sender: string;
  /** The exact calls the wallet must send, in order. */
  calls: EncodedCall[];
  /** Human step labels, aligned with `calls`. */
  steps: string[];
  /** The guaranteed minimum the recipient receives (from the on-chain bounds). */
  minimumReceived: string;
  slippageBps: number;
  /** Echo of the priced quote's key figures. */
  payToken: string;
  payAmount: string;
  receiveToken: string;
  receiveAmount: string;
  networkCostUsd: number;
  /** A stable fingerprint of the frozen parameters (for wallet approval UX). */
  fingerprint: string;
};

/** Build the `PaymentIntent` the existing engine expects from an API intent. */
export function intentFromRecord(record: ApiIntentRecord): PaymentIntent {
  return {
    recipient: record.recipient,
    receiveToken: record.receiveToken,
    receiveAmount: record.amount,
    amountMode: record.amountMode as AmountMode,
  };
}

/**
 * Validate an intent's recipient, asset, chain and amount against the live
 * catalog. This is the real, server-side check the existing engine performs —
 * never a client-trusted one.
 */
export type ValidateOutcome = {
  ok: boolean;
  chainId: number;
  recipient: { valid: boolean; address: string; reason?: string };
  receiveToken: { symbol: string; address: string; exists: boolean; reason?: string };
  amount: { valid: boolean; value: string; reason?: string };
  payToken: { symbol: string | null; address: string | null; exists: boolean } | null;
  route: { available: boolean; path: string[]; reason?: string } | null;
  /** The amount in token units the recipient would receive, when priceable. */
  receiveAmountToken?: string | null;
};

export async function validateIntentRecord(record: ApiIntentRecord): Promise<ValidateOutcome> {
  await ensureCatalog("mainnet");
  const chainId = record.chainId;

  const recipientIssue = validateRecipient(record.recipient);
  const resolvedReceive = await resolveToken(record.receiveTokenAddress || record.receiveToken, "mainnet");
  const receiveConfig = resolvedReceive?.token ?? getToken(record.receiveToken);
  const amountIssue = receiveConfig
    ? validateUsdAmount(record.amount)
    : { code: "unsupported_token", message: "The receive asset is unknown." };

  const payResolved = record.payToken ? await resolveToken(record.payToken, "mainnet") : null;
  const payConfig = payResolved?.token ?? (record.payToken ? getToken(record.payToken) : undefined);

  const outcome: ValidateOutcome = {
    ok: false,
    chainId,
    recipient: { valid: !recipientIssue, address: record.recipient, reason: recipientIssue?.message },
    receiveToken: {
      symbol: record.receiveToken,
      address: receiveConfig?.address ?? record.receiveTokenAddress,
      exists: Boolean(resolvedReceive?.exists ?? receiveConfig),
      reason: resolvedReceive && !resolvedReceive.exists ? resolvedReceive.problem ?? "That token doesn't exist on Monad." : undefined,
    },
    amount: { valid: !amountIssue, value: record.amount, reason: amountIssue?.message },
    payToken: record.payToken
      ? { symbol: payConfig?.symbol ?? record.payToken, address: payConfig?.address ?? null, exists: Boolean(payResolved?.exists ?? payConfig) }
      : null,
    route: null,
  };

  if (chainId !== MONAD_CHAIN_ID) {
    outcome.recipient.reason = outcome.recipient.reason;
    return outcome;
  }
  if (recipientIssue || amountIssue || !receiveConfig) return outcome;
  if (resolvedReceive && !resolvedReceive.exists) return outcome;
  if (payResolved && !payResolved.exists) return outcome;

  // A route check needs a concrete pay asset. When the caller fixed one, quote
  // directly; otherwise try the receive asset as a same-asset transfer first,
  // which is the cheapest, most likely route and is always available when the
  // sender holds the receive token.
  const payForQuote: TokenConfig = payConfig ?? receiveConfig;
  try {
    const quote = await buildQuote(
      { intent: intentFromRecord(record), payToken: payForQuote.symbol, payTokenConfig: payForQuote, receiveToken: receiveConfig },
      "mainnet",
    );
    if (quote.ok) {
      outcome.route = { available: true, path: quote.quote.route.path };
      outcome.receiveAmountToken = quote.quote.receiveAmount;
    } else {
      outcome.route = { available: false, path: [], reason: quote.message };
    }
  } catch (err) {
    outcome.route = { available: false, path: [], reason: sanitizeUpstreamError(err, "Could not check a route.") };
  }

  outcome.ok = outcome.recipient.valid && outcome.amount.valid && outcome.receiveToken.exists && (outcome.route?.available ?? false);
  return outcome;
}

/**
 * Prepare a real transaction for the caller's wallet.
 *
 * Resolves the route, prices it, builds the plan for the *provided* sender, and
 * encodes each step. Returns the calls only — it never signs or broadcasts.
 * The parameters are re-read from the frozen intent, so what is prepared is
 * exactly what was authorized.
 */
export async function prepareIntent(
  record: ApiIntentRecord,
  sender: string,
  payTokenSymbol?: string | null,
): Promise<{ ok: true; plan: PreparedPlan } | PrepareFailure> {
  await ensureCatalog("mainnet");
  const receiveResolved = await resolveToken(record.receiveTokenAddress || record.receiveToken, "mainnet");
  const receiveConfig = receiveResolved?.token ?? getToken(record.receiveToken);
  if (!receiveConfig) return { ok: false, code: "unsupported_token", message: "The receive asset is unknown." };

  const paySymbol = payTokenSymbol ?? record.payToken ?? receiveConfig.symbol;
  const payResolved = await resolveToken(paySymbol, "mainnet");
  const payConfig = payResolved?.token ?? getToken(paySymbol);
  if (!payConfig) return { ok: false, code: "unsupported_token", message: `The payment asset "${paySymbol}" is unknown.` };

  const recipientIssue = validateRecipient(record.recipient);
  if (recipientIssue) return { ok: false, code: "invalid_recipient", message: recipientIssue.message };
  const amountIssue = validateUsdAmount(record.amount);
  if (amountIssue) return { ok: false, code: "invalid_amount", message: amountIssue.message };

  let quote;
  try {
    const result = await buildQuote(
      { intent: intentFromRecord(record), payToken: payConfig.symbol, payTokenConfig: payConfig, receiveToken: receiveConfig },
      "mainnet",
    );
    if (!result.ok) return { ok: false, code: result.code, message: result.message };
    quote = result.quote;
  } catch (err) {
    return { ok: false, code: "provider_error", message: sanitizeUpstreamError(err, "Could not build a quote.") };
  }

  const plan = buildPaymentPlan(quote, sender as Address, record.recipient as Address);
  if (!plan.executable) {
    return { ok: false, code: "route_unavailable", message: "This payment has no executable on-chain route." };
  }

  let calls: EncodedCall[];
  try {
    calls = plan.steps.map(encodeStep);
  } catch (err) {
    return { ok: false, code: "internal_error", message: sanitizeUpstreamError(err, "Could not encode the transaction.") };
  }

  const economics = planEconomics(quote, plan.slippageBps);
  return {
    ok: true,
    plan: {
      sender: sender.toLowerCase(),
      calls,
      steps: plan.steps.map((s) => s.label),
      minimumReceived: economics.minimumReceived,
      slippageBps: economics.slippageBps,
      payToken: quote.payToken.symbol,
      payAmount: quote.payAmount,
      receiveToken: quote.receiveToken.symbol,
      receiveAmount: quote.receiveAmount,
      networkCostUsd: quote.networkCostUsd,
      fingerprint: intentFingerprint(record),
    },
  };
}

export { resolveSlippageBps };
