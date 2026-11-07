/**
 * The canonical origin this deployment advertises.
 *
 * Used for metadata (canonical link, Open Graph/Twitter URLs), `robots.txt` and
 * `sitemap.xml`. Overridable so a self-hosted instance points at its own host
 * rather than the production Vercel domain.
 */
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, "") ||
  "https://intent-pay-roan.vercel.app"
);

export const SITE_NAME = "Intent Pay";
export const SITE_TITLE = "Intent Pay — Pay anyone the token they asked for";
export const SITE_DESCRIPTION =
  "Intent-based payments on Monad. Say who receives, how much and which token; Intent Pay finds the route and prepares one transaction you approve in your own wallet. You keep your keys; settlement is verified on-chain.";

/** Every indexable route. Kept in one place so the sitemap cannot drift. */
export const PUBLIC_ROUTES: { path: string; priority: number }[] = [
  { path: "/", priority: 1 },
  { path: "/product", priority: 0.9 },
  { path: "/developers", priority: 0.9 },
  { path: "/merchants", priority: 0.9 },
  { path: "/docs", priority: 0.8 },
  { path: "/docs/litepaper", priority: 0.7 },
  { path: "/docs/how-it-works", priority: 0.6 },
  { path: "/docs/architecture", priority: 0.6 },
  { path: "/docs/security", priority: 0.6 },
  { path: "/docs/roadmap", priority: 0.5 },
  { path: "/docs/faq", priority: 0.6 },
  { path: "/docs/quickstart", priority: 0.7 },
  { path: "/docs/developers", priority: 0.5 },
  { path: "/docs/api", priority: 0.6 },
  { path: "/docs/checkout", priority: 0.7 },
];
