import { NextResponse } from "next/server";
import { pimlicoRpc } from "@/lib/server/paymaster/pimlico";
import { paymasterChainId } from "@/lib/server/paymaster";

export const dynamic = "force-dynamic";

/**
 * POST /api/aa/rpc — bundler RPC proxy.
 *
 * The Pimlico API key is server-side only, so the browser's bundler client talks
 * to this same-origin route instead of Pimlico directly. Only the ERC-4337
 * bundler methods the app uses are forwarded; anything else is rejected. The key
 * is never echoed back.
 */
const ALLOWED = new Set([
  "eth_sendUserOperation",
  "eth_estimateUserOperationGas",
  "eth_getUserOperationByHash",
  "eth_getUserOperationReceipt",
  "eth_supportedEntryPoints",
  "eth_chainId",
  "pimlico_getUserOperationGasPrice",
  "pimlico_getUserOperationStatus",
]);

export async function POST(req: Request) {
  const key = process.env.PIMLICO_API_KEY;
  const chainId = paymasterChainId();
  if (!key || !key.trim()) {
    return NextResponse.json(
      { code: -32601, message: "Gas abstraction isn't configured (PIMLICO_API_KEY is not set)." },
      { status: 503 },
    );
  }

  let body: { method?: string; params?: unknown[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ code: -32700, message: "Invalid JSON body." }, { status: 400 });
  }

  const method = body?.method;
  if (!method || !ALLOWED.has(method)) {
    return NextResponse.json(
      { code: -32601, message: `Method not allowed: ${method ?? "(none)"}` },
      { status: 400 },
    );
  }

  try {
    const result = await pimlicoRpc(key, chainId, method, Array.isArray(body.params) ? body.params : []);
    return NextResponse.json({ jsonrpc: "2.0", id: 1, result });
  } catch (err) {
    const message = (err as Error)?.message ?? "Bundler request failed";
    return NextResponse.json({ jsonrpc: "2.0", id: 1, error: { code: -32000, message } }, { status: 200 });
  }
}
