/**
 * Classify an EIP-1193 wallet error into a small, honest set of outcomes.
 *
 * The reported loop was partly caused by treating every failure the same: a
 * chain switch that the user *rejected* (code 4001), an unsupported method
 * (4200 / -32601), and a transient provider error all collapsed into the same
 * generic "Please switch your wallet to Monad" message, so the real reason was
 * never shown and the same click could be retried forever with no learning.
 *
 * This is pure and total so it can be unit-tested. It never surfaces a raw
 * provider message: `message` is a fixed, safe sentence.
 */

export type WalletErrorKind =
  | "rejected"
  | "unsupported"
  | "disconnected"
  | "unknown";

export type WalletErrorInfo = {
  kind: WalletErrorKind;
  /** The wallet's own numeric error code when present (EIP-1193 / JSON-RPC). */
  code?: number;
  /** True when the user explicitly rejected the request in their wallet. */
  rejected: boolean;
  /** A fixed, user-safe explanation. Never a raw provider string. */
  message: string;
};

/** EIP-1193 user-rejection codes. */
const USER_REJECTED = new Set([4001]);
/** "Method not supported / not found" codes. */
const METHOD_NOT_SUPPORTED = new Set([4200, -32601]);

function numericCode(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const c = (err as { code?: unknown }).code;
  if (typeof c === "number") return c;
  // Some wallets nest the JSON-RPC error under `data` / `cause`.
  for (const key of ["data", "cause", "error"] as const) {
    const nested = (err as Record<string, unknown>)[key];
    const n = numericCode(nested);
    if (n !== undefined) return n;
  }
  return undefined;
}

export function classifyWalletError(err: unknown): WalletErrorInfo {
  const code = numericCode(err);
  if (code !== undefined && USER_REJECTED.has(code)) {
    return {
      kind: "rejected",
      code,
      rejected: true,
      message: "You rejected the request in your wallet. Nothing was sent.",
    };
  }
  if (code !== undefined && METHOD_NOT_SUPPORTED.has(code)) {
    return {
      kind: "unsupported",
      code,
      rejected: false,
      message:
        "Your wallet doesn't support this request. Update it or use a wallet that does, then try again.",
    };
  }
  if (code === 4900 || code === 4901) {
    return {
      kind: "disconnected",
      code,
      rejected: false,
      message: "Your wallet is disconnected from Monad. Reconnect it and try again.",
    };
  }
  return {
    kind: "unknown",
    code,
    rejected: false,
    message:
      "Your wallet couldn't complete the request. Check the connection in Monad and try again.",
  };
}
