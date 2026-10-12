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

/** CASH (World's prediction-market dollar, Token-2022) is not a Vanna registry token, so it has its own row. */
export const CASH_FAUCET_AMOUNT = 1000;

/**
 * Tops up CASH for Predict through POST /api/predict/faucet (fork cheatcodes, also adds a little
 * SOL for fees). Same result shape as {@link runFaucet}.
 */
export async function runCashFaucet(address: string): Promise<FaucetResult> {
  const symbol = "CASH";
  try {
    const res = await fetch("/api/predict/faucet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, amount: CASH_FAUCET_AMOUNT }),
    });
    const body = await res.json();
    if (!res.ok || !body?.ok) return { ok: false, symbol, error: body?.error ?? `Faucet failed (${res.status})` };
    return { ok: true, symbol, added: String(body.added ?? CASH_FAUCET_AMOUNT), balance: body.cash != null ? String(body.cash) : undefined };
  } catch (error) {
    return { ok: false, symbol, error: error instanceof Error ? error.message : "Faucet request failed" };
  }
}
