import { fetchWithTimeout } from "../../async";
// Server-side only (API routes / scripts): calls fork cheatcodes on FORK_RPC_URL.
import { SOLANA_RPC_URL } from "../config";

/** Server-only Surfpool cheatcode caller (surfnet_setAccount / surfnet_setTokenAccount / ...). */
export async function callCheatcode<T = unknown>(method: string, params: unknown[]): Promise<T> {
  const response = await fetchWithTimeout(SOLANA_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`${method} failed (HTTP ${response.status})`);
  const body = (await response.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method} failed: ${body.error.message}`);
  return body.result as T;
}
