/**
 * Application-owned RPC endpoint policy.
 *
 * Intent Pay performs its own chain reads — balances, token metadata, quotes,
 * gas price, receipts and settlement verification — through its *own* HTTPS
 * clients (`lib/server/rpc.ts`, `lib/wallet/clients.ts`). The user's wallet is
 * only ever asked to authorise a transaction; it is never the source of these
 * reads.
 *
 * One rule is enforced here so it cannot drift across the app: every endpoint an
 * application-owned client may use is **HTTPS**. A plaintext `http://` endpoint
 * is rejected outright rather than silently downgrading the transport — and a
 * page served over HTTPS cannot reach one anyway, because the CSP blocks it and
 * the mixed-content policy refuses it. Keeping the guarantee in one place means
 * a misconfigured `*_RPC_URL` fails loudly here instead of surfacing as a
 * confusing, per-user "network" failure at payment time.
 *
 * This module is pure (no viem, no React, no env reads) so the policy is
 * unit-testable on its own and reusable from both the browser and the server.
 */

/** True only for a well-formed `https:` URL. */
export function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Keep only the HTTPS endpoints, de-duplicated, preserving order.
 *
 * This is the single gate applied to every application-owned RPC list. An
 * `http://` (or otherwise malformed) entry is dropped rather than used, so a
 * chain read can never depend on a plaintext or invalid transport.
 */
export function httpsEndpoints(urls: readonly (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const url of urls) {
    if (!url || !isHttpsUrl(url)) continue;
    if (!out.includes(url)) out.push(url);
  }
  return out;
}
