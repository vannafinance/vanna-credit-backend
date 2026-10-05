/**
 * Swap service.
 *
 * - WALLET mode: Jupiter REST quote/swap through this app's server routes
 *   (`/api/jupiter/quote`, `/api/jupiter/swap`, which hold the API key and restrict routing to
 *   pool AMMs that behave on a fork). Jupiter builds against mainnet, so the fork's blockhash is
 *   swapped in before signing; stale cloned CLMM/DLMM pools are healed via `surfnet_resetAccount`.
 *
 * - MARGIN mode lives in lib/solana/exec.ts (`quoteMarginSwap` / `executeMarginSwap`): the same
 *   Jupiter routing, built for the margin PDA and wrapped in the program's `margin_execute`.
 */
import { Buffer } from "buffer";
import { VersionedTransaction } from "@solana/web3.js";
import { getConnection } from "./connection";
import { confirmSignatureHttp } from "./confirmation";
import { healStaleDexPools } from "./fork-heal";
import { getActiveSigner, type TxSigner } from "./wallet-bridge";
import { decodeProgramError, VannaTxError } from "./errors";

export type JupiterQuote = Record<string, unknown> & {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold?: string;
  priceImpactPct?: string;
  slippageBps?: number;
  routePlan?: { swapInfo?: { label?: string; ammKey?: string } ; percent?: number }[];
};

/** Base URL for the app's API routes ("" in the browser; scripts set an absolute origin). */
let apiBase = "";
export function setApiBase(base: string) {
  apiBase = base.replace(/\/$/, "");
}

export async function fetchJupiterQuote(params: {
  inputMint: string;
  outputMint: string;
  /** Raw input amount (base units). */
  amount: string | number | bigint;
  slippageBps?: number;
  /** Cap on the route's accounts (Jupiter's `maxAccounts`): a shorter route for margin swaps. */
  maxAccounts?: number;
}): Promise<JupiterQuote> {
  const qs = new URLSearchParams({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: String(params.amount),
    slippageBps: String(params.slippageBps ?? 100),
  });
  if (params.maxAccounts) qs.set("maxAccounts", String(params.maxAccounts));
  const response = await fetch(`${apiBase}/api/jupiter/quote?${qs.toString()}`);
  const body = await response.json();
  if (!response.ok || body?.error) throw new Error(body?.error ?? body?.message ?? "Quote failed");
  return body as JupiterQuote;
}

/** True for Jupiter's SlippageToleranceExceeded (6001 in ITS namespace) or the DLMM stale-bin symptom. */
export function isStaleForkPoolError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /0x1771|custom program error:\s*6001|SlippageToleranceExceeded|0xbbd|custom program error:\s*3005|AccountNotEnoughKeys|bin_array/i.test(text);
}

/** Execute a Jupiter swap from the user's WALLET (not the margin account). */
export async function executeWalletSwap(quote: JupiterQuote, opts: { signer?: TxSigner } = {}): Promise<string> {
  const signer = opts.signer ?? getActiveSigner();
  const res = await fetch(`${apiBase}/api/jupiter/swap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ quoteResponse: quote, userPublicKey: signer.publicKey.toBase58() }),
  });
  const body = await res.json();
  if (!res.ok || !body?.swapTransaction) throw new Error(body?.error ?? body?.message ?? "Swap build failed");

  const connection = getConnection();
  const tx = VersionedTransaction.deserialize(Buffer.from(body.swapTransaction, "base64"));
  // Jupiter builds on mainnet; the fork has its own blockhash queue.
  const latest = await connection.getLatestBlockhash("confirmed");
  tx.message.recentBlockhash = latest.blockhash;
  const simulate = () => connection.simulateTransaction(tx, { sigVerify: false, commitment: "confirmed" });
  let simulation = await simulate();
  if (simulation.value.err) {
    const healed = await healStaleDexPools(connection, tx);
    if (healed > 0) simulation = await simulate();
  }
  if (simulation.value.err) {
    const logs = simulation.value.logs ?? [];
    const raw = `Jupiter swap simulation failed: ${JSON.stringify(simulation.value.err)}\n${logs.join("\n")}`;
    const decoded = decodeProgramError(raw);
    throw new VannaTxError(decoded?.message ?? raw.split("\n")[0], { logs, raw, code: decoded?.name });
  }
  const signed = await signer.signTransaction(tx);
  const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: true, maxRetries: 3 });
  await confirmSignatureHttp(connection, signature, latest.lastValidBlockHeight);
  return signature;
}
