/**
 * A Map with a hard entry cap and least-recently-used eviction.
 *
 * Every module-level cache in the server keyed by an untrusted, unbounded value
 * (a wallet address, a token address, a pool key) is a memory-exhaustion vector:
 * an attacker who can make the server cache a new key on each request grows the
 * process heap without limit, and on a serverless platform that is billed and
 * OOM-killed per instance. A `BoundedMap` gives the same read/write API as `Map`
 * but evicts the least-recently-used entry once the cap is reached, so memory is
 * O(cap) regardless of input.
 *
 * Reads refresh recency, so a hot key (a common token, a busy address) is not
 * evicted by a flood of one-shot keys.
 */
export class BoundedMap<K, V> {
  private map = new Map<K, V>();
  constructor(private readonly max: number) {
    if (max <= 0) throw new Error("BoundedMap requires a positive capacity.");
  }

  get size(): number {
    return this.map.size;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    // Refresh recency: delete + re-set moves the key to the tail.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): this {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    return this;
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  values(): IterableIterator<V> {
    return this.map.values();
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }

  entries(): IterableIterator<[K, V]> {
    return this.map.entries();
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.map.entries();
  }
}
