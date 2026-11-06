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

/**
 * Origins an *injected* wallet's own provider may talk to from the page.
 *
 * A page-world EIP-1193 provider (Trust Wallet's Android in-app browser is the
 * concrete case) does not just sign — it answers `eth_chainId`/`eth_call` by
 * proxying to the wallet's own node. That fetch runs in our page's context, so
 * our `connect-src` governs it. With the origin omitted, the browser refuses the
 * request before it leaves the device: the user sees "Couldn't connect to the
 * wallet" and, when the wallet reports it, "Failed to connect to
 * http://<wallet-rpc>". Discovery and selection worked; the *chain read* was
 * blocked, so the connection could never complete — the reported regression.
 *
 * These are read-only public JSON-RPC endpoints of wallets the app advertises
 * support for; allowing the page to reach them restores direct injected-wallet
 * connection without re-enabling WalletConnect. It is a `connect-src` relaxation
 * only — no script origin is added.
 */
const injectedWalletRpcOrigins = [
  // Trust Wallet "Node-as-a-Service" Monad Mainnet RPC (returns chain id 0x8f).
  "https://monad.twnodes.com",
];

/**
 * WalletConnect (Reown) v2 is opt-in. Only when a project id is configured do
 * we relax the CSP for the relay websocket, the verify/explorer APIs and the
 * QR modal iframe (`secure.walletconnect.org`). A deployment without
 * WalletConnect keeps `frame-src 'none'` and no third-party origins.
 */
const wcEnabled = Boolean(process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID);

const walletConnectConnectSrc = [
  "https://relay.walletconnect.com",
  "https://relay.walletconnect.org",
  "wss://relay.walletconnect.com",
  "wss://relay.walletconnect.org",
  "https://echo.walletconnect.com",
  "https://verify.walletconnect.com",
  "https://verify.walletconnect.org",
  "https://pulse.walletconnect.org",
  "https://rpc.walletconnect.org",
  "https://api.web3modal.org",
];

const walletConnectFrameSrc = [
  "https://secure.walletconnect.org",
  "https://secure-mobile.walletconnect.com",
  "https://secure-mobile.walletconnect.org",
];

/**
 * The QR modal (`@reown/appkit`) renders wallet logos from the Web3Modal API and
 * loads its own web font. Without these the modal opens but its wallet list and
 * typography fail to load — which on mobile reads as "the QR never appears".
 */
const walletConnectImgSrc = ["https://api.web3modal.org"];
const walletConnectFontSrc = ["https://fonts.reown.com"];

const connectSrc = [
  "'self'",
  ...browserRpcOrigins,
  ...injectedWalletRpcOrigins,
  ...(wcEnabled ? walletConnectConnectSrc : []),
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
  `img-src 'self' data: blob: https://raw.githubusercontent.com${wcEnabled ? ` ${walletConnectImgSrc.join(" ")}` : ""}`,
  `font-src 'self' data:${wcEnabled ? ` ${walletConnectFontSrc.join(" ")}` : ""}`,
  `connect-src ${connectSrc.join(" ")}`,
  "worker-src 'self' blob:",
  `frame-src ${wcEnabled ? walletConnectFrameSrc.join(" ") : "'none'"}`,
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
