/**
 * The checkout payment-link token: a public, unguessable bearer handle.
 *
 * It is `chk_` + 64 hex characters (256 bits of CSPRNG entropy). The format check
 * is strict so a malformed token is rejected before any store lookup, and the
 * entropy makes a link impossible to enumerate.
 */
const TOKEN_RE = /^chk_[0-9a-f]{64}$/;

export function isValidCheckoutToken(token: string | null | undefined): boolean {
  return typeof token === "string" && TOKEN_RE.test(token);
}
