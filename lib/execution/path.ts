import { encodePacked, type Address } from "viem";

/** Encode a Uniswap V3 packed path. `reversed` builds an exact-output path. */
export function encodePath(
  tokens: Address[],
  fees: number[],
  reversed = false,
): `0x${string}` {
  const toks = reversed ? [...tokens].reverse() : tokens;
  const fs = reversed ? [...fees].reverse() : fees;
  const parts: `0x${string}`[] = [];
  for (let i = 0; i < toks.length; i++) {
    parts.push(toks[i]);
    if (i < fs.length) {
      parts.push(encodePacked(["uint24"], [fs[i]]) as `0x${string}`);
    }
  }
  return ("0x" + parts.map((p) => p.slice(2)).join("")) as `0x${string}`;
}
