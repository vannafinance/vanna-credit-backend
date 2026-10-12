/**
 * Browser side of Predict (also used by scripts/e2e-predict.ts): API fetchers and the trade
 * executor. The server builds the maker-signed batch; the wallet signs every transaction with ONE
 * `signAllTransactions`; the app sends them to the fork in order (each confirmed before the next,
 * since a deposit spends what the buy before it minted), then asks the keeper to merge the touched
 * pools. Nothing is kept in browser storage: every figure comes from the API or the chain.
 */
import { VersionedTransaction } from "@solana/web3.js";
import { broadcastSignedTransaction } from "@/lib/solana/broadcast";
import { getConnection } from "@/lib/solana/connection";
import type { TxSigner } from "@/lib/solana/wallet-bridge";
import type { EventsResponse, MergeResult, PositionsResponse, PredictEvent, TradeBuildResponse, TradeEvent, TradeRequest } from "./types";

let apiBase = "";
/** Scripts run outside the app: point the fetchers at a dev server (e.g. http://localhost:3100). */
export function setPredictApiBase(base: string) {
  apiBase = base.replace(/\/$/, "");
}

export async function predictApi<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBase}/api/predict${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string })?.error ?? `Request failed (${res.status})`);
  return body as T;
}

const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const fetchPredictEvents = (params: { cat?: string; q?: string } = {}) => {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  return predictApi<EventsResponse>(`/events${qs ? `?${qs}` : ""}`);
};
export const fetchPredictEvent = (id: string) => predictApi<{ event: PredictEvent }>(`/events/${encodeURIComponent(id)}`).then((r) => r.event);
export const fetchPredictPositions = (owner: string) => predictApi<PositionsResponse>(`/positions/${owner}`);
export const fetchPredictActivity = (owner: string, marketId?: string) =>
  predictApi<{ trades: TradeEvent[] }>(`/activity/${owner}${marketId ? `?market=${marketId}` : ""}`).then((r) => r.trades);
export const buildPredictTrade = (req: TradeRequest) => predictApi<TradeBuildResponse>("/trade", post(req));
export const requestPredictFaucet = (address: string, amount?: number, usdc?: boolean) =>
  predictApi<{ ok: true; cash: number; sol: number; usdc?: string }>("/faucet", post({ address, amount, usdc }));
export const requestPoolMerge = (marketIds: string[]) => predictApi<{ results: MergeResult[] }>("/pool/merge", post({ marketIds }));

export interface TradeProgress {
  /** "building" | "signing" | "sending i/n: label" | "confirming i/n" | "merging" */
  step: string;
  index?: number;
  total?: number;
}

export interface TradeResult {
  signatures: string[];
  built: TradeBuildResponse;
  merges: MergeResult[];
}

/**
 * Build → sign all once → send in order → merge. `onProgress` drives the progress modal. A failure
 * part-way through rejects with the signatures that already landed in `error.signatures`.
 */
export async function executePredictTrade(req: TradeRequest, signer: TxSigner, onProgress?: (p: TradeProgress) => void): Promise<TradeResult> {
  onProgress?.({ step: "building" });
  const built = await buildPredictTrade(req);
  if (signer.publicKey.toBase58() !== req.owner) throw new Error("Connected wallet changed; please retry.");
  const txs = built.transactions.map((t) => VersionedTransaction.deserialize(Buffer.from(t.transaction, "base64")));
  onProgress?.({ step: "signing", total: txs.length });
  const signed = await signer.signAllTransactions(txs);
  const conn = getConnection();
  const signatures: string[] = [];
  for (const [i, tx] of signed.entries()) {
    const label = built.transactions[i].label;
    onProgress?.({ step: `sending ${i + 1}/${signed.length}: ${label}`, index: i, total: signed.length });
    try {
      signatures.push(
        await broadcastSignedTransaction(conn, tx, built.lastValidBlockHeight, { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 }, () =>
          onProgress?.({ step: `confirming ${i + 1}/${signed.length}: ${label}`, index: i, total: signed.length }),
        ),
      );
    } catch (error) {
      const e = error instanceof Error ? error : new Error(String(error));
      Object.assign(e, { signatures, failedIndex: i });
      e.message = `${label} failed${signatures.length ? ` (after ${signatures.length} confirmed)` : ""}: ${e.message}`;
      throw e;
    }
  }
  let merges: MergeResult[] = [];
  if (built.mergeMarkets.length) {
    onProgress?.({ step: "merging" });
    // Best effort: the pool keeps the tokens (still redeemable) if the keeper merge fails.
    merges = await requestPoolMerge(built.mergeMarkets).then((r) => r.results).catch((error) => [{ marketId: built.mergeMarkets.join(","), error: String(error) }]);
  }
  return { signatures, built, merges };
}
