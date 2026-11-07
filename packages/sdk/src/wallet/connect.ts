import { WalletError } from "../core/errors.js";
import {
  collectLegacyWallets,
  discoverWallets,
  watchWallets,
  type DiscoveredWallet,
  type Eip1193Provider,
} from "./eip6963.js";
import {
  chainIdFromHex,
  firstAccount,
  isMonadChainId,
  isUserRejection,
  isWalletTransportError,
  monadAddChainParams,
  walletErrorMessage,
  MONAD_CHAIN_ID,
  type ConnectOptions,
  type WalletConnection,
  type WalletConnectOptions,
} from "./provider.js";

/**
 * A prepared call, as returned by `prepareTransaction`.
 *
 * The optional `gas` / `maxFeePerGas` / `maxPriorityFeePerGas` / `nonce` fields
 * let the caller (or the Intent Pay API) fill the transaction envelope with its
 * own RPC reads before the wallet is asked to sign. A wallet whose own node is
 * unreachable — Trust Wallet's in-app browser proxies non-native methods to
 * `monad.twnodes.com` — then has nothing left to estimate before it can sign.
 * Omit a field you could not read; the wallet will fall back to its own source.
 */
export type PreparedCall = {
  to: string;
  data: string;
  value: string;
  gas?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  nonce?: string;
};

/** The hash(es) a wallet produced. */
export type SentTransaction = { txHashes: string[] };

/**
 * A connected wallet.
 *
 * Wraps an EIP-1193 provider with the three things a payment flow needs:
 * Monad enforcement, account/chain change tracking, and transaction sending
 * that surfaces a user rejection as its own outcome.
 */
export class Wallet {
  private readonly provider: Eip1193Provider;
  /**
   * State-change subscribers, notified by `emit()`.
   *
   * Kept separate from the teardown callbacks below: `emit()` must never invoke
   * a teardown, because a teardown removes a provider listener and mutating the
   * provider's listener set *while it is being iterated* silently skips the next
   * handler (the "account change did not fire" class of bug).
   */
  private readonly subscribers = new Set<() => void>();
  /** Cleanup functions run once, on `disconnect()`. */
  private readonly teardowns = new Set<() => void>();
  private currentAddress: `0x${string}`;
  private currentChainId: number;
  readonly kind: "injected" | "walletconnect";
  readonly walletId?: string;
  /** The WalletConnect provider's `disconnect`, when this is a WC session. */
  private readonly wcDisconnect?: () => Promise<void>;

  private constructor(input: {
    provider: Eip1193Provider;
    address: `0x${string}`;
    chainId: number;
    kind: "injected" | "walletconnect";
    walletId?: string;
    wcDisconnect?: () => Promise<void>;
  }) {
    this.provider = input.provider;
    this.currentAddress = input.address;
    this.currentChainId = input.chainId;
    this.kind = input.kind;
    if (input.walletId !== undefined) this.walletId = input.walletId;
    if (input.wcDisconnect !== undefined) this.wcDisconnect = input.wcDisconnect;
    this.attachEvents();
  }

  // ── Construction ────────────────────────────────────────────────────────────

  /**
   * Connect to an injected wallet.
   *
   * Discovery follows EIP-6963 (with a legacy fallback). If `walletId` is given,
   * that wallet is chosen; otherwise a single available wallet is used, and an
   * ambiguous set throws `wallet_not_found` so the caller can render a chooser.
   */
  static async connect(options: ConnectOptions = {}): Promise<Wallet> {
    const wallets = await discoverWallets();
    if (wallets.length === 0) {
      if (options.walletConnect?.projectId) return Wallet.connectWalletConnect(options.walletConnect);
      throw new WalletError("wallet_not_found", "No browser wallet was found. Install MetaMask, Rabby, Coinbase Wallet or another EIP-1193 wallet.");
    }

    let chosen: DiscoveredWallet | undefined;
    if (options.walletId) {
      chosen = wallets.find((w) => w.id === options.walletId || w.rdns === options.walletId);
      if (!chosen) throw new WalletError("wallet_not_found", `The wallet "${options.walletId}" is not available.`);
    } else if (wallets.length === 1) {
      chosen = wallets[0]!;
    } else {
      throw new WalletError(
        "wallet_not_found",
        `Multiple wallets are available (${wallets.map((w) => w.name).join(", ")}). Pass \`walletId\` to choose one.`,
      );
    }

    const accounts = await chosen.provider.request({ method: "eth_requestAccounts" }).catch((err: unknown) => {
      if (isUserRejection(err)) throw new WalletError("wallet_rejected", "You rejected the connection request.");
      throw new WalletError("wallet_not_found", walletErrorMessage(err));
    });
    const address = firstAccount(accounts);
    if (!address) throw new WalletError("wallet_no_account", "The wallet returned no account. Unlock it and approve the connection.");

    // Best-effort: a provider whose own node is unreachable cannot answer
    // `eth_chainId`. The connection still succeeds; the chain is unknown (0)
    // rather than treated as a hard failure — `ensureMonadChain`/`sendCalls`
    // carry the chain identity explicitly.
    const chainId = (await Wallet.readChainIdSafe(chosen.provider)) ?? 0;
    return new Wallet({
      provider: chosen.provider,
      address,
      chainId,
      kind: "injected",
      ...(chosen.rdns ? { walletId: chosen.rdns } : { walletId: chosen.id }),
    });
  }

