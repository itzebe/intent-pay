import { fetchWithTimeout, TtlCache } from "@/lib/server/http";
import { isEvmAddress } from "@/lib/format";
import { toBigInt, estimateUserOpGas, estimateTokenCost, formatTokenAmount } from "@/lib/aa/gasCost";
import type {
  GasTokenQuote,
  PaymasterProvider,
  PaymasterQuote,
  PaymasterToken,
  SupportedTokensResult,
} from "./types";

/**
 * Pimlico paymaster provider (Monad Mainnet, chain 143).
 *
 * This is the *only* thing that decides whether an ERC-20 can pay gas. It asks
 * Pimlico directly — there is no local allow-list. Discovery failure is a
 * first-class `{ ok: false }`, never an empty-but-successful list, so a provider
 * outage can never be mistaken for "this token isn't supported".
 *
 * The API key is read from a server-side env var and never returned to a client.
 * The browser reaches the provider through the `/api/aa/*` proxy routes, which
 * forward only an allowlisted set of JSON-RPC methods.
 *
 * Verified live against Monad mainnet:
 *   - eth_chainId                → 0x8f (143)
 *   - eth_supportedEntryPoints   → v0.6/v0.7/v0.8/v0.9
 *   - pimlico_getSupportedTokens → USDC (0x754704…603), WMON (0x3bd359…433A)
 *   - pimlico_getTokenQuotes     → { paymaster, postOpGas, exchangeRate, … }
 */

/** Pimlico production API base (authenticated). */
const PIMLICO_BASE = "https://api.pimlico.io/v2";

/** Characterise a failure without leaking a secret. */
function reason(err: unknown): string {
  const e = err as { name?: string; message?: string };
  if (e?.name === "AbortError") return "Request timed out";
  const msg = e?.message ?? "Request failed";
  return msg.length > 160 ? msg.slice(0, 160) : msg;
}

type JsonRpcResponse = { result?: unknown; error?: { message?: string; code?: number } };

/** Raw JSON-RPC call to the authenticated Pimlico endpoint. */
export async function pimlicoRpc(
  apiKey: string,
  chainId: number,
  method: string,
  params: unknown[],
  timeoutMs = 8000,
): Promise<unknown> {
  const url = `${PIMLICO_BASE}/${chainId}/rpc?apikey=${encodeURIComponent(apiKey)}`;
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    timeoutMs,
  });
  const json = (await res.json()) as JsonRpcResponse;
  if (json.error) throw new Error(json.error.message ?? "JSON-RPC error");
  return json.result;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Parse and normalise a provider token entry. Returns null when malformed. */
export function parseProviderToken(
  raw: unknown,
  chainId: number,
): PaymasterToken | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  const address = String(t.token ?? t.address ?? "").trim();
  if (!isEvmAddress(address)) return null;
  const decimals = toNumber(t.decimals);
  const symbol = typeof t.symbol === "string" && t.symbol.trim() ? t.symbol.trim() : "Unknown";
  const name = typeof t.name === "string" && t.name.trim() ? t.name.trim() : symbol;
  return {
    chainId,
    address: address as `0x${string}`,
    symbol,
    name,
    // A missing/!sane decimals is defaulted but flagged by the caller through
    // metadata cross-check; we never scale a token by an unvalidated value.
    decimals: decimals !== undefined && Number.isInteger(decimals) && decimals >= 0 && decimals <= 36 ? decimals : 18,
  };
}

const discoveryCache = new TtlCache<string, SupportedTokensResult>(60_000);
const healthCache = new TtlCache<string, { reachable: boolean; error?: string }>(60_000);

/**
 * The Pimlico provider. `apiKey` is injected so the module is testable without
 * a live key and so nothing here reads global env implicitly.
 */
