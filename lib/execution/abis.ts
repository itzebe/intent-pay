import { parseAbi } from "viem";

export const ERC20_ABI = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

/** Wrapped native (WMON) — used to wrap/unwrap native MON for pools. */
export const WNATIVE_ABI = parseAbi([
  "function deposit() payable",
  "function withdraw(uint256 amount)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

/**
 * Uniswap V3 SwapRouter02.
 *
 * NOTE: SwapRouter02 has **no** `deadline` parameter (unlike the original V3
 * SwapRouter). The deployed Monad SwapRouter02
 * (`0xfE31F71C1b106EAc32F1A19239c9a9A72ddfb900`) exposes only these
 * deadline-less selectors; adding a `deadline` argument changes the selector
 * and the call reverts. The real on-chain protection is therefore the
 * `amountOutMinimum` / `amountInMaximum` bound encoded here, backed by the
 * client-side quote-freshness window and the pre-signature rebuild — not an
 * on-chain deadline. Do not "add a deadline": it is not supported.
 */
export const SWAP_ROUTER_ABI = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function exactOutputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountIn)",
  "function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256 amountOut)",
  "function exactOutput((bytes path, address recipient, uint256 amountOut, uint256 amountInMaximum) params) payable returns (uint256 amountIn)",
]);
