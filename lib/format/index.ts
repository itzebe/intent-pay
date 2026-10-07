/** Money + address formatting helpers shared by UI and server. */

export function formatUsd(value: number, opts?: { compact?: boolean }): string {
  if (!Number.isFinite(value)) return "$0.00";
  // A tiny negative (e.g. a rounded-down -0.001) must never render as "$-0.00".
  const safe = Object.is(value, -0) ? 0 : value;
  if (opts?.compact && Math.abs(safe) >= 1000) {
    return `$${(safe / 1000).toFixed(1)}k`;
  }
  // Money rounds to cents: anything that renders below a cent is "0.00", and a
  // negative value that rounds to zero is not a negative amount.
  const cents = Math.round(Math.abs(safe) * 100) / 100;
  const signed = safe < 0 && cents > 0 ? -cents : cents;
  return `$${signed.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Format a decimal token amount with sensible significant digits. */
export function formatAmount(amount: string, maxFrac = 6): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "0";
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 1000) {
    return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
  if (abs >= 1) {
    return n.toLocaleString("en-US", { maximumFractionDigits: Math.min(maxFrac, 4) });
  }
  // Small numbers: show enough significant digits to be meaningful, but never
  // so many that a sub-wei rounding artifact renders as scientific notation.
  return n.toLocaleString("en-US", { maximumSignificantDigits: 4 });
}

export function shortAddress(address: string, chars = 4): string {
  if (!address || address.length < 2 + chars * 2) return address;
  return `${address.slice(0, 2 + chars)}...${address.slice(-chars)}`;
}

export function isEvmAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test((value ?? "").trim());
}

export function formatRate(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return "—";
  if (rate >= 1) {
    return `1 → ${rate.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
  }
  return `1 → ${rate.toLocaleString("en-US", { maximumSignificantDigits: 4 })}`;
}

export function formatGasUsd(value: number): string {
  if (!Number.isFinite(value) || value < 0.01) return "<$0.01";
  return formatUsd(value);
}

/**
 * Format a price-impact fraction (0.0012 === 0.12%) for display. Returns null
 * when the value is not a usable number, so callers can say "unavailable"
 * rather than showing a fabricated zero.
 */
export function formatImpact(fraction: number | null | undefined): string | null {
  if (fraction === null || fraction === undefined) return null;
  if (!Number.isFinite(fraction) || fraction < 0) return null;
  const pct = fraction * 100;
  if (pct >= 1) return `${pct.toFixed(2)}%`;
  if (pct >= 0.01) return `${pct.toFixed(2)}%`;
  if (pct === 0) return "0.00%";
  // Extremely small but real: show up to two significant digits.
  return `${pct.toPrecision(2)}%`;
}

/** "$5.00 USDT" — the payment's headline form (USD notional + token). */
export function usdTokenLabel(usd: number, symbol: string): string {
  return `${formatUsd(usd)} ${symbol}`;
}
