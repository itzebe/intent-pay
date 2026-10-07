import type { ParsedPaymentIntent } from "./schema";
import { deriveState } from "./schema";

/**
 * Clarification copy. The engine asks for exactly one missing thing at a time,
 * in plain language, and never invents an asset, address, or price.
 *
 * Kept pure and data-only so the server can generate the question and the UI
 * can also re-derive it without drift.
 */
export type Clarification = {
  state: ReturnType<typeof deriveState>;
  /** One short question, in the product's voice. */
  question: string;
  /** What kind of answer we expect, so the UI can render the right control. */
  expect: "asset" | "recipient" | "amount" | "none";
  /** When the missing recipient has a known name, echo it. */
  recipientName?: string;
};

/** Build the next clarification question from the structured draft alone. */
export function nextClarification(intent: ParsedPaymentIntent): Clarification {
  const state = deriveState(intent);

  if (state === "NEEDS_AMOUNT") {
    return { state, question: "How much should they receive?", expect: "amount" };
  }

  if (state === "NEEDS_ASSET") {
    return {
      state,
      question: "Which asset would you like to send?",
      expect: "asset",
    };
  }

  if (state === "NEEDS_RECIPIENT") {
    const what = describeAmount(intent);
    return {
      state,
      question: intent.recipientName
        ? `I don't have an address for ${intent.recipientName}. What address should I send ${what} to?`
        : `What address should I send ${what} to?`,
      expect: "recipient",
      recipientName: intent.recipientName ?? undefined,
    };
  }

  return { state, question: "", expect: "none" };
}

/** "$10 in MON" / "10 MON" / "$10" — the amount phrase used in follow-ups. */
export function describeAmount(intent: ParsedPaymentIntent): string {
  if (!intent.amount) return "it";
  if (intent.amountType === "USD_VALUE") {
    return intent.asset ? `the $${intent.amount} in ${intent.asset}` : `$${intent.amount}`;
  }
  return `${intent.amount} ${intent.asset ?? ""}`.trim();
}

/** The recipient-facing summary of what will be delivered, for confirmation. */
export function describeIntent(intent: ParsedPaymentIntent): string {
  const amount = describeAmount(intent);
  const to = intent.recipientAddress ? `to ${intent.recipientAddress}` : "";
  return `Send ${amount} ${to}`.trim();
}
