import type { TokenConfig } from "@/lib/config/tokens";
import type { MonadNetwork } from "@/lib/config/chains";

/**
 * MODE A — "recipient_receives": the recipient amount is the intent; the
 * system derives what the sender pays.
 * MODE B — "i_spend": the sender amount is the intent; the system derives
 * what the recipient receives.
 */
export type AmountMode = "recipient_receives" | "i_spend";

/** The user's payment intent — the only thing the UI has to express. */
export type PaymentIntent = {
  recipient: string;
  receiveToken: string;
  receiveAmount: string;
  amountMode: AmountMode;
};

/** How a route is satisfied on-chain. */
export type RouteKind =
  | "direct" // sender asset === receive asset
  | "swap" // single-hop or multi-hop Uniswap route
  | "wrap" // native MON <-> WMON
  | "unavailable";

export type RouteHop = {
  fromSymbol: string;
  toSymbol: string;
  fee: number;
  pool: `0x${string}`;
};

export type Route = {
  kind: RouteKind;
  hops: RouteHop[];
  /** Human path e.g. "USDT → USDC → SOL". */
  path: string[];
  /** Full token configs in path order — lets the client build the tx without
   * relying on a symbol lookup, which matters for discovered tokens. */
  tokens?: TokenConfig[];
  /** Why a route is unavailable, when it is. */
  reason?: string;
};

export type Quote = {
  /** Echo of the intent that produced this quote. */
  intent: PaymentIntent;
  network: MonadNetwork;

  payToken: TokenConfig;
  receiveToken: TokenConfig;

  /** Decimal-string amounts (already scaled to token decimals). */
  payAmount: string;
  receiveAmount: string;

  /** USD notional of each side. */
  payUsd: number;
  receiveUsd: number;

  /** Effective conversion rate (receive per 1 pay). */
  rate: number;

  route: Route;
  /** Total estimated sender cost in USD (payUsd + network cost). */
  totalSenderCostUsd: number;
  networkCostUsd: number;
  /** False when the network cost could not be priced from live MON data. */
  networkCostUsdAvailable?: boolean;
  /** Estimated gas limit + price used. */
  gasLimit?: bigint;
  gasPriceWei?: bigint;
  /** Unix ms when this quote was produced — used for staleness. */
  quotedAt: number;
  /** True when the quote required a live exact-output on-chain call. */
  exactOutput: boolean;

  /** Where each side's USD price came from (stable/market/dex/onchain/fallback). */
  payPriceSource?: string;
  receivePriceSource?: string;
  /** True when the receive token has no trustworthy price (never show $0.00). */
  receivePriceUnavailable?: boolean;

  /** How gas will be handled for this payment. */
  gas?: {
    /** "sponsored" | "erc20" | "native" — what the user should expect. */
    mode: "sponsored" | "erc20" | "native";
    /** True when Alchemy sponsorship is configured and usable. */
    sponsorshipConfigured: boolean;
    /** RPC currently in use. */
    rpc: "alchemy" | "public";
    /** The user's wallet supports the EIP-5792 batch + paymaster capabilities. */
    walletCapable?: boolean;
  };
};

export type QuoteRequest = {
  intent: PaymentIntent;
  /** Payment asset symbol (kept for convenience/back-compat). */
  payToken: string;
  /** Resolved payment asset — preferred when the token was discovered. */
  payTokenConfig?: TokenConfig;
  /** Resolved receive asset — preferred when the token was discovered. */
  receiveToken?: TokenConfig;
  network?: MonadNetwork;
};

export type QuoteResult =
  | { ok: true; quote: Quote }
  | { ok: false; code: QuoteErrorCode; message: string; alternatives?: string[] };

export type QuoteErrorCode =
  | "invalid_recipient"
  | "invalid_amount"
  | "same_token"
  | "route_unavailable"
  | "insufficient_balance"
  | "provider_error"
  | "unsupported_token";

export type Balance = {
  token: TokenConfig;
  /** Decimal string of the on-chain balance. */
  amount: string;
  usd: number;
};
