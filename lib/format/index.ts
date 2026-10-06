/** Money + address formatting helpers shared by UI and server. */

export function formatUsd(value: number, opts?: { compact?: boolean }): string {
  if (!Number.isFinite(value)) return "$0.00";
  if (opts?.compact && Math.abs(value) >= 1000) {
    return `$${(value / 1000).toFixed(1)}k`;
  }
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Format a decimal token amount with sensible significant digits. */
export function formatAmount(amount: string, maxFrac = 6): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "0";
  if (n === 0) return "0";
  if (Math.abs(n) >= 1000) {
    return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
  if (Math.abs(n) >= 1) {
    return n.toLocaleString("en-US", { maximumFractionDigits: Math.min(maxFrac, 4) });
  }
  // Small numbers: show enough significant digits to be meaningful.
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

/** "$5.00 USDT" — the payment's headline form (USD notional + token). */
export function usdTokenLabel(usd: number, symbol: string): string {
  return `${formatUsd(usd)} ${symbol}`;
}
