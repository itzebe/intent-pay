/**
 * UserOperation field allow-list.
 *
 * viem hands the paymaster capability object a parameter bag that mixes the
 * actual UserOperation with transport-only keys (`chainId`, `entryPointAddress`,
 * `context`). Pimlico validates strictly and rejects any unknown key with
 * "Unrecognized keys: … at params[0].userOp", which fails the whole ERC-20 gas
 * path. We therefore forward *only* real UserOperation fields.
 *
 * `authorization` is deliberately NOT an allowed op field: it is the transport
 * name viem uses for an EIP-7702 authorization, but EntryPoint v0.7+/Pimlico
 * expects it as `eip7702Auth`. Forwarding the viem name is rejected as an
 * unknown key, so the caller folds it into `eip7702Auth` instead.
 *
 * This is applied on both sides (client serialisation and the server proxy) so
 * the provider never receives anything the client invented.
 */

/** Fields valid in an ERC-4337 UserOperation (EntryPoint v0.6–v0.8). */
export const USER_OPERATION_KEYS = [
  "sender",
  "nonce",
  "initCode",
  "factory",
  "factoryData",
  "callData",
  "callGasLimit",
  "verificationGasLimit",
  "preVerificationGas",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
  "paymaster",
  "paymasterVerificationGasLimit",
  "paymasterPostOpGasLimit",
  "paymasterData",
  "paymasterSignature",
  "paymasterAndData",
  "signature",
  "eip7702Auth",
] as const;

const ALLOWED = new Set<string>(USER_OPERATION_KEYS);

/** Keep only real UserOperation fields; drop transport-only keys. */
export function filterUserOperation<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    if (ALLOWED.has(k)) out[k] = v;
  }
  return out;
}
