import { createWalletClient, custom, defineChain } from "viem";
const monad = defineChain({ id: 143, name: "Monad", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.monad.xyz"] } } });
const methods = [];
const provider = {
  request: async ({ method, params }) => {
    methods.push(method);
    if (method === "eth_chainId") return "0x8f";
    if (method === "eth_accounts" || method === "eth_requestAccounts") return ["0x0000000000000000000000000000000000000001"];
    if (method === "eth_sendTransaction") return "0x" + "ab".repeat(32);
    return "0x0";
  },
};
const walletClient = createWalletClient({ account: "0x0000000000000000000000000000000000000001", chain: monad, transport: custom(provider) });
const ABI = [{ name: "transfer", type: "function", stateMutability: "nonpayable", inputs: [{name:"to",type:"address"},{name:"amount",type:"uint256"}], outputs: [{type:"bool"}] }];
try {
  await walletClient.writeContract({ account: "0x0000000000000000000000000000000000000001", chain: monad, address: "0x0000000000000000000000000000000000000002", abi: ABI, functionName: "transfer", args: ["0x0000000000000000000000000000000000000001", 1n] });
} catch (e) { console.log("err:", String(e).slice(0,120)); }
try {
  await walletClient.sendTransaction({ account: "0x0000000000000000000000000000000000000001", chain: monad, to: "0x0000000000000000000000000000000000000001", value: 1n });
} catch (e) { console.log("err2:", String(e).slice(0,120)); }
console.log("METHODS:", JSON.stringify(methods));
