import { NATIVE_ADDRESS } from "./chains";

/**
 * A supported payment asset. All token metadata is data — the UI never
 * branches on a specific symbol, so adding a token is a config-only change.
 */
export type TokenConfig = {
  symbol: string;
  name: string;
  /** Monad mainnet contract address (native sentinel for MON). */
  address: `0x${string}`;
  decimals: number;
  /** Native asset (MON) — no contract, paid as msg.value. */
  native?: boolean;
  /** Known fallback USD price, used only in demo / when no live price exists. */
  fallbackUsd: number;
  /** Glyph tint for the token badge. */
  tint: string;
};

/**
 * Supported Monad assets, verified on-chain (chain id 143) on 2026-10-06.
 * Addresses sourced from the official Monad token list
 * (github.com/monad-crypto/token-list) and verified via eth_getCode + symbol().
 */
export const TOKENS: TokenConfig[] = [
  {
    symbol: "MON",
    name: "Monad",
    address: NATIVE_ADDRESS,
    decimals: 18,
    native: true,
    fallbackUsd: 0.029,
    tint: "#836EF9",
  },
  {
    symbol: "USDC",
    name: "USD Coin",
    address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
    decimals: 6,
    fallbackUsd: 1,
    tint: "#2775CA",
  },
  {
    symbol: "USDT",
    name: "Tether USD (USDT0)",
    address: "0xe7cd86e13AC4309349F30B3435a9d337750fC82D",
    decimals: 6,
    fallbackUsd: 1,
    tint: "#26A17B",
  },
  {
    symbol: "SOL",
    name: "Wrapped SOL",
    address: "0xea17E5a9efEBf1477dB45082d67010E2245217f1",
    decimals: 9,
    fallbackUsd: 180,
    tint: "#14F195",
  },
  {
    symbol: "WETH",
    name: "Wrapped Ether",
    address: "0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242",
    decimals: 18,
    fallbackUsd: 3200,
    tint: "#8A92B2",
  },
  {
    symbol: "AUSD",
    name: "Agora USD",
    address: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a",
    decimals: 6,
    fallbackUsd: 1,
    tint: "#4F8DF7",
  },
];

/** Tokens used to bootstrap the demo wallet (a realistic Monad mix). */
export const DEMO_TOKEN_SYMBOLS = ["USDT", "USDC", "MON"] as const;

export function getToken(symbol: string): TokenConfig | undefined {
  return TOKENS.find((t) => t.symbol.toLowerCase() === symbol.toLowerCase());
}

export function getTokenByAddress(address: string): TokenConfig | undefined {
  const a = address.toLowerCase();
  return TOKENS.find((t) => t.address.toLowerCase() === a);
}

export function tokenBySymbol(symbol: string): TokenConfig {
  const t = getToken(symbol);
  if (!t) throw new Error(`Unsupported token: ${symbol}`);
  return t;
}

/** Tokens the recipient can receive = everything we can transfer/route. */
export function receivableTokens(): TokenConfig[] {
  return TOKENS;
}

/** Tokens the sender can pay with = everything we hold or can wrap. */
export function payableTokens(): TokenConfig[] {
  return TOKENS;
}
