/**
 * Bundler endpoint resolution.
 *
 * The Pimlico API key is server-side only. In the browser the bundler client
 * therefore points at our own `/api/aa/rpc` proxy, which forwards an allowlisted
 * set of JSON-RPC methods to Pimlico. On the server (tests, diagnostics) the
 * real authenticated endpoint is used directly.
 *
 * Nothing here ever returns a key to the client.
 */
export function aaRpcUrl(): string {
  if (typeof window === "undefined") {
    // Server: talk to Pimlico directly when a key is present.
    const key = process.env.PIMLICO_API_KEY;
    const chainId = process.env.PIMLICO_CHAIN_ID ?? "143";
    if (key && key.trim()) {
      return `https://api.pimlico.io/v2/${chainId}/rpc?apikey=${encodeURIComponent(key)}`;
    }
    // No key: fall back to the public prototype endpoint for local dev only.
    // Production must configure PIMLICO_API_KEY (see .env.example).
    return `https://public.pimlico.io/v2/${chainId}/rpc`;
  }
  // Browser: always through the same-origin proxy; the key stays on the server.
  return "/api/aa/rpc";
}

/** The bundler proxy path (shared by the route and the client). */
export const AA_RPC_PATH = "/api/aa/rpc";

/** The paymaster proxy path. */
export const AA_PAYMASTER_PATH = "/api/aa/paymaster";
