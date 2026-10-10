import { describe, expect, it, vi } from "vitest";
import { TtlCache } from "@/lib/server/http";
import { createLatestGuard } from "@/lib/domain/latest";
import { registerToken, getTokenByAddress, tintForAddress } from "@/lib/config/tokens";

/**
 * Concurrency & shared-state safety.
 *
 * Intent Pay has no per-user server session: the client owns the canonical
 * intent, and the server is a stateless request handler over *process-wide*
 * provider caches. The two risks that follow are (1) two concurrent users
 * sharing a mutable cache and having their data mixed up, and (2) a per-tab
 * async result from an older request overwriting a newer one. These tests prove
 * the shared primitives are safe under interleaving, and that per-request data
 * is keyed by the user-supplied identity, never a global.
 */

/** Deterministically interleave N async producers so all are in flight at once. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("TtlCache: in-flight de-duplication and per-key isolation", () => {
  it("coalesces concurrent misses for the SAME key into one producer call", async () => {
    const cache = new TtlCache<string, string>(60_000);
    let calls = 0;
    const gate = deferred<void>();
    const produce = vi.fn(async () => {
      calls += 1;
      await gate.promise;
      return "value-for-A";
    });

    // 25 users ask for the same cached key at the same time.
    const promises = Array.from({ length: 25 }, () => cache.get("A", produce));
    // Let the coalesced producer run, then release it.
    await Promise.resolve();
    gate.resolve();
    const results = await Promise.all(promises);

    expect(calls).toBe(1); // one upstream call, not 25
    expect(new Set(results)).toEqual(new Set(["value-for-A"]));
  });

  it("never mixes values across different keys under interleaving", async () => {
    const cache = new TtlCache<string, string>(60_000);
    const gates = new Map<string, ReturnType<typeof deferred<string>>>();
    const produce = (key: string) => async () => {
      const g = deferred<string>();
      gates.set(key, g);
      return g.promise;
    };

    const keys = ["user:1", "user:2", "user:3"];
    const promises = keys.map((k) => cache.get(k, produce(k)));

    // Resolve out of order: user:3 first, then user:1, then user:2.
    for (const k of ["user:3", "user:1", "user:2"]) gates.get(k)!.resolve(`bal:${k}`);

    const [a, b, c] = await Promise.all(promises);
    expect(a).toBe("bal:user:1");
    expect(b).toBe("bal:user:2");
    expect(c).toBe("bal:user:3");
  });

  it("a rejected producer does not poison the key (next caller retries)", async () => {
    const cache = new TtlCache<string, string>(60_000);
    const first = deferred<string>();
    let call = 0;
    const produce = () => {
      call += 1;
      if (call === 1) return first.promise;
      return Promise.resolve("recovered");
    };

    const p1 = cache.get("K", produce);
    first.reject(new Error("provider down"));
    await expect(p1).rejects.toThrow("provider down");

    // The failed in-flight entry must be cleared so a later request re-produces.
    const p2 = await cache.get("K", produce);
    expect(p2).toBe("recovered");
    expect(call).toBe(2);
  });

  it("serves a cached value until TTL expiry, then re-produces", async () => {
    const cache = new TtlCache<string, number>(10);
    let calls = 0;
    const produce = async () => ++calls;
    expect(await cache.get("K", produce)).toBe(1);
    expect(await cache.get("K", produce)).toBe(1); // hit, no new call
    await new Promise((r) => setTimeout(r, 20));
    expect(await cache.get("K", produce)).toBe(2); // expired -> re-produce
  });
});

describe("token registry: concurrent discovery cannot corrupt identity", () => {
  it("registering the same address from many 'users' yields one stable record", async () => {
    const address = "0x00000000000000000000000000000000c0ffee01" as `0x${string}`;
    // Simulate N concurrent discoveries of the same token (all must agree).
    await Promise.all(
      Array.from({ length: 50 }, () =>
        Promise.resolve(
          registerToken({
            symbol: "NEW",
            name: "New Token",
            address,
            decimals: 18,
            fallbackUsd: 0,
            tint: tintForAddress(address),
            source: "onchain",
          }),
        ),
      ),
    );
    const stored = getTokenByAddress(address);
    expect(stored?.symbol).toBe("NEW");
    expect(stored?.decimals).toBe(18);
    // A later, *less trusted* source must not downgrade the record.
    registerToken({
      symbol: "WRONG",
      name: "Spoof",
      address,
      decimals: 6,
      fallbackUsd: 0,
      tint: tintForAddress(address),
      source: "wallet",
    });
    expect(getTokenByAddress(address)?.symbol).toBe("NEW");
    expect(getTokenByAddress(address)?.decimals).toBe(18);
  });
});

describe("latest-only guard: an old async result never overwrites a newer one", () => {
  it("only the newest request for the current intent version may write", () => {
    const guard = createLatestGuard();

    // User types; request for v1 is slow.
    const slow = guard.issue(1);
    // User edits; v2 request issued after.
    const fast = guard.issue(2);

    // v2 resolves first, then the stale v1 resolves late.
    expect(guard.isCurrent(fast, 2)).toBe(true);
    expect(guard.isCurrent(slow, 1)).toBe(false); // stale: a newer id exists
    expect(guard.isCurrent(slow, 2)).toBe(false); // stale version too
  });

  it("invalidating (unmount) rejects every outstanding request", () => {
    const guard = createLatestGuard();
    const id = guard.issue(1);
    expect(guard.isCurrent(id, 1)).toBe(true);
    guard.invalidate();
    expect(guard.isCurrent(id, 1)).toBe(false);
  });
});
