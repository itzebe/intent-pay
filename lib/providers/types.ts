import type { TokenConfig } from "@/lib/config/tokens";
import type {
  AmountMode,
  QuoteErrorCode,
  Route,
} from "@/lib/domain/intent";

export type RouteQuoteRequest = {
  payToken: TokenConfig;
  receiveToken: TokenConfig;
  mode: AmountMode;
  /** Decimal string. A USD value when `usd` is true, else token units. */
  amount: string;
  /** True when `amount` is a dollar value (the composer's "$5.00 SOL"). */
  usd?: boolean;
  /** Demo-only: perturb the receive side to simulate a market move / misconfigured
   * transaction. Honoured only by the demo provider; ignored on live routes. */
  simulateMove?: number;
  network: "mainnet" | "testnet";
};

export type RouteQuoteSuccess = {
  ok: true;
  route: Route;
  payAmount: string;
  receiveAmount: string;
  /** receive per 1 pay. */
  rate: number;
  gasEstimate: bigint;
  exactOutput: boolean;
};

export type RouteQuoteFailure = {
  ok: false;
  code: QuoteErrorCode;
  message: string;
  alternatives?: string[];
};

export type RouteQuoteResult = RouteQuoteSuccess | RouteQuoteFailure;

export type UsdPrice = {
  usd: number;
  source: "stable" | "onchain" | "fallback";
};

/**
 * The routing layer is intentionally swappable. Any provider that can turn a
 * (payToken, receiveToken, amount) triple into an executable route satisfies
 * the contract; the UI never imports a concrete provider.
 */
export interface RoutingProvider {
  readonly name: string;
  readonly mode: "live" | "demo";
  /** Can this provider route the given token? */
  supports(token: TokenConfig): boolean;
  /** Discover + price a route. */
  quote(req: RouteQuoteRequest): Promise<RouteQuoteResult>;
  /** USD price for a token, used for the payment notional. */
  priceUsd(token: TokenConfig, network: "mainnet" | "testnet"): Promise<UsdPrice>;
  /** Tokens that currently have at least one liquid route. */
  availableSymbols(network: "mainnet" | "testnet"): Promise<string[]>;
}