export function createPimlicoProvider(apiKey?: string, chainIdDefault = 143): PaymasterProvider {
  const configured = () => Boolean(apiKey && apiKey.trim());

  return {
    id: "pimlico",
    configured,

    async supportedTokens(chainId: number = chainIdDefault): Promise<SupportedTokensResult> {
      const at = Date.now();
      if (!configured()) {
        return { ok: false, reason: "PIMLICO_API_KEY is not set", at, source: "pimlico" };
      }
      return discoveryCache.get(`tokens:${chainId}:${apiKey!.slice(-4)}`, async () => {
        try {
          const result = await pimlicoRpc(apiKey!, chainId, "pimlico_getSupportedTokens", []);
          if (!Array.isArray(result)) {
            return { ok: false, reason: "Provider returned a non-list for supported tokens", at: Date.now(), source: "pimlico" };
          }
          const tokens: PaymasterToken[] = [];
          for (const entry of result) {
            const t = parseProviderToken(entry, chainId);
            // Guard against cross-chain contamination: only chain 143 entries
            // are ever accepted as gas tokens for Monad.
            if (t && t.chainId === chainId) tokens.push(t);
          }
          // De-duplicate by canonical identity, keeping the first (provider order
          // is irrelevant — selection is deterministic and address-keyed).
          const seen = new Set<string>();
          const unique = tokens.filter((t) => {
            const k = t.address.toLowerCase();
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });
          return { ok: true, tokens: unique, at: Date.now(), source: "pimlico" };
        } catch (err) {
          return { ok: false, reason: reason(err), at: Date.now(), source: "pimlico" };
        }
      });
    },

    async quote({ chainId, entryPoint, token, userOperation, method }): Promise<PaymasterQuote | null> {
      if (!configured()) return null;
      try {
        // Pimlico exposes two distinct ERC-20 paymaster methods and only one is
        // valid at each stage of preparing a UserOperation:
        //   - `pm_getPaymasterStubData` fills stub paymaster fields so the
        //     operation can be gas-estimated (it does NOT require the final gas
        //     fields, and it is the ONLY method a bundler will serve before gas
        //     estimation);
        //   - `pm_getPaymasterData` returns the signed payload for submission and
        //     REQUIRES `paymasterVerificationGasLimit` plus the operation's gas
        //     fields, i.e. it can only succeed AFTER estimation.
        // Always calling the data method (the previous behaviour) made every
        // preparation fail with "The paymaster did not return a quote." because
        // the operation had not been estimated yet.
        const rpcMethod = method ?? "pm_getPaymasterStubData";
        const result = (await pimlicoRpc(apiKey!, chainId, rpcMethod, [
          userOperation,
          entryPoint,
          "0x" + chainId.toString(16),
          { token: token.address },
        ])) as Record<string, unknown> | undefined;
        if (!result) return null;

        // Some entries also carry the quote fields; fetch the token quote when
        // the payload omits the exchange rate.
        let exchangeRate = toBigInt(result.exchangeRate);
        let postOpGas = toBigInt(result.paymasterPostOpGasLimit);
        let balanceSlot = 0n;
        let allowanceSlot = 0n;
        if (exchangeRate === 0n || postOpGas === 0n || balanceSlot === 0n) {
          try {
            const q = (await pimlicoRpc(apiKey!, chainId, "pimlico_getTokenQuotes", [
              { tokens: [token.address] },
              entryPoint,
              chainId,
            ])) as { quotes?: Record<string, unknown>[] } | undefined;
            const first = q?.quotes?.[0];
            if (first) {
              if (exchangeRate === 0n) exchangeRate = toBigInt(first.exchangeRate);
              if (postOpGas === 0n) postOpGas = toBigInt(first.postOpGas);
              balanceSlot = toBigInt(first.balanceSlot);
              allowanceSlot = toBigInt(first.allowanceSlot);
            }
          } catch {
            /* the quote fields are best-effort; the payload is authoritative */
          }
        }

        const paymaster = String(result.paymaster ?? "") as `0x${string}`;
        const paymasterData = String(result.paymasterData ?? "") as `0x${string}`;
        if (!isEvmAddress(paymaster) || !paymasterData.startsWith("0x")) return null;

        const gasEstimate = estimateUserOpGas(userOperation);
        const tokenAmount = estimateTokenCost(gasEstimate, exchangeRate, toBigInt(userOperation.maxFeePerGas));
        return {
          token,
          gasEstimate,
          tokenAmount,
          tokenAmountDecimal: formatTokenAmount(tokenAmount, token.decimals),
          paymaster,
          paymasterData,
          paymasterPostOpGasLimit: postOpGas > 0n ? postOpGas : undefined,
          paymasterVerificationGasLimit:
            toBigInt(result.paymasterVerificationGasLimit) > 0n
              ? toBigInt(result.paymasterVerificationGasLimit)
              : undefined,
          exchangeRate,
          postOpGas: postOpGas > 0n ? postOpGas : 0n,
          balanceSlot: balanceSlot > 0n ? balanceSlot : undefined,
          allowanceSlot: allowanceSlot > 0n ? allowanceSlot : undefined,
          validUntil: toNumber(result.validUntil) ?? toNumber(result.valid_until),
          at: Date.now(),
        };
      } catch {
        return null;
      }
    },

    async gasQuote({ chainId, entryPoint, token }): Promise<GasTokenQuote | null> {
      if (!configured()) return null;
      try {
        const q = (await pimlicoRpc(apiKey!, chainId, "pimlico_getTokenQuotes", [
          { tokens: [token.address] },
          entryPoint,
          chainId,
        ])) as { quotes?: Record<string, unknown>[] } | undefined;
        const first = q?.quotes?.[0];
        if (!first) return null;
        const paymaster = String(first.paymaster ?? "") as `0x${string}`;
        if (!isEvmAddress(paymaster)) return null;
        const exchangeRate = toBigInt(first.exchangeRate);
        if (exchangeRate <= 0n) return null;
        const balanceSlot = toBigInt(first.balanceSlot);
        const allowanceSlot = toBigInt(first.allowanceSlot);
        return {
          token,
          paymaster,
          exchangeRate,
          postOpGas: toBigInt(first.postOpGas),
          balanceSlot: balanceSlot > 0n ? balanceSlot : undefined,
          allowanceSlot: allowanceSlot > 0n ? allowanceSlot : undefined,
          at: Date.now(),
        };
      } catch {
        return null;
      }
    },

    async reachable(chainId: number = chainIdDefault) {
      if (!configured()) return { reachable: false, error: "PIMLICO_API_KEY is not set" };
      return healthCache.get(`health:${chainId}:${apiKey!.slice(-4)}`, async () => {
        try {
          const id = await pimlicoRpc(apiKey!, chainId, "eth_chainId", []);
          if (id !== "0x8f") {
            return { reachable: false, error: `Pimlico answered chainId ${String(id)} (expected 0x8f)` };
          }
          return { reachable: true };
        } catch (err) {
          return { reachable: false, error: reason(err) };
        }
      });
    },
  };
}

// The gas-cost math is single-sourced in `lib/aa/gasCost.ts` (pure, client-safe)
// and re-exported here so existing server callers keep their import path.
export { estimateUserOpGas, estimateTokenCost, formatTokenAmount, toBigInt } from "@/lib/aa/gasCost";
