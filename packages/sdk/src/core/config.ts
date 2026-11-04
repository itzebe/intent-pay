import { ConfigurationError } from "./errors.js";

/**
 * SDK configuration.
 *
 * The credential is a **bearer API key** and belongs on a server. The SDK
 * refuses to run with a credential in a browser context by default, so a key can
 * never be shipped in a client bundle by accident (see `resolveConfig`). Browser
 * use is still supported for the *unauthenticated* capabilities call and for the
 * wallet layer, which need no credential.
 */
export type IntentPayConfig = {
  /**
   * The API key (`ipk_live_…` / `ipk_test_…`). Required for every authenticated
   * call. **Server-side only** unless `dangerouslyAllowBrowser` is set.
   */
  apiKey?: string;
  /** The API origin, e.g. `https://intent-pay-roan.vercel.app`. */
  baseUrl?: string;
  /** Per-request timeout in milliseconds. Default 20000. */
  timeoutMs?: number;
  /**
   * Automatic retries for transient failures (network error, timeout, 429, 5xx).
   * Default 2. Retries use exponential backoff with jitter and respect a
   * `Retry-After` header. Idempotent requests are always safe to retry; a
   * `submit` is retried **only** when it never reached the server (a connect
   * error), never on a timeout, so a transaction is never recorded twice.
   */
  maxRetries?: number;
  /** The `fetch` implementation to use. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /**
   * Permit a credential to be used in a browser-like environment. Off by
   * default; turning it on exposes the key to anyone with the page.
   */
  dangerouslyAllowBrowser?: boolean;
};

export const DEFAULT_BASE_URL = "https://intent-pay-roan.vercel.app";
export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_MAX_RETRIES = 2;

/** The fully-resolved configuration the transport uses. */
export type ResolvedConfig = {
  apiKey: string | null;
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  fetch: typeof fetch;
};

/** True when running in a browser-like environment (a real `window`). */
export function isBrowserEnvironment(): boolean {
  return typeof window !== "undefined" && typeof window.document !== "undefined";
}

/** Normalize and validate a base URL, rejecting a non-http(s) scheme. */
export function normalizeBaseUrl(input: string | undefined): string {
  const raw = (input ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigurationError("client_invalid_config", `\`baseUrl\` is not a valid URL: ${raw}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ConfigurationError("client_invalid_config", "`baseUrl` must use http or https.");
  }
  return raw;
}

/**
 * Validate a key's *shape* without contacting the server, so an obvious mistake
 * (a placeholder, a truncated paste) is caught at construction.
 */
export function assertApiKeyShape(key: string): void {
  if (!/^ipk_(live|test)_[0-9a-z]{6,32}\.[0-9a-z]{16,128}$/.test(key)) {
    throw new ConfigurationError(
      "client_missing_credential",
      "The API key is malformed. Expected `ipk_live_<prefix>.<secret>` or `ipk_test_<prefix>.<secret>`.",
    );
  }
}

/** Resolve a raw config into a validated one. Throws `ConfigurationError`. */
export function resolveConfig(config: IntentPayConfig): ResolvedConfig {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ConfigurationError("client_invalid_config", "`timeoutMs` must be a positive number.");
  }
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) {
    throw new ConfigurationError("client_invalid_config", "`maxRetries` must be an integer between 0 and 10.");
  }

  const apiKey = config.apiKey?.trim() || null;
  if (apiKey) {
    assertApiKeyShape(apiKey);
    if (isBrowserEnvironment() && !config.dangerouslyAllowBrowser) {
      throw new ConfigurationError(
        "client_credential_in_browser",
        "Refusing to use an API key in a browser. Keep the key on your server, or set `dangerouslyAllowBrowser` if you truly intend to expose it.",
      );
    }
  }

  const fetchImpl = config.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new ConfigurationError("client_invalid_config", "No `fetch` implementation is available. Pass `fetch` in the config.");
  }

  return { apiKey, baseUrl, timeoutMs, maxRetries, fetch: fetchImpl };
}
