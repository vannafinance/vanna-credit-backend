/**
 * Client-side faucet helper for the local Surfpool fork. Every registry token (SOL, USDC, USDT,
 * JitoSOL, JupSOL, JupUSD, and the xStocks NVDAx / GOOGLx / AAPLx / TSLAx) is topped up by its
 * `faucetAmount` (1000; 10 for an xStock) through POST /api/faucet, which uses
 * Surfpool cheatcodes (`surfnet_setAccount` for SOL lamports, `surfnet_setTokenAccount` for SPL
 * tokens) — no transaction, no wallet signature, no rate limit.
 */
export interface FaucetResult {
  ok: boolean;
  symbol: string;
  /** UI amount added. */
  added?: string;
  /** New wallet balance after the top-up (UI units). */
  balance?: string;
  error?: string;
}

export async function runFaucet(symbol: string, address: string): Promise<FaucetResult> {
  try {
    const res = await fetch("/api/faucet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, symbol }),
    });
    const body = await res.json();
    if (!res.ok || !body?.ok) return { ok: false, symbol, error: body?.error ?? `Faucet failed (${res.status})` };
    const r = body.results?.[0];
    return { ok: true, symbol, added: r?.added, balance: r?.balance };
  } catch (error) {
    return { ok: false, symbol, error: error instanceof Error ? error.message : "Faucet request failed" };
  }
}