  /**
   * Connect over WalletConnect (mobile / QR).
   *
   * `@walletconnect/ethereum-provider` is loaded lazily so it is never in a
   * bundle that does not use it. The resulting provider is a genuine EIP-1193
   * provider, so everything downstream is identical to an injected wallet.
   */
  static async connectWalletConnect(options: WalletConnectOptions): Promise<Wallet> {
    if (!options.projectId) {
      throw new WalletError("wallet_not_found", "WalletConnect requires a projectId (register one at https://dashboard.reown.com).");
    }
    let provider: Eip1193Provider;
    try {
      const mod = await import("@walletconnect/ethereum-provider");
      const EthereumProvider = (mod as { EthereumProvider?: unknown }).EthereumProvider ?? (mod as { default?: unknown }).default;
      if (!EthereumProvider) throw new Error("no provider export");
      const instance = await (EthereumProvider as {
        init: (opts: Record<string, unknown>) => Promise<unknown>;
      }).init({
        projectId: options.projectId,
        optionalChains: options.chains ?? [MONAD_CHAIN_ID],
        showQrModal: true,
        // Least privilege: only the methods this SDK actually calls. It never
        // asks the wallet to sign a message or arbitrary typed data.
        methods: ["eth_sendTransaction", "wallet_switchEthereumChain", "wallet_addEthereumChain"],
        events: ["chainChanged", "accountsChanged", "disconnect"],
        metadata: options.metadata ?? { name: "Intent Pay", description: "Intent-based payments on Monad.", url: "https://intent-pay-roan.vercel.app", icons: [] },
      });
      provider = instance as Eip1193Provider;
    } catch {
      throw new WalletError("wallet_not_found", "WalletConnect could not be started. Check your projectId and network access.");
    }

    // `enable()` starts the pairing flow (QR / deep link) and returns the
    // authorised accounts. A bare `eth_requestAccounts` is answered locally from
    // the current session — with none, it returns empty and never prompts, which
    // is why a mobile connection appeared to do nothing.
    const enable = (provider as { enable?: () => Promise<unknown> }).enable;
    const accounts = typeof enable === "function"
      ? await enable.call(provider)
      : await provider.request({ method: "eth_requestAccounts" });
    const address = firstAccount(accounts);
    if (!address) throw new WalletError("wallet_no_account", "The WalletConnect session returned no account.");
    const chainId = (await Wallet.readChainIdSafe(provider)) ?? 0;

    const disconnect = provider.disconnect as (() => Promise<void>) | undefined;
    return new Wallet({
      provider,
      address,
      chainId,
      kind: "walletconnect",
      ...(disconnect ? { wcDisconnect: () => disconnect.call(provider) } : {}),
    });
  }

  /**
   * Re-attach to a previously chosen injected wallet without prompting, if it
   * still reports an authorized account. Returns `null` rather than throwing, so
   * a page load can quietly restore a session or fall back to disconnected.
   */
  static async restore(walletId: string | undefined): Promise<Wallet | null> {
    if (!walletId) return null;
    const wallets = collectLegacyWallets(typeof window !== "undefined" ? window : undefined);
    const announced = typeof window !== "undefined" ? await discoverWallets() : [];
    const all = [...announced, ...wallets];
    const chosen = all.find((w) => w.id === walletId || w.rdns === walletId);
    if (!chosen) return null;
    try {
      const accounts = await chosen.provider.request({ method: "eth_accounts" });
      const address = firstAccount(accounts);
      if (!address) return null;
      const chainId = (await Wallet.readChainIdSafe(chosen.provider)) ?? 0;
      return new Wallet({
        provider: chosen.provider,
        address,
        chainId,
        kind: "injected",
        ...(chosen.rdns ? { walletId: chosen.rdns } : { walletId: chosen.id }),
      });
    } catch {
      return null;
    }
  }

