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
 *
 * Live quotes come first (2026-10-12): JanusFI, the maker World routes its markets to, prices every
 * swap from a per-market oracle account its keeper rewrites every few minutes (program
 * `JANUS_ORACLE_PROGRAM`, decoded in decode.ts). Its mid ± spread is the quote world.xyz shows, so
 * thin markets with no recent fill are priced too. Fills remain the fallback (no oracle, a stale or
 * paused one, or an RPC failure). World's own markets API and DFlow's quote API both need a
 * Cloudflare Turnstile token or an API key, so neither is used.
 */
import { PublicKey, type ParsedTransactionWithMeta, type VersionedTransactionResponse } from "@solana/web3.js";
import { Buffer } from "buffer";
import { BISON_TREASURY, CASH_DECIMALS, CASH_MINT, JANUS_MAKER_MARKUP, JANUS_MAKER_PROGRAM, JANUS_ORACLE_PROGRAM, JANUS_ORACLE_SIZE } from "./constants";
import { decodeJanusOracle } from "./decode";
import { fillPrice, pricesFromFills, pricesFromQuote, type Fill } from "./math";
import type { JanusOracle, MarketPrices } from "./types";
import { scanUrls, withFallback, withMainnet, withMainnetHistory } from "./rpc.server";

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

// ---- live quotes (JanusFI oracle) -------------------------------------------------------------

interface QuoteState {
  /** World market → its JanusFI oracle account. */
  oracleOf: Map<string, string>;
  /** YES mint → latest decoded oracle and when this server read it. */
  byYesMint: Map<string, { oracle: JanusOracle; readAt: number }>;
  /** World market → YES mint (to file a read under the mint getMarketPrices is called with). */
  yesMintOf: Map<string, string>;
  indexedAt: number;
  pending: Promise<void> | null;
}
const gq = globalThis as unknown as { __predictQuotes?: QuoteState };
const quotes: QuoteState = (gq.__predictQuotes ??= { oracleOf: new Map(), byYesMint: new Map(), yesMintOf: new Map(), indexedAt: 0, pending: null });

/** A quote this young is served as is; older ones are re-read (one getMultipleAccounts per 100). */
const QUOTE_TTL_MS = 30_000;
/** The full oracle index (one getProgramAccounts, ~150 KB) is rebuilt at most this often. */
const ORACLE_INDEX_TTL_MS = 10 * 60_000;
/** A read older than this is not used (e.g. the RPC has been failing): fills take over. */
const QUOTE_READ_MAX_AGE_MS = 5 * 60_000;
const MULTI_BATCH = 100;

function storeOracle(o: JanusOracle | null, now: number) {
  if (!o) return;
  const yes = quotes.yesMintOf.get(o.market);
  if (yes) quotes.byYesMint.set(yes, { oracle: o, readAt: now });
}

/** Every JanusFI oracle in one program scan: rebuilds the market → oracle index and stores the quotes. */
async function indexOracles() {
  const accounts = await withFallback(scanUrls(), (c) =>
    c.getProgramAccounts(new PublicKey(JANUS_ORACLE_PROGRAM), { filters: [{ dataSize: JANUS_ORACLE_SIZE }] }),
  );
  const now = Date.now();
  const oracleOf = new Map<string, string>();
  for (const { pubkey, account } of accounts) {
    const o = decodeJanusOracle(Buffer.from(account.data));
    if (!o) continue;
    oracleOf.set(o.market, pubkey.toBase58());
    storeOracle(o, now);
  }
  quotes.oracleOf = oracleOf;
  quotes.indexedAt = now;
}

async function readOracles(markets: string[]) {
  const keys = markets.map((m) => quotes.oracleOf.get(m)).filter((k): k is string => Boolean(k));
  for (let i = 0; i < keys.length; i += MULTI_BATCH) {
    const batch = keys.slice(i, i + MULTI_BATCH).map((k) => new PublicKey(k));
    const infos = await withMainnet((c) => c.getMultipleAccountsInfo(batch));
    const now = Date.now();
    infos.forEach((info) => {
      if (info && info.owner.toBase58() === JANUS_ORACLE_PROGRAM) storeOracle(decodeJanusOracle(Buffer.from(info.data)), now);
    });
  }
}

/**
 * Re-reads the live quotes of these markets when older than QUOTE_TTL_MS (batched; concurrent
 * callers share one read). Never throws: on an RPC failure the previous quotes / fills stay in use.
 */
export function refreshQuotes(markets: Array<{ id: string; yesMint: string }>): Promise<void> {
  for (const m of markets) quotes.yesMintOf.set(m.id, m.yesMint);
  const now = Date.now();
  const stale = markets.filter((m) => now - (quotes.byYesMint.get(m.yesMint)?.readAt ?? 0) > QUOTE_TTL_MS).map((m) => m.id);
  if (!stale.length) return quotes.pending ?? Promise.resolve();
  const run = async () => {
    try {
      const unindexed = stale.some((m) => !quotes.oracleOf.has(m));
      if (quotes.indexedAt === 0 || (unindexed && Date.now() - quotes.indexedAt > ORACLE_INDEX_TTL_MS)) await indexOracles();
      const due = stale.filter((m) => Date.now() - (quotes.byYesMint.get(quotes.yesMintOf.get(m)!)?.readAt ?? 0) > QUOTE_TTL_MS);
      await readOracles(due);
    } catch (error) {
      console.warn("Predict live quotes unavailable:", error instanceof Error ? error.message : error);
    }
  };
  quotes.pending = (quotes.pending ?? Promise.resolve()).then(run).finally(() => (quotes.pending = null));
  return quotes.pending;
}

/** The live quote of a market, when there is a fresh, usable one (see math.ts `pricesFromQuote`). */
function quoteFor(yesMint: string): MarketPrices | null {
  const q = quotes.byYesMint.get(yesMint);
  if (!q || Date.now() - q.readAt > QUOTE_READ_MAX_AGE_MS) return null;
  return pricesFromQuote(q.oracle, JANUS_MAKER_MARKUP);
}

/**
 * Asks and bids for a market: JanusFI's live quote when there is one (World's own price), else the
 * last mainnet fills (see math.ts `pricesFromFills`). `lastTradeAt` always comes from the fills.
 */
export function getMarketPrices(yesMint: string, noMint: string, kind: "updown" | "binary", startMs: number | null): MarketPrices {
  const fills = pricesFromFills(
    { yesBuy: state.lastBuy.get(yesMint), noBuy: state.lastBuy.get(noMint), yesSell: state.lastSell.get(yesMint), noSell: state.lastSell.get(noMint) },
    kind,
    startMs,
  );
  const quote = quoteFor(yesMint);
  return quote ? { ...quote, lastTradeAt: fills.lastTradeAt } : fills;
}
