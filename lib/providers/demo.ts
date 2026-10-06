import { allTokens, type TokenConfig } from "@/lib/config/tokens";
import { formatUnits, parseUnits } from "@/lib/domain/math";
import type {
  RouteQuoteRequest,
  RouteQuoteResult,
  RoutingProvider,
  UsdPrice,
} from "./types";

/** Deterministic spread applied to demo conversions (0.8%). */
const DEMO_SPREAD = 0.008;

function round(value: number, decimals: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  const units = parseUnits(value.toFixed(decimals), decimals);
  return formatUnits(units, decimals);
}

/**
 * Demo routing provider. Every value it returns is deterministic sample data
 * and is labelled `mode: "demo"` end-to-end so it can never be mistaken for a
 * live on-chain result. It exists so the concept is understandable in <30s.
 *
 * Amounts are USD-denominated to match the composer: "$5.00 SOL" means the
 * recipient should receive five dollars' worth of SOL.
 */
export class DemoProvider implements RoutingProvider {
  readonly name = "demo";
  readonly mode = "demo" as const;

  supports(token: TokenConfig): boolean {
    return allTokens().some((t) => t.address.toLowerCase() === token.address.toLowerCase());
  }

  async priceUsd(token: TokenConfig): Promise<UsdPrice> {
    // Demo pricing is deterministic sample data. A discovered token with no
    // shipped fallback price gets $1 so the demo stays explorable — and it is
    // always labelled as demo pricing.
    return { usd: token.fallbackUsd > 0 ? token.fallbackUsd : 1, source: "fallback" };
  }

  async availableSymbols(): Promise<string[]> {
    return allTokens().map((t) => t.symbol);
  }

  async quote(req: RouteQuoteRequest): Promise<RouteQuoteResult> {
    const { payToken, receiveToken, mode, amount } = req;
    const usd = req.usd !== false;
    const spread = 1 - DEMO_SPREAD;
    const priceOf = (t: TokenConfig) => (t.fallbackUsd > 0 ? t.fallbackUsd : 1);

    if (payToken.symbol === receiveToken.symbol) {
      const units = usd
        ? round(Number(amount) / priceOf(receiveToken), receiveToken.decimals)
        : amount;
      return {
        ok: true,
        route: { kind: "direct", hops: [], path: [payToken.symbol, receiveToken.symbol] },
        payAmount: units,
        receiveAmount: units,
        rate: 1,
        gasEstimate: 120_000n,
        exactOutput: false,
      };
    }

    if (mode === "recipient_receives") {
      // The recipient should receive `amount` USD of the receive token. A demo
      // "price move" bumps the delivered value so the overpayment guard is
      // demonstrable; the sender pays for whatever is actually delivered.
      const intendedUsd = usd ? Number(amount) : Number(amount) * priceOf(receiveToken);
      const receiveUsd = intendedUsd * (1 + (req.simulateMove ?? 0));
      const receiveAmount = round(receiveUsd / priceOf(receiveToken), receiveToken.decimals);
      const payUsd = receiveUsd / spread;
      const payAmount = round(payUsd / priceOf(payToken), payToken.decimals);
      return {
        ok: true,
        route: { kind: "swap", hops: [], path: [payToken.symbol, receiveToken.symbol] },
        payAmount,
        receiveAmount,
        rate: Number(receiveAmount) / Number(payAmount),
        gasEstimate: 220_000n,
        exactOutput: true,
      };
    }

    // i_spend: the sender spends `amount` USD of the pay token.
    const payUsd = usd ? Number(amount) : Number(amount) * priceOf(payToken);
    const payAmount = usd ? round(payUsd / priceOf(payToken), payToken.decimals) : amount;
    const receiveUsd = payUsd * spread;
    const receiveAmount = round(receiveUsd / priceOf(receiveToken), receiveToken.decimals);
    return {
      ok: true,
      route: { kind: "swap", hops: [], path: [payToken.symbol, receiveToken.symbol] },
      payAmount,
      receiveAmount,
      rate: Number(receiveAmount) / Number(payAmount),
      gasEstimate: 220_000n,
      exactOutput: false,
    };
  }
}