  private static async readChainId(provider: Eip1193Provider): Promise<number> {
    const hex = await provider.request({ method: "eth_chainId" });
    return chainIdFromHex(hex) ?? 0;
  }

  /**
   * Read the chain id, or `undefined` when the read fails.
   *
   * A page-world injected provider (Trust Wallet) answers `eth_chainId` by
   * proxying to its own node, so the read can fail for reasons unrelated to
   * whether the wallet can pay. Callers that gate a payment on the chain must
   * treat a failed read as *unknown* — never as "wrong chain" — and let the
   * submission carry the chain identity explicitly.
   */
  private static async readChainIdSafe(provider: Eip1193Provider): Promise<number | undefined> {
    try {
      return await Wallet.readChainId(provider);
    } catch {
      return undefined;
    }
  }

  // ── Accessors ───────────────────────────────────────────────────────────────

  get address(): `0x${string}` {
    return this.currentAddress;
  }

  get chainId(): number {
    return this.currentChainId;
  }

  /** True when the wallet is on Monad Mainnet. */
  get onMonad(): boolean {
    return isMonadChainId(this.currentChainId);
  }

  /** The current connection as a plain object. */
  toConnection(): WalletConnection {
    return {
      address: this.currentAddress,
      chainId: this.currentChainId,
      kind: this.kind,
      ...(this.walletId !== undefined ? { walletId: this.walletId } : {}),
      provider: this.provider,
    };
  }

  // ── Network ─────────────────────────────────────────────────────────────────

  /**
   * Ensure the wallet is on Monad Mainnet.
   *
   * Requests a switch, and if the wallet does not know the chain (EIP-1193
   * `4902`) adds it first. Throws `wallet_wrong_chain` when the switch is
   * refused — the SDK never proceeds on the wrong chain.
   */
  async ensureMonadChain(): Promise<void> {
    if (this.onMonad) return;
    // Best-effort chain read: a provider that cannot answer `eth_chainId` (its
    // own node is unreachable) leaves the chain *unknown*, not "wrong". Only a
    // wallet genuinely reporting another chain is asked to switch — a failed
    // read must never block a payment that carries its chainId explicitly.
    const current = await Wallet.readChainIdSafe(this.provider);
    if (current !== undefined && isMonadChainId(current)) {
      this.currentChainId = current;
      return;
    }
    try {
      await this.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x" + MONAD_CHAIN_ID.toString(16) }] });
    } catch (err) {
      const code = (err as { code?: number })?.code;
      // Prefer the numeric EIP-1193 code: a wallet's message text is not a
      // contract, but `4902` (unknown chain) is.
      if (code === 4902) {
        await this.provider.request({ method: "wallet_addEthereumChain", params: [monadAddChainParams()] });
      } else if (isUserRejection(err)) {
        throw new WalletError("wallet_wrong_chain", "You declined to switch to Monad Mainnet.");
      } else if (current !== undefined) {
        // We know the wallet is on a different chain and the switch failed.
        throw new WalletError("wallet_wrong_chain", walletErrorMessage(err));
      }
      // Otherwise the chain was unreadable and the switch could not be
      // performed: proceed — the submission carries chainId 143 explicitly.
    }
    const chainId = await Wallet.readChainIdSafe(this.provider);
    if (chainId !== undefined) this.currentChainId = chainId;
    this.emit();
  }

  // ── Signing / sending ───────────────────────────────────────────────────────

