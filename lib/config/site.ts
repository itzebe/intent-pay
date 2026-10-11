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
export const SITE_TITLE = "Intent Pay — Review the route. Send on Monad.";
export const SITE_DESCRIPTION =
  "Intent-based payments on Monad. Tell Intent Pay what you want to pay, review the route, and confirm your payment from one simple interface.";

/** Every indexable route. Kept in one place so the sitemap cannot drift. */
export const PUBLIC_ROUTES: { path: string; priority: number }[] = [
  { path: "/", priority: 1 },
  { path: "/docs", priority: 0.8 },
  { path: "/docs/litepaper", priority: 0.7 },
  { path: "/docs/how-it-works", priority: 0.6 },
  { path: "/docs/architecture", priority: 0.6 },
  { path: "/docs/security", priority: 0.6 },
  { path: "/docs/roadmap", priority: 0.5 },
  { path: "/docs/faq", priority: 0.6 },
  { path: "/docs/developers", priority: 0.5 },
];
