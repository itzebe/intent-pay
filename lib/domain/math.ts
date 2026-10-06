/** Parse a user-entered decimal string into base units (bigint). */
export function parseUnits(value: string, decimals: number): bigint {
  const clean = (value ?? "").trim();
  if (!/^\d*\.?\d*$/.test(clean) || clean === "" || clean === ".") {
    throw new Error("Invalid amount");
  }
  const [whole, frac = ""] = clean.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const wholePart = whole === "" ? "0" : whole;
  const combined = `${wholePart}${fracPadded}`.replace(/^0+/, "") || "0";
  return BigInt(combined);
}

/** Format base units (bigint) into a decimal string. */
export function formatUnits(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const s = abs.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals) || "0";
  const frac = decimals > 0 ? s.slice(s.length - decimals) : "";
  const fracTrimmed = frac.replace(/0+$/, "");
  const out = fracTrimmed ? `${whole}.${fracTrimmed}` : whole;
  return negative ? `-${out}` : out;
}

/** Multiply a decimal-string amount by a USD price without precision loss. */
export function amountToUsd(amount: string, priceUsd: number): number {
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;
  return n * priceUsd;
}

export function usdToAmount(usd: number, priceUsd: number): string {
  if (!Number.isFinite(usd) || !Number.isFinite(priceUsd) || priceUsd <= 0) {
    return "0";
  }
  return (usd / priceUsd).toString();
}

export function isPositiveDecimal(value: string): boolean {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