  /**
   * Send the calls the API prepared, in order, from the connected account.
   *
   * Each call is a normal `eth_sendTransaction`: the wallet shows its own
   * approval prompt and signs locally. The SDK never sees a key. A rejection
   * throws `wallet_rejected`; the returned hashes are in the order the calls
   * were sent, so the caller can pass them to `submitTransaction`.
   *
   * The chain is re-checked before the first call, so a payment can never be
   * broadcast from a wallet that drifted to another network.
   */
  async sendCalls(calls: PreparedCall[]): Promise<SentTransaction> {
    if (calls.length === 0) throw new WalletError("wallet_no_account", "There is nothing to send.");
    await this.ensureMonadChain();
    const from = this.currentAddress;
    const txHashes: string[] = [];
    for (const call of calls) {
      try {
        const hash = await this.provider.request({
          method: "eth_sendTransaction",
          // The chain identity travels with the request, so the wallet never has
          // to answer `eth_chainId` itself — a page-world provider (Trust
          // Wallet) may not be able to reach its own node to do so. The
          // envelope fields the caller supplied (gas/fees/nonce) are forwarded
          // verbatim so the wallet has nothing left to estimate.
          params: [{
            from,
            to: call.to,
            data: call.data && call.data !== "0x" ? call.data : undefined,
            value: normalizeValue(call.value),
            chainId: "0x" + MONAD_CHAIN_ID.toString(16),
            ...envelopeFields(call),
          }],
        });
        if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
          throw new WalletError("wallet_no_account", "The wallet did not return a transaction hash.");
        }
        txHashes.push(hash);
      } catch (err) {
        if (err instanceof WalletError) throw err;
        if (isUserRejection(err)) throw new WalletError("wallet_rejected", "You rejected the transaction in your wallet.");
        // A transport failure after the user authorised does not prove nothing was
        // broadcast — the wallet may have signed and sent before its own node
        // became unreachable (Trust Wallet's native layer is the reported case).
        // Surface it as an unknown outcome so the caller checks status instead of
        // resending.
        if (isWalletTransportError(err)) {
          throw new WalletError(
            "wallet_unknown_outcome",
            "Your wallet authorised the payment but could not reach its own network endpoint, so we can't confirm whether the transaction was broadcast. It may already be on-chain. Do not resend — check the transaction status first.",
          );
        }
        throw new WalletError("wallet_no_account", walletErrorMessage(err));
      }
    }
    return { txHashes };
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /** Subscribe to account changes. Returns an unsubscribe function. */
  onAccountsChanged(handler: (address: `0x${string}` | null) => void): () => void {
    const wrapped = (accounts: unknown) => {
      const next = firstAccount(accounts);
      this.currentAddress = next ?? this.currentAddress;
      handler(next ?? null);
      this.emit();
    };
    this.provider.on?.("accountsChanged", wrapped);
    const off = () => this.provider.removeListener?.("accountsChanged", wrapped);
    this.teardowns.add(off);
    return off;
  }

  /** Subscribe to chain changes. Returns an unsubscribe function. */
  onChainChanged(handler: (chainId: number) => void): () => void {
    const wrapped = (hex: unknown) => {
      const next = chainIdFromHex(hex) ?? 0;
      this.currentChainId = next;
      handler(next);
      this.emit();
    };
    this.provider.on?.("chainChanged", wrapped);
    const off = () => this.provider.removeListener?.("chainChanged", wrapped);
    this.teardowns.add(off);
    return off;
  }

  /** Subscribe to any state change (account or chain). Returns an unsubscribe. */
  subscribe(handler: () => void): () => void {
    this.subscribers.add(handler);
    return () => this.subscribers.delete(handler);
  }

  private emit(): void {
    // Iterate a snapshot so a subscriber that unsubscribes during notification
    // cannot disturb the loop.
    for (const handler of [...this.subscribers]) handler();
  }

  private attachEvents(): void {
    this.provider.on?.("accountsChanged", (accounts: unknown) => {
      const next = firstAccount(accounts);
      if (next) this.currentAddress = next;
      this.emit();
    });
    this.provider.on?.("chainChanged", (hex: unknown) => {
      this.currentChainId = chainIdFromHex(hex) ?? 0;
      this.emit();
    });
  }

  /**
   * Disconnect.
   *
   * There is no EIP-1193 "disconnect" method — an injected wallet's authorization
   * is owned by the wallet, not the dapp — so this tears down local listeners and
   * any WalletConnect session. It never claims to have revoked an injected
   * wallet's permission, because it cannot.
   */
  async disconnect(): Promise<void> {
    for (const off of this.teardowns) off();
    this.teardowns.clear();
    this.subscribers.clear();
    if (this.wcDisconnect) {
      try {
        await this.wcDisconnect();
      } catch {
        /* a failed session teardown is not fatal */
      }
    }
  }
}

/** Normalize a decimal-wei string into the hex `value` an EIP-1193 call expects. */
function normalizeValue(value: string | undefined): string | undefined {
  if (!value || value === "0") return undefined;
  try {
    return "0x" + BigInt(value).toString(16);
  } catch {
    return undefined;
  }
}

/**
 * The envelope fields a caller may have prepared, as EIP-1193 hex quantities.
 * A value that is absent, malformed or non-positive is dropped rather than
 * forwarded — an invalid field would be worse than none (the wallet must fall
 * back to its own source, not be handed a bad number).
 */
function envelopeFields(call: PreparedCall): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["gas", "maxFeePerGas", "maxPriorityFeePerGas", "nonce"] as const) {
    const raw = call[key];
    if (raw === undefined || raw === null || raw === "") continue;
    try {
      const n = BigInt(raw);
      if (n < 0n) continue;
      out[key] = "0x" + n.toString(16);
    } catch {
      /* drop a malformed value */
    }
  }
  return out;
}

/** Re-exported for callers that want to render a chooser. */
export { discoverWallets, watchWallets };
export type { DiscoveredWallet };
