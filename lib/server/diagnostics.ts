import type { MonadNetwork } from "@/lib/config/chains";
import { fetchWithTimeout, TtlCache } from "@/lib/server/http";
import { marketProviders } from "@/lib/server/pricing/market";
import { getToken } from "@/lib/config/tokens";
import { alchemyRpcUrl } from "@/lib/config/chains";

/**
 * Server-side integration diagnostics.
 *
 * These probes answer "is this provider configured *and* actually working on
 * Monad?" — not merely "is an environment variable present?". They never read
 * or return a secret value: only booleans, a masked key suffix, and a short,
 * non-sensitive error string.
 *
 * A configured-but-failing provider must be distinguishable from a missing one,
 * so the UI can say "configured but unreachable" instead of the misleading
 * "add an API key".
 */

const TTL_MS = 60 * 1000;
const cache = new TtlCache<string, IntegrationStatus>(TTL_MS);

export type IntegrationStatus = {
  /** The relevant environment variable is present. */
  configured: boolean;
  /** The provider answered a real request on the target network. */
  reachable: boolean;
  /** Provider disabled on purpose (e.g. ZERION_ENABLED=0). */
  disabled?: boolean;
  /** Last 4 characters of the key, so an operator can match it to Vercel. */
  keySuffix?: string;
  /** Non-sensitive reason when not reachable. */
  error?: string;
  /** When this status was measured. */
  at: number;
};

/** Last 4 characters of a secret — enough to identify, never enough to use. */
function suffix(secret: string | undefined): string | undefined {
  if (!secret || secret.length < 4) return undefined;
  return secret.slice(-4);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

/** A short, non-sensitive summary of why a fetch failed. */
function reason(err: unknown): string {
  const e = err as { name?: string; message?: string };
  if (e?.name === "AbortError") return "Request timed out";
  const msg = e?.message ?? "Request failed";
  return msg.length > 140 ? msg.slice(0, 140) : msg;
}

async function rpcCall(
  url: string,
  method: string,
  params: unknown[] = [],
  timeoutMs = 5000,
): Promise<unknown> {
  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      timeoutMs,
    },
  );
  const json = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (json.error) throw new Error(json.error.message ?? "JSON-RPC error");
  return json.result;
}

/**
 * Alchemy status: RPC transport and the Alchemy Prices source.
 *
 * `reachable` reflects the *RPC node*, which is what "Alchemy" means on the
 * integration strip. Alchemy is not used to sponsor or abstract gas — gas is
 * always paid in MON by the standard EOA path.
 */
export async function alchemyStatus(network: MonadNetwork = "mainnet"): Promise<IntegrationStatus> {
  const key = process.env.ALCHEMY_API_KEY;
  const at = Date.now();
  if (!key) {
    return { configured: false, reachable: false, at, error: "ALCHEMY_API_KEY is not set" };
  }
  return cache.get("alchemy", async () => {
    const rpcUrl = alchemyRpcUrl(network)!;
    try {
      const chainId = await rpcCall(rpcUrl, "eth_chainId");
      if (chainId !== "0x8f") {
        return {
          configured: true,
          reachable: false,
          keySuffix: suffix(key),
          error: `Alchemy RPC answered chainId ${String(chainId)} (expected 0x8f for Monad)`,
          at,
        };
      }
      return { configured: true, reachable: true, keySuffix: suffix(key), at };
    } catch (err) {
      return {
        configured: true,
        reachable: false,
        keySuffix: suffix(key),
        error: `${hostOf(rpcUrl)}: ${reason(err)}`,
        at,
      };
    }
  });
}

/** Zerion reachability on the configured network (Monad). */
export async function zerionStatus(): Promise<IntegrationStatus> {
  const key = process.env.ZERION_API_KEY;
  const at = Date.now();
  if (process.env.ZERION_ENABLED === "0") {
    return { configured: Boolean(key), reachable: false, disabled: true, at, error: "ZERION_ENABLED=0" };
  }
  if (!key) {
    return { configured: false, reachable: false, at, error: "ZERION_API_KEY is not set" };
  }
  return cache.get("zerion", async () => {
    const auth = `Basic ${Buffer.from(`${key}:`).toString("base64")}`;
    try {
      // Chain support matters: Zerion advertises many chains, but we must be
      // sure it serves the one we execute on.
      const res = await fetchWithTimeout("https://api.zerion.io/v1/chains/", {
        headers: { accept: "application/json", authorization: auth },
        timeoutMs: 6000,
      });
      if (!res.ok) {
        return { configured: true, reachable: false, keySuffix: suffix(key), error: `Zerion responded ${res.status}`, at };
      }
      const json = (await res.json()) as { data?: { id?: string }[] };
      const ids = (json.data ?? []).map((c) => (c?.id ?? "").toLowerCase());
      const chain = (process.env.ZERION_MONAD_CHAIN_ID ?? "monad").toLowerCase();
      if (ids.length && !ids.includes(chain)) {
        return {
          configured: true,
          reachable: false,
          keySuffix: suffix(key),
          error: `Zerion does not list chain "${chain}"`,
          at,
        };
      }
      return { configured: true, reachable: true, keySuffix: suffix(key), at };
    } catch (err) {
      return { configured: true, reachable: false, keySuffix: suffix(key), error: reason(err), at };
    }
  });
}

/** Alchemy Prices API reachability, using the same provider the app quotes with. */
export async function alchemyPricingStatus(network: MonadNetwork = "mainnet"): Promise<IntegrationStatus> {
  const key = process.env.ALCHEMY_API_KEY;
  const at = Date.now();
  if (!key) return { configured: false, reachable: false, at, error: "ALCHEMY_API_KEY is not set" };
  const provider = marketProviders.find((p) => p.name === "alchemy");
  if (!provider) {
    return { configured: true, reachable: false, keySuffix: suffix(key), error: "Alchemy price provider not registered", at };
  }
  const anchor = getToken("USDC") ?? getToken("USDT");
  if (!anchor) {
    return { configured: true, reachable: false, keySuffix: suffix(key), error: "No anchor token to price", at };
  }
  try {
    const price = await provider.price({ network, token: anchor, poolAddress: anchor.address });
    if (price && price > 0) {
      return { configured: true, reachable: true, keySuffix: suffix(key), at };
    }
    return { configured: true, reachable: false, keySuffix: suffix(key), error: "No price returned", at };
  } catch (err) {
    return { configured: true, reachable: false, keySuffix: suffix(key), error: reason(err), at };
  }
}
