/**
 * A fake EIP-1193 provider and a fake `window`.
 *
 * The wallet layer is exercised against a real event/listener surface — the
 * provider emits genuine `accountsChanged` / `chainChanged` events and answers
 * `eth_requestAccounts`, `eth_chainId` and `eth_sendTransaction` — so the
 * discovery, Monad enforcement, rejection and disconnect rules run for real.
 * Only the wallet itself is replaced.
 */

export type FakeProvider = {
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>;
  on: (event: string, handler: (...args: any[]) => void) => void;
  removeListener: (event: string, handler: (...args: any[]) => void) => void;
  emit: (event: string, ...args: unknown[]) => void;
  calls: { method: string; params?: unknown }[];
  isMetaMask?: boolean;
  isRabby?: boolean;
  isCoinbaseWallet?: boolean;
  providers?: FakeProvider[];
  [key: string]: unknown;
};

export type FakeProviderOptions = {
  accounts?: string[];
  chainId?: string;
  /** Reject `eth_requestAccounts` with this error (e.g. a 4001 rejection). */
  rejectConnect?: { code?: number; message?: string };
  /** Reject `eth_sendTransaction` with this error. */
  rejectSend?: { code?: number; message?: string };
  /** Return a fixed hash from `eth_sendTransaction`. */
  txHash?: string;
  /** Make `wallet_switchEthereumChain` reject (e.g. `4902` unknown chain). */
  rejectSwitch?: { code?: number; message?: string };
  /** The chain id `eth_chainId` reports after a successful switch. */
  chainAfterSwitch?: string;
  isMetaMask?: boolean;
  isRabby?: boolean;
  isCoinbaseWallet?: boolean;
};

let hashCounter = 0;

export function makeProvider(options: FakeProviderOptions = {}): FakeProvider {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  let accounts = options.accounts ?? ["0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4"];
  let chainId = options.chainId ?? "0x8f";
  const calls: { method: string; params?: unknown }[] = [];

  const provider: FakeProvider = {
    calls,
    ...(options.isMetaMask ? { isMetaMask: true } : {}),
    ...(options.isRabby ? { isRabby: true } : {}),
    ...(options.isCoinbaseWallet ? { isCoinbaseWallet: true } : {}),
    async request(args) {
      calls.push({ method: args.method, ...(args.params === undefined ? {} : { params: args.params }) });
      switch (args.method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          if (args.method === "eth_requestAccounts" && options.rejectConnect) {
            const e = new Error(options.rejectConnect.message ?? "User rejected the request.");
            (e as { code?: number }).code = options.rejectConnect.code ?? 4001;
            throw e;
          }
          return [...accounts];
        case "eth_chainId":
          return chainId;
        case "wallet_switchEthereumChain": {
          if (options.rejectSwitch) {
            const e = new Error(options.rejectSwitch.message ?? "Unrecognized chain ID.");
            (e as { code?: number }).code = options.rejectSwitch.code ?? 4902;
            throw e;
          }
          chainId = options.chainAfterSwitch ?? "0x8f";
          provider.emit("chainChanged", chainId);
          return null;
        }
        case "wallet_addEthereumChain":
          chainId = "0x8f";
          provider.emit("chainChanged", chainId);
          return null;
        case "eth_sendTransaction": {
          if (options.rejectSend) {
            const e = new Error(options.rejectSend.message ?? "User rejected the transaction.");
            (e as { code?: number }).code = options.rejectSend.code ?? 4001;
            throw e;
          }
          const hash = options.txHash ?? "0x" + (++hashCounter).toString(16).padStart(64, "0");
          return hash;
        }
        default:
          return null;
      }
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
    },
    removeListener(event, handler) {
      listeners.get(event)?.delete(handler);
    },
    emit(event, ...args) {
      for (const h of [...(listeners.get(event) ?? [])]) h(...args);
    },
  };
  return provider;
}

/** Install a fake `window` with the given providers and return a cleanup. */
export function installWindow(input: {
  providers?: { info: { uuid: string; name: string; icon: string; rdns: string }; provider: FakeProvider }[];
  legacy?: FakeProvider;
}): () => void {
  // Fill in the legacy provider-detection flags so a label can be resolved, as a
  // real extension does at injection time.
  for (const { provider } of input.providers ?? []) {
    const rdns = (input.providers ?? []).find((p) => p.provider === provider)!.info.rdns;
    if (rdns === "io.metamask") provider.isMetaMask = true;
    if (rdns === "io.rabby") provider.isRabby = true;
    if (rdns === "com.coinbase.wallet") provider.isCoinbaseWallet = true;
  }
  const listeners = new Map<string, Set<(e: Event) => void>>();
  const win = {
    document: {},
    addEventListener: (event: string, handler: (e: Event) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
    },
    removeEventListener: (event: string, handler: (e: Event) => void) => {
      listeners.get(event)?.delete(handler);
    },
    dispatchEvent: (event: Event) => {
      if (event.type === "eip6963:requestProvider") {
        for (const entry of input.providers ?? []) {
          const announce = {
            type: "eip6963:announceProvider",
            detail: entry,
          } as unknown as Event;
          for (const h of listeners.get("eip6963:announceProvider") ?? []) h(announce);
        }
      }
      return true;
    },
    ...(input.legacy ? { ethereum: input.legacy } : {}),
  };
  const original = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = win;
  return () => {
    if (original === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = original;
  };
}

/** Install a fake `window` whose `ethereum` is the given provider. */
export function installLegacyWindow(provider: FakeProvider): () => void {
  return installWindow({ legacy: provider });
}
