/**
 * Verified Uniswap V3 deployments on Monad mainnet (chain id 143).
 * Source: developers.uniswap.org/deployments.json (generated 2026-09-22).
 * All addresses were confirmed to have bytecode via eth_getCode.
 */
export const UNISWAP = {
  v3Factory: "0x204FAca1764B154221e35c0d20aBb3c525710498",
  quoterV2: "0x661E93cca42AfacB172121EF892830cA3b70F08d",
  swapRouter02: "0xfE31F71C1b106EAc32F1A19239c9a9A72ddfb900",
  universalRouter: "0xBC2A036E5027b9AE57BbA847eF88E1b14823F7B1",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
} as const;

/** Wrapped MON — the ERC20 form of the native asset used by all pools. */
export const WMON_ADDRESS =
  "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A" as const;

/** Fee tiers probed when discovering pools. */
export const FEE_TIERS = [100, 500, 3000, 10000] as const;
