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
  | "rpc_transport"
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

/**
 * True when the failure is the page (or the wallet's page-world provider) being
 * unable to *reach a network endpoint* — a CSP block, a DNS/TLS failure, or an
 * offline device — rather than a wallet-level refusal.
 *
 * This is the shape a blocked `connect-src` takes: the browser throws a bare
 * `TypeError: Failed to fetch` with no EIP-1193 code, so the generic "check the
 * connection in Monad" copy pointed the user at the wrong thing. A page-world
 * provider that proxies reads to the wallet's own node surfaces exactly this.
 */
function isNetworkFailure(err: unknown): boolean {
  if (!err) return false;
  const parts: string[] = [];
  let node: unknown = err;
  for (let depth = 0; node && depth < 6; depth++) {
    if (typeof node === "string") {
      parts.push(node);
      break;
    }
    if (typeof node !== "object") break;
    const n = node as { message?: unknown; cause?: unknown; error?: unknown };
    if (typeof n.message === "string") parts.push(n.message);
    node = n.cause ?? n.error;
  }
  const text = parts.join(" ").toLowerCase();
  return (
    /failed to fetch/.test(text) ||
    /networkerror/.test(text) ||
    /network request failed/.test(text) ||
    /load failed/.test(text) ||
    /refused to connect/.test(text) ||
    /violates the following content security policy/.test(text)
  );
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
  if (isNetworkFailure(err)) {
    return {
      kind: "rpc_transport",
      code,
      rejected: false,
      message:
        "Your wallet couldn't complete its network request to Monad. Intent Pay's own chain reads are unaffected — try again, and if it keeps happening use another wallet or WalletConnect.",
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
