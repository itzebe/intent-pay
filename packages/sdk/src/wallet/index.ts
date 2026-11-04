/**
 * `@intentpay/sdk/wallet` — the browser wallet layer.
 *
 * Kept as a separate entry point so a server-only integration never pulls wallet
 * code (and so a bundler can tree-shake it out of a client that does not use it).
 */
export {
  Wallet,
  discoverWallets,
  watchWallets,
} from "./connect.js";
export type { PreparedCall, SentTransaction } from "./connect.js";
export {
  chainIdFromHex,
  isMonadChainId,
  firstAccount,
  isUserRejection,
  walletErrorMessage,
  monadAddChainParams,
  MONAD_CHAIN_ID,
} from "./provider.js";
export type { ConnectOptions, WalletConnectOptions, WalletConnection, RequestArguments } from "./provider.js";
export {
  parseAnnouncement,
  collectLegacyWallets,
  legacyProviderName,
  walletDisplayName,
  REQUEST_EVENT,
  ANNOUNCE_EVENT,
} from "./eip6963.js";
export type { Eip1193Provider, Eip6963ProviderInfo, Eip6963ProviderDetail, DiscoveredWallet } from "./eip6963.js";
export { WalletError, IntentPayError, isIntentPayError } from "../core/errors.js";
export type { SdkErrorCode } from "../core/errors.js";
