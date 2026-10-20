/** @type {import('next').NextConfig} */
const isDev = process.env.NODE_ENV !== "production";

/** Origin of a configured URL, or null when unset/invalid. */
function originOf(url) {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Hosts the *browser* is allowed to read chain state from. Derived from the
 * same env the app uses, so a self-hosted deploy that points at its own RPC does
 * not get blocked by CSP. Wallet-injected scripts run in an isolated world and
 * are not subject to page CSP, so this list is only about our own `connect-src`.
 */
const browserRpcOrigins = [
  originOf(process.env.NEXT_PUBLIC_MONAD_RPC_URL) ?? "https://rpc.monad.xyz",
  originOf(process.env.NEXT_PUBLIC_MONAD_TESTNET_RPC_URL),
  process.env.NEXT_PUBLIC_ALCHEMY_API_KEY ? "https://monad-mainnet.g.alchemy.com" : null,
].filter(Boolean);

const connectSrc = [
  "'self'",
  ...browserRpcOrigins,
  // Wallet extension bridges that a page-world provider may talk through.
  "chrome-extension:",
  "moz-extension:",
  ...(isDev ? ["ws:", "wss:", "http://localhost:*"] : []),
];

/**
 * Content Security Policy.
 *
 * Scoped to what the app actually loads: no third-party script origins, no
 * iframes, token logos from the official Monad list on GitHub, and chain reads
 * from our own /api routes plus the configured Monad RPC. `script-src` keeps
 * `'unsafe-inline'` because Next.js ships an inline hydration bootstrap and
 * injected wallets may add their provider through a page script; `'unsafe-eval'`
 * is added in development only (Next fast-refresh).
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""} chrome-extension: moz-extension:`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://raw.githubusercontent.com",
  "font-src 'self' data:",
  `connect-src ${connectSrc.join(" ")}`,
  "worker-src 'self' blob:",
  "frame-src 'none'",
  "child-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  ...(isDev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
  // Allow wallet popups to keep a reference to us, but never share our window
  // object with a cross-origin page.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
];

const nextConfig = {
  reactStrictMode: true,
  eslint: { ignoreDuringBuilds: true },
  serverExternalPackages: ["viem", "@neondatabase/serverless"],
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Wallet-derived data (balances, quotes, optimizations) is per-user and
      // must never be stored by a shared cache.
      { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
    ];
  },
};

export default nextConfig;
