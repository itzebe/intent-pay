/**
 * Referral configuration.
 *
 * The canonical origin is configuration, never a request header: a referral link
 * must not be forgeable by sending a spoofed `Host`. The origin is validated and
 * normalised once here so every link is built from a trusted value.
 */

/** The query parameter that carries a referral code. */
export const REFERRAL_PARAM = "ref";

/** Referral code prefix (illustrative format: INTENT-7K4M9Q). */
export const REFERRAL_PREFIX = "INTENT";

/** How long after a click/attribution a referral remains valid. */
export const ATTRIBUTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** The maximum number of attributed (unqualified) referrals one referrer may hold. */
export const MAX_ATTRIBUTIONS_PER_REFERRER = 1000;

/**
 * The canonical production origin for referral links.
 *
 * Preference order: an explicit `INTENT_PAY_PUBLIC_ORIGIN`, else Vercel's
 * production URL, else a safe default. A malformed value is ignored rather than
 * emitted into a link.
 */
export function referralOrigin(): string {
  const candidates = [
    process.env.INTENT_PAY_PUBLIC_ORIGIN,
    process.env.NEXT_PUBLIC_SITE_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : undefined,
    "https://intent-pay-roan.vercel.app",
  ];
  for (const c of candidates) {
    const origin = normalizeOrigin(c);
    if (origin) return origin;
  }
  return "https://intent-pay-roan.vercel.app";
}

/** Accept only an http(s) origin with no path/query; reject anything else. */
export function normalizeOrigin(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}
