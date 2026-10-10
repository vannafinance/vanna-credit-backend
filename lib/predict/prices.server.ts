/**
 * World outcome prices from real mainnet trades (server only). Ported from Backend-Solana-v2
 * `lib/world/prices.server.ts`.
 *
 * World quotes prices off-chain (DFlow RFQ), so no live price sits on chain. Its trades do: every
 * fill moves CASH and an outcome token for the trader in one transaction. This module reads recent
 * fills of World's two makers (BisonFI via its treasury, JanusFI via its program) and keeps the
 * last buy and sell price per outcome mint:
 *   buy price  = CASH the trader paid / outcome tokens received
 *   sell price = CASH the trader received / outcome tokens sold
 * Trades funded in SOL or USDC (the trader's CASH never moves) are priced from the maker's side
 * of the same transaction instead (see recordFills). Everything is
 * in-memory (globalThis, survives dev hot reloads); nothing is persisted.
 */
import { PublicKey, type ParsedTransactionWithMeta, type VersionedTransactionResponse } from "@solana/web3.js";
import { BISON_TREASURY, CASH_DECIMALS, CASH_MINT, JANUS_MAKER_PROGRAM } from "./constants";
import { fillPrice, pricesFromFills, type Fill } from "./math";
import type { MarketPrices } from "./types";
import { withMainnetHistory } from "./rpc.server";

interface VolumeFill {
  mint: string;
  cash: number;
  ts: number;
}
interface PriceState {
  lastBuy: Map<string, Fill>;
  lastSell: Map<string, Fill>;
  seen: Set<string>;
  refreshedAt: number;
  refreshing: Promise<void> | null;
  mintScannedAt: Map<string, number>;
  sweeping: boolean;
  /** Rolling ~24h CASH-volume fills, pruned on each refresh. Best-effort: only covers what the
   *  maker-fill scanner has actually seen, so a cold server start undercounts. */
  volumeFills: VolumeFill[];
}

const g = globalThis as unknown as { __predictPrices?: PriceState };
const state: PriceState = (g.__predictPrices ??= {
  lastBuy: new Map(),
  lastSell: new Map(),
  seen: new Set(),
  refreshedAt: 0,
  refreshing: null,
  mintScannedAt: new Map(),
  sweeping: false,
  volumeFills: [],
});

const REFRESH_MS = 20_000;
const SIGNATURES_PER_SOURCE = 100;
const MAX_NEW_TX_PER_REFRESH = 40;
/** The first scan after a (re)start reaches further back so most traded markets get a price. */
const BACKFILL_TX_PER_SOURCE = 300;
const MINT_RESCAN_MS = 60_000;
const VOLUME_WINDOW_MS = 24 * 60 * 60_000;

type AnyTx = VersionedTransactionResponse | ParsedTransactionWithMeta;

/** Records the trader's buy / sell price for every outcome mint the transaction moved. */
function recordFills(tx: AnyTx | null) {
  if (!tx?.meta || tx.meta.err) return;
  const ts = (tx.blockTime ?? 0) * 1000;
  const msg = tx.transaction.message as unknown as {
    header?: { numRequiredSignatures: number };
    accountKeys?: Array<PublicKey | { pubkey: PublicKey; signer: boolean }>;
    staticAccountKeys?: PublicKey[];
  };
  const signers = new Set<string>();
  if (msg.staticAccountKeys && msg.header) {
    msg.staticAccountKeys.slice(0, msg.header.numRequiredSignatures).forEach((k) => signers.add(k.toBase58()));
  } else if (msg.accountKeys) {
    for (const k of msg.accountKeys) if ("signer" in k && k.signer) signers.add(k.pubkey.toBase58());
  }
  // Net token change per (owner, mint).
  const delta = new Map<string, number>();
  const bump = (owner: string | undefined, mint: string, amount: string, sign: 1 | -1) => {
    if (!owner) return;
    const key = `${owner}|${mint}`;
    delta.set(key, (delta.get(key) ?? 0) + sign * Number(amount));
  };
  for (const b of tx.meta.preTokenBalances ?? []) bump(b.owner, b.mint, b.uiTokenAmount.amount, -1);
  for (const b of tx.meta.postTokenBalances ?? []) bump(b.owner, b.mint, b.uiTokenAmount.amount, 1);

  // Every party whose CASH and an outcome token moved in opposite directions traded that outcome.
  // Prefer the signer (the trader): price as the trader saw it. Many World trades are funded in
  // USDC / SOL through DFlow, so the trader's own CASH never moves; then the maker's side gives the
  // price, flipped to the trader's perspective (maker bought = trader sold, and vice versa).
  const parties = new Map<string, { cash: number; outcomes: [string, number][] }>();
  for (const [key, amount] of delta) {
    if (amount === 0) continue;
    const [owner, mint] = key.split("|");
    const p = parties.get(owner) ?? { cash: 0, outcomes: [] };
    if (mint === CASH_MINT) p.cash += amount;
    else p.outcomes.push([mint, amount]);
    parties.set(owner, p);
  }
  const trades = [...parties.entries()].filter(([, p]) => p.cash !== 0 && p.outcomes.some(([, a]) => Math.sign(a) === -Math.sign(p.cash)));
  const bySigner = trades.filter(([owner]) => signers.has(owner));
  for (const [owner, p] of bySigner.length ? bySigner : trades) {
    const flip = !signers.has(owner);
    for (const [mint, amount] of p.outcomes) {
      if (Math.sign(amount) !== -Math.sign(p.cash)) continue;
      const price = fillPrice(p.cash, amount);
      if (price === null) continue;
      const partyBought = amount > 0;
      const target = partyBought !== flip ? state.lastBuy : state.lastSell;
      const prev = target.get(mint);
      if (!prev || prev.ts <= ts) target.set(mint, { price, ts });
      state.volumeFills.push({ mint, cash: Math.abs(p.cash) / 10 ** CASH_DECIMALS, ts });
    }
  }
}

