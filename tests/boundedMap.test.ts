import { describe, expect, it } from "vitest";
import { BoundedMap } from "@/lib/util/boundedMap";

/**
 * BoundedMap bounds the memory of every per-address server cache. These tests pin
 * the two properties that matter: it never exceeds its capacity, and it evicts the
 * least-recently-used entry (so a hot key survives a flood of one-shot keys).
 */
describe("BoundedMap", () => {
  it("never grows past its capacity", () => {
    const map = new BoundedMap<number, number>(3);
    for (let i = 0; i < 100; i++) map.set(i, i);
    expect(map.size).toBe(3);
  });

  it("evicts the least-recently-used entry, not the most recent", () => {
    const map = new BoundedMap<string, number>(2);
    map.set("a", 1);
    map.set("b", 2);
    // Touch "a" so "b" becomes the least-recently-used.
    expect(map.get("a")).toBe(1);
    map.set("c", 3);
    expect(map.has("b")).toBe(false);
    expect(map.has("a")).toBe(true);
    expect(map.has("c")).toBe(true);
  });

  it("overwriting a key does not count as a new entry", () => {
    const map = new BoundedMap<string, number>(1);
    map.set("a", 1);
    map.set("a", 2);
    expect(map.size).toBe(1);
    expect(map.get("a")).toBe(2);
  });

  it("rejects a non-positive capacity", () => {
    expect(() => new BoundedMap<string, number>(0)).toThrow();
  });
});
