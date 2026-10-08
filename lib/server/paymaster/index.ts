import { createPimlicoProvider } from "./pimlico";
import type { PaymasterProvider } from "./types";

/**
 * Active paymaster provider registry.
 *
 * Exactly one ERC-20 gas provider is selected for Monad Mainnet today (Pimlico).
 * The indirection exists so the payment engine never couples to a brand: adding
 * or replacing a provider is a change here, not across the codebase.
 *
 * A provider is only returned when it is *configured*; an unconfigured
 * deployment yields `null` and the app falls back to MON gas, honestly.
 */
export function getPaymasterProvider(): PaymasterProvider | null {
  const key = process.env.PIMLICO_API_KEY;
  if (!key || !key.trim()) return null;
  return createPimlicoProvider(key, paymasterChainId());
}

/** The chain the paymaster is configured for (defaults to Monad mainnet 143). */
export function paymasterChainId(): number {
  const raw = process.env.PIMLICO_CHAIN_ID;
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : 143;
}

/** True when any ERC-20 gas provider is configured (key present). */
export function paymasterConfigured(): boolean {
  return Boolean(process.env.PIMLICO_API_KEY?.trim());
}
