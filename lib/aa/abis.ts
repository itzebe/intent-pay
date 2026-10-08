/**
 * Minimal ABIs for the account-abstraction execution path.
 *
 * Only the fragments the app actually encodes are kept, so nothing here can
 * drift from a full vendor ABI.
 */

/**
 * eth-infinitism `Simple7702Account.sol` — the delegation target for an EIP-7702
 * upgrade. Verified to have bytecode on Monad mainnet at the address below.
 */
export const SIMPLE_7702_IMPLEMENTATION =
  "0xe6Cae83BdE06E4c305530e199D7217f42808555B" as const;

export const SIMPLE_7702_ABI = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "executeBatch",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

/** ERC-4337 EntryPoint v0.8 (used by the 7702 account; Pimlico serves it). */
export const ENTRY_POINT_V08 =
  "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108" as const;

/** ERC-4337 EntryPoint v0.7 (fallback / diagnostics). */
export const ENTRY_POINT_V07 =
  "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as const;

export const ENTRY_POINT_ABI = [
  {
    type: "function",
    name: "getNonce",
    stateMutability: "view",
    inputs: [
      { name: "sender", type: "address" },
      { name: "key", type: "uint192" },
    ],
    outputs: [{ name: "nonce", type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
] as const;
