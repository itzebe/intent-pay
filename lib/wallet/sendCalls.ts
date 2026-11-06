"use client";

/**
 * Sequential, confirmed call submission.
 *
 * A payment is often **several** transactions (approve → swap → unwrap →
 * deliver) and each one depends on its predecessor being *mined*: the swap needs
 * the approval to have landed, the delivery needs the unwrap. Broadcasting them
 * back-to-back lets a later call execute before its predecessor, so it reverts
 * and the payment fails after the customer has already paid gas.
 *
 * This is the single rule that fixes the ordering: send one call, wait for its
 * receipt, and only then send the next. It mirrors `executePlan`
 * (`lib/execution/execute.ts`), which does the same for the main composer.
 *
 * The function is deliberately free of React and of any provider object — the
 * caller injects `send` and `waitForReceipt` — so the ordering, the abort rules
 * and the "keep the hashes already broadcast" contract are unit-testable without
 * a browser or a real wallet.
 */

/** A raw `{to,data,value}` call as returned by the prepare endpoints. */
export type RawCall = { to: string; data: string; value: string };

/** Why a sequential submission stopped early. */
export type SendFailureReason =
  | "rejected"
  | "send_failed"
  | "invalid_hash"
  | "unconfirmed"
  | "reverted";

export type SendOutcome =
  | { ok: true; hashes: string[] }
  | {
      ok: false;
      hashes: string[];
      reason: SendFailureReason;
      message: string;
      /**
       * The value thrown by `send`/`waitForReceipt`, when there was one. Kept so
       * the caller can classify the *real* cause (a wallet transport failure, a
       * gas shortfall, …) instead of only the generic sentence — the same rule
       * `executePlan` follows for the composer.
       */
      cause?: unknown;
    };

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/** True when a thrown value is a user rejection (EIP-1193 code 4001). */
export function isUserRejection(err: unknown): boolean {
  return (err as { code?: number } | undefined)?.code === 4001;
}

/**
 * Send every call in order, confirming each before sending the next.
 *
 * `hashes` in the result always holds what was actually broadcast — even on
 * failure — so the caller can record it and let the customer check its status.
 * A failed submission is never retried here.
 */
export async function sendCallsSequentially(input: {
  calls: RawCall[];
  /** Sign and broadcast one call; resolves to the wallet's transaction hash. */
  send: (call: RawCall) => Promise<unknown>;
  /** Resolve once the transaction is mined, with its final status. */
  waitForReceipt: (hash: string) => Promise<{ status: string }>;
}): Promise<SendOutcome> {
  const hashes: string[] = [];

  for (const call of input.calls) {
    let raw: unknown;
    try {
      raw = await input.send(call);
    } catch (err) {
      return {
        ok: false,
        hashes,
        reason: isUserRejection(err) ? "rejected" : "send_failed",
        message: isUserRejection(err)
          ? "You declined the transaction in your wallet."
          : "The transaction could not be sent.",
        cause: err,
      };
    }

    if (typeof raw !== "string" || !TX_HASH_RE.test(raw)) {
      return { ok: false, hashes, reason: "invalid_hash", message: "Your wallet did not return a transaction hash." };
    }
    hashes.push(raw);

    let receipt: { status: string };
    try {
      receipt = await input.waitForReceipt(raw);
    } catch {
      // Broadcast but not observed in the window: an *unknown* outcome, not a
      // failure. Stop — the remaining calls depend on this one — and keep the
      // hash so the customer can check its real status.
      return {
        ok: false,
        hashes,
        reason: "unconfirmed",
        message: "Your transaction was sent, but we did not see it confirmed in time. Check its status before trying again.",
      };
    }
    if (receipt.status !== "success") {
      return { ok: false, hashes, reason: "reverted", message: "Your transaction reverted on Monad. No payment was made." };
    }
  }

  return { ok: true, hashes };
}
