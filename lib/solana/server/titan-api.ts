// Server-side only: Titan's swap API (https://portal.api.titan.exchange), which needs an API key from
// the Titan Developers Portal (TITAN_API_KEY). Titan returns ready-to-sign instructions with its quote.
const TITAN_API_URL = process.env.TITAN_API_URL ?? "https://portal.api.titan.exchange/api/v1";

export const titanConfigured = (): boolean => Boolean(process.env.TITAN_API_KEY);

export interface TitanRouteInstruction {
  /** Program id. */
  p: string;
  /** Accounts: pubkey, signer, writable. */
  a: { p: string; s: boolean; w: boolean }[];
  /** Data, base64. */
  d: string;
}

export interface TitanRouteResponse {
  provider: string;
  inAmount: string;
  outAmount: string;
  slippageBps: number;
  instructions: TitanRouteInstruction[];
  addressLookupTables: string[];
  /** Venues the route goes through, when Titan names them. */
  labels: string[];
}

/**
 * One Titan quote. `margin` routes are built for a Vanna margin account (Titan's own router only,
 * swap_route_v3, the input account kept open, wSOL output kept as wSOL, no output account created —
 * what the Vanna validator allows); `wallet` routes are a normal wallet swap.
 */
export async function titanQuote(params: {
  inputMint: string;
  outputMint: string;
  amount: string;
  userPublicKey: string;
  slippageBps: number;
  mode: "wallet" | "margin";
  dexes?: string;
}): Promise<TitanRouteResponse> {
  const key = process.env.TITAN_API_KEY;
  if (!key) throw new Error("TITAN_API_KEY is not configured");
  const qs = new URLSearchParams({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount,
    userPublicKey: params.userPublicKey,
    slippageBps: String(params.slippageBps),
    titanSwapVersion: "3",
    numQuotes: "1",
  });
  if (params.mode === "margin") {
    qs.set("providers", process.env.TITAN_PROVIDERS ?? "Titan");
    qs.set("closeInputTokenAccount", "false");
    qs.set("createOutputTokenAccount", "false");
    qs.set("outputWsol", "true");
  } else {
    qs.set("createOutputTokenAccount", "true");
  }
  if (params.dexes) qs.set("dexes", params.dexes);
  const response = await fetch(`${TITAN_API_URL}/quote/swap?${qs}`, { headers: { "x-api-key": key, Accept: "application/json" }, cache: "no-store" });
  const text = await response.text();
  if (!response.ok) throw new Error(`Titan quote failed (${response.status}): ${text.slice(0, 200)}`);
  const body = JSON.parse(text);
  const quotes = (body.quotes ?? {}) as Record<string, Record<string, unknown>>;
  const winner = body.metadata?.expectedWinner ?? body.metadata?.ExpectedWinner;
  const provider = (winner && quotes[winner] ? winner : Object.keys(quotes)[0]) as string | undefined;
  const route = provider ? quotes[provider] : undefined;
  if (!route || !provider) throw new Error("Titan returned no route for this pair");
  const steps = (route.steps ?? route.routePlan ?? []) as Record<string, unknown>[];
  return {
    provider,
    inAmount: String(route.inAmount ?? params.amount),
    outAmount: String(route.outAmount),
    slippageBps: Number(route.slippageBps ?? params.slippageBps),
    instructions: (route.instructions ?? []) as TitanRouteInstruction[],
    addressLookupTables: ((route.addressLookupTables ?? []) as string[]).map(String),
    labels: steps.map((s) => String(s.label ?? s.dex ?? s.amm ?? "")).filter(Boolean),
  };
}