function pruneVolumeFills() {
  const cutoff = Date.now() - VOLUME_WINDOW_MS;
  state.volumeFills = state.volumeFills.filter((f) => f.ts >= cutoff);
}

/** Best-effort CASH volume traded on either side of this market in roughly the last 24h. */
export function getMarketVolume(yesMint: string, noMint: string): number {
  let total = 0;
  for (const f of state.volumeFills) if (f.mint === yesMint || f.mint === noMint) total += f.cash;
  return total;
}

async function scanAddress(address: string, limit: number, maxNew: number) {
  const sigs = await withMainnetHistory((conn) => conn.getSignaturesForAddress(new PublicKey(address), { limit }));
  const fresh = sigs.filter((s) => !s.err && !state.seen.has(s.signature)).slice(0, maxNew);
  for (let i = 0; i < fresh.length; i += 4) {
    await Promise.all(
      fresh.slice(i, i + 4).map(async (s) => {
        state.seen.add(s.signature);
        try {
          recordFills(await withMainnetHistory((conn) => conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" })));
        } catch {
          state.seen.delete(s.signature); // retry next refresh
        }
      }),
    );
  }
}

/** Pulls the newest fills of both makers; at most once per REFRESH_MS, never blocks callers. */
export function refreshPrices(): Promise<void> {
  if (Date.now() - state.refreshedAt < REFRESH_MS) return Promise.resolve();
  if (!state.refreshing) {
    state.refreshing = (async () => {
      try {
        const first = state.refreshedAt === 0;
        const limit = first ? 1000 : SIGNATURES_PER_SOURCE;
        const perSource = first ? BACKFILL_TX_PER_SOURCE : MAX_NEW_TX_PER_REFRESH / 2;
        await Promise.allSettled([scanAddress(JANUS_MAKER_PROGRAM, limit, perSource), scanAddress(BISON_TREASURY, limit, perSource)]);
      } finally {
        pruneVolumeFills();
        state.refreshedAt = Date.now();
        state.refreshing = null;
      }
    })();
  }
  return state.refreshing;
}

/** Deeper scan of one market's own history (used by the event page when it has no price). */
export async function scanMarketMints(yesMint: string, noMint: string): Promise<void> {
  const last = state.mintScannedAt.get(yesMint) ?? 0;
  if (Date.now() - last < MINT_RESCAN_MS) return;
  state.mintScannedAt.set(yesMint, Date.now());
  await Promise.allSettled([scanAddress(yesMint, 25, 12), scanAddress(noMint, 25, 12)]);
}

const SWEEP_CONCURRENCY = 4;
const SWEEP_BATCH_DELAY_MS = 600;

/** Background pass over markets that still have no price (bounded concurrency on the shared RPC). */
export function sweepUnpricedMarkets(targets: Array<{ yesMint: string; noMint: string }>) {
  if (state.sweeping) return;
  state.sweeping = true;
  void (async () => {
    try {
      const pending = targets.filter((t) => !state.lastBuy.has(t.yesMint) && !state.lastBuy.has(t.noMint));
      for (let i = 0; i < pending.length; i += SWEEP_CONCURRENCY) {
        const batch = pending.slice(i, i + SWEEP_CONCURRENCY);
        await Promise.all(batch.map((t) => scanMarketMints(t.yesMint, t.noMint).catch(() => {})));
        await new Promise((r) => setTimeout(r, SWEEP_BATCH_DELAY_MS));
      }
    } finally {
      state.sweeping = false;
    }
  })();
}

/** Asks and bids for a market (see math.ts `pricesFromFills`). */
export function getMarketPrices(yesMint: string, noMint: string, kind: "updown" | "binary", startMs: number | null): MarketPrices {
  return pricesFromFills(
    { yesBuy: state.lastBuy.get(yesMint), noBuy: state.lastBuy.get(noMint), yesSell: state.lastSell.get(yesMint), noSell: state.lastSell.get(noMint) },
    kind,
    startMs,
  );
}
