/**
 * Latest-only guard for versioned asynchronous work.
 *
 * The flow issues several async computations (quotes, optimizer runs, route
 * lookups). If a slow request resolves after the user has moved on, its result
 * must NOT overwrite the state belonging to the newer request. This guard
 * implements that rule: only the newest request id for the current intent
 * version is allowed to write.
 *
 * It is deliberately pure (no React, no network) so the "slow route followed by
 * a newer route" race can be unit-tested deterministically.
 */
export type LatestGuard = {
  /**
   * Begin a request for `intentVersion`. Returns a request id that must be
   * checked with `isCurrent` before its result is applied.
   */
  issue(intentVersion: number): number;
  /** Invalidate every outstanding request (e.g. on unmount). */
  invalidate(): void;
  /**
   * True when `id` is still the newest request AND the intent version it was
   * issued for is still the current version.
   */
  isCurrent(id: number, intentVersion: number): boolean;
  /** The request id of the newest issued request. */
  latestId(): number;
};

export function createLatestGuard(): LatestGuard {
  let seq = 0;
  let issuedVersion = -1;
  return {
    issue(intentVersion: number) {
      seq += 1;
      issuedVersion = intentVersion;
      return seq;
    },
    invalidate() {
      seq += 1;
    },
    isCurrent(id: number, intentVersion: number) {
      return id === seq && intentVersion === issuedVersion;
    },
    latestId() {
      return seq;
    },
  };
}
