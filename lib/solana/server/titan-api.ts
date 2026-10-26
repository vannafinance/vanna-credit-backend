import { fetchWithTimeout } from "../../async";
// Server-side only: Titan's swap API. Two ways to reach it:
//  - Titan's own Developers Portal (https://portal.api.titan.exchange) with TITAN_API_KEY;
//  - a QuickNode Solana endpoint with the Titan Swap add-on: TITAN_API_URL = that endpoint's URL (its
//    token is in the URL, so no key is needed; with or without the trailing /api/v1).
// Titan returns ready-to-sign instructions with its quote.
const TITAN_API_URL = (() => {
  const base = (process.env.TITAN_API_URL ?? "https://portal.api.titan.exchange/api/v1").replace(/\/+$/, "");
  return base.endsWith("/api/v1") ? base : `${base}/api/v1`;
})();

// This app targets a Surfpool mainnet fork: prop AMMs (AlphaQ, HumidiFi, SolFi, …) read state their
// own keepers update every slot, which the fork's frozen clone doesn't have ("Invalid account
// owner"), so Titan routes default to the same fork-safe pool AMMs as the Jupiter quote route
// (app/api/jupiter/quote). Operators can override with TITAN_FORK_DEXES.
const FORK_DEXES = process.env.TITAN_FORK_DEXES ?? "Raydium,Raydium CLMM,Raydium CP,Orca V2,Meteora DLMM,Whirlpool";

export const titanConfigured = (): boolean => Boolean(process.env.TITAN_API_KEY || process.env.TITAN_API_URL);

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
  /** Each hop / split leg: venue, its input and output mint, and its share of the input (%). */
  steps: TitanRouteStep[];
}

export interface TitanRouteStep {
  label: string;
  inputMint: string;
  outputMint: string;
  percent: number;
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
  /** Aborts the upstream call when the client cancels the quote. */
  signal?: AbortSignal;
}): Promise<TitanRouteResponse> {
  if (!titanConfigured()) throw new Error("TITAN_API_KEY / TITAN_API_URL is not configured");
  const key = process.env.TITAN_API_KEY;
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
  qs.set("dexes", params.dexes ?? FORK_DEXES);
  const response = await fetchWithTimeout(`${TITAN_API_URL}/quote/swap?${qs}`, { headers: { Accept: "application/json", ...(key ? { "x-api-key": key, Authorization: `Bearer ${key}` } : {}) }, cache: "no-store", signal: params.signal });
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
    // allocPpb = the leg's share of the input in parts per billion.
    steps: steps.map((s) => ({
      label: String(s.label ?? s.dex ?? s.amm ?? "Titan"),
      inputMint: String(s.inputMint ?? ""),
      outputMint: String(s.outputMint ?? ""),
      percent: s.allocPpb !== undefined ? Math.round(Number(s.allocPpb) / 1e7) : 100,
    })),
  };
}
