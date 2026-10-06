import { isEvmAddress } from "@/lib/format";
import { isPositiveDecimal, parseUnits } from "./math";
import type { PaymentIntent, QuoteErrorCode } from "./intent";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export type ValidationIssue = { code: QuoteErrorCode; message: string; field?: string };

/** Validate a recipient address. Returns null when valid. */
export function validateRecipient(recipient: string): ValidationIssue | null {
  const value = (recipient ?? "").trim();
  if (!value) {
    return { code: "invalid_recipient", message: "Enter the recipient's wallet address.", field: "recipient" };
  }
  if (!isEvmAddress(value)) {
    return { code: "invalid_recipient", message: "That doesn't look like a valid Monad address.", field: "recipient" };
  }
  if (value.toLowerCase() === ZERO_ADDRESS) {
    return { code: "invalid_recipient", message: "The zero address can't receive payments.", field: "recipient" };
  }
  return null;
}

export function validateAmount(amount: string, decimals: number): ValidationIssue | null {
  const value = (amount ?? "").trim();
  if (!value) {
    return { code: "invalid_amount", message: "Enter an amount.", field: "amount" };
  }
  if (!isPositiveDecimal(value)) {
    return { code: "invalid_amount", message: "Enter an amount greater than zero.", field: "amount" };
  }
  try {
    const units = parseUnits(value, decimals);
    if (units <= 0n) {
      return { code: "invalid_amount", message: "Amount is too small to send.", field: "amount" };
    }
  } catch {
    return { code: "invalid_amount", message: "Enter a valid number.", field: "amount" };
  }
  return null;
}

/**
 * Validate a USD-denominated intent amount. The amount field in the composer is
 * a dollar value ("$5.00 SOL"), so we validate it as money, not token units.
 */
export function validateUsdAmount(amount: string): ValidationIssue | null {
  const value = (amount ?? "").trim();
  if (!value) {
    return { code: "invalid_amount", message: "Enter an amount.", field: "amount" };
  }
  if (!/^\d*\.?\d*$/.test(value) || value === ".") {
    return { code: "invalid_amount", message: "Enter a valid dollar amount.", field: "amount" };
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return { code: "invalid_amount", message: "Enter an amount greater than zero.", field: "amount" };
  }
  if (n > 1_000_000_000) {
    return { code: "invalid_amount", message: "That amount is too large.", field: "amount" };
  }
  return null;
}

export function validateIntent(
  intent: PaymentIntent,
  receiveDecimals: number,
): ValidationIssue | null {
  return (
    validateRecipient(intent.recipient) ??
    validateAmount(intent.receiveAmount, receiveDecimals)
  );
}

export function isSelfPayment(recipient: string, sender: string | undefined): boolean {
  if (!sender) return false;
  return recipient.trim().toLowerCase() === sender.toLowerCase();
}
