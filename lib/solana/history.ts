import { singleFlight } from "../async";
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Transaction history, decoded from the program's own Anchor events (no indexer — the fork has
 * none). Flow: `getSignaturesForAddress(wallet)` → one `getTransaction` per signature (Surfpool
 * rejects batched JSON-RPC, so `getParsedTransactions` can't be used) with bounded concurrency →
 * `EventParser.parseLogs`.
 *
 * Both Earn and Margin history scan by the OWNER WALLET: it is a required signer of every user
 * transaction, and a signer can never be loaded from an address lookup table, so it always
 * appears in the static keys Surfpool's `getSignaturesForAddress` indexes. (A margin PDA can end
 * up only inside a temporary ALT for large batched transactions.)
 */
import { EventParser } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { VANNA_PROGRAM_ID } from "./config";
import { getConnection } from "./connection";
import { marginPda, reservePda } from "./pdas";
import { getProgram } from "./program";
import { fromRaw } from "./math";
import { getToken, TOKENS, tokenByMint, type TokenInfo } from "./tokens";
import { receiptByMint } from "./kamino";
import { EMBER_PROGRAM_ID, PHOENIX_PROGRAM_ID } from "./phoenix";

let parser: EventParser | null = null;
const getParser = () => (parser ??= new EventParser(VANNA_PROGRAM_ID, getProgram().coder));
const RESERVE_TOKENS = new Map(TOKENS.map((t) => [reservePda(t.mint).toBase58(), t]));

const key = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (v && typeof (v as any).toBase58 === "function") return (v as any).toBase58();
  return String(v ?? "");
};
const field = (data: any, snake: string, camel: string) => data?.[camel] ?? data?.[snake];
const bigOf = (v: unknown): bigint => BigInt(key(v) || "0");

export interface EarnHistoryRow {
  type: "supply" | "withdraw";
  symbol: string;
  /** UI units of the underlying. */
  amount: string;
  amountRaw: bigint;
  sharesRaw: bigint;
  /** ms since epoch. */
  timestamp: number;
  signature: string;
}

export type MarginEventType =
  | "create"
  | "deposit"
  | "withdraw"
  | "borrow"
  | "repay"
  | "liquidation"
  | "open-debt"
  | "close-debt"
  | "close-collateral"
  /** `margin_execute` via Jupiter or Titan (`via`): `symbol`/`amount` = spent, `toSymbol`/`toAmount` = received. */
  | "swap"
  /** `margin_execute` Kamino deposit: `symbol`/`amount` = underlying supplied. */
  | "farm-deposit"
  /** `margin_execute` Kamino redeem: `symbol`/`amount` = underlying received back. */
  | "farm-withdraw"
  /** Ember wrap funding Phoenix: `symbol`/`amount` = USDC moved from the margin into Phoenix. */
  | "perp-open"
  /** A Phoenix market order (open or close; it moves no USDC itself). */
  | "perp-order"
  /** `public_venue_settle`: `symbol`/`amount` = USDC swept back into the margin account. */
  | "perp-settle";

export interface MarginHistoryRow {
  type: MarginEventType;
  symbol: string;
  amount: string;
  amountRaw: bigint;
  timestamp: number;
  signature: string;
  /** Post-action borrow health factor reported by the program (borrow / withdraw / execute), when present. */
  healthFactor?: number;
  /** Received side of a swap. */
  toSymbol?: string;
  toAmount?: string;
  /** Aggregator a swap ran through (from the `MarginExecuted` event's target program). */
  via?: "Jupiter" | "Titan";
}

/** Swap aggregators by program id, to label `swap` rows. */
const SWAP_VIA: Record<string, "Jupiter" | "Titan"> = {
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter",
  T1TANpTeScyeqVzzgNViGDNrkQ6qHz9KrSBS4aNXvGT: "Titan",
};

export interface HistoryPage<T> {
  rows: T[];
  /** True when the scan reached the wallet's oldest signature (history is complete). */
  complete: boolean;
  scanned: number;
}

interface RawTx {
  signature: string;
  blockTime: number | null;
  logs: string[];
}

/** Max signatures scanned per history call (one getTransaction each). */
const MAX_SIGNATURES = 200;
const CONCURRENCY = 6;

// Finalized transaction logs are immutable. Bound memory and lifetime (the fork can restart).
const transactionCache = new Map<string, { at: number; tx: RawTx | null }>();
const HISTORY_CACHE_MS = 5 * 60_000;
const HISTORY_CACHE_LIMIT = 1_000;
const historyReads = singleFlight<string, { txs: RawTx[]; complete: boolean; scanned: number }>();

function recentVannaTransactions(address: PublicKey, limit = MAX_SIGNATURES): Promise<{ txs: RawTx[]; complete: boolean; scanned: number }> {
  return historyReads(`${address.toBase58()}:${limit}`, () => readRecentVannaTransactions(address, limit));
}

async function readRecentVannaTransactions(address: PublicKey, limit: number) {
  const connection = getConnection();
  const signatures = await connection.getSignaturesForAddress(address, { limit }, "confirmed");
  const ok = signatures.filter((s) => !s.err);
  const txs: RawTx[] = [];
  let complete = signatures.length < limit;
  for (let i = 0; i < ok.length; i += CONCURRENCY) {
    const batch = await Promise.all(
      ok.slice(i, i + CONCURRENCY).map(async (s) => {
        const cached = transactionCache.get(s.signature);
        if (cached && Date.now() - cached.at < HISTORY_CACHE_MS) return cached.tx;
        transactionCache.delete(s.signature);
        const tx = await connection.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        // RPC indexing may lag confirmation. Retry missing transactions next refresh and do
        // not report a complete cost basis while any transaction is unavailable.
        if (!tx) { complete = false; return null; }
        const logs = tx.meta?.logMessages ?? [];
        const result = logs.some((l) => l.includes(VANNA_PROGRAM_ID.toBase58()))
          ? { signature: s.signature, blockTime: s.blockTime ?? tx.blockTime ?? null, logs } as RawTx
          : null;
        if (s.confirmationStatus === "finalized") {
          transactionCache.set(s.signature, { at: Date.now(), tx: result });
          if (transactionCache.size > HISTORY_CACHE_LIMIT) transactionCache.delete(transactionCache.keys().next().value!);
        }
        return result;
      }),
    );
    for (const t of batch) if (t) txs.push(t);
  }
  return { txs, complete, scanned: signatures.length };
}

function* events(tx: RawTx) {
  try {
    // The camelCase-converted IDL yields "liquiditySupplied"; normalise to the Rust name.
    for (const e of getParser().parseLogs(tx.logs)) yield { name: e.name.charAt(0).toUpperCase() + e.name.slice(1), data: e.data as any };
  } catch {
    // Unparseable log stream (truncated logs) — skip the tx rather than fail the page.
  }
}

const ts = (data: any, tx: RawTx) => {
  const t = Number(key(field(data, "timestamp", "timestamp")) || 0);
  return (t || tx.blockTime || 0) * 1000;
};

/** Lender supply / redeem history for `owner`, newest first. */
export async function fetchEarnHistory(owner: PublicKey): Promise<HistoryPage<EarnHistoryRow>> {
  const { txs, complete, scanned } = await recentVannaTransactions(owner);
  const rows: EarnHistoryRow[] = [];
  const me = owner.toBase58();
  for (const tx of txs) {
    for (const e of events(tx)) {
      if (e.name !== "LiquiditySupplied" && e.name !== "LiquidityRedeemed") continue;
      if (key(field(e.data, "lender", "lender")) !== me) continue;
      const token = RESERVE_TOKENS.get(key(field(e.data, "reserve", "reserve")));
      if (!token) continue;
      const amountRaw = bigOf(field(e.data, "assets", "assets"));
      rows.push({
        type: e.name === "LiquiditySupplied" ? "supply" : "withdraw",
        symbol: token.symbol,
        amount: fromRaw(amountRaw, token.decimals),
        amountRaw,
        sharesRaw: bigOf(field(e.data, "shares", "shares")),
        timestamp: ts(e.data, tx),
        signature: tx.signature,
      });
    }
  }
  rows.sort((a, b) => b.timestamp - a.timestamp);
  return { rows, complete, scanned };
}

/** Margin-account history for `owner`'s margin account, newest first. */
export async function fetchMarginHistory(owner: PublicKey): Promise<HistoryPage<MarginHistoryRow>> {
  const { txs, complete, scanned } = await recentVannaTransactions(owner);
  const margin = marginPda(owner).toBase58();
  const rows: MarginHistoryRow[] = [];
  const tokenOfMint = (m: unknown): TokenInfo | undefined => tokenByMint(key(m));
  const tokenOfReserve = (r: unknown): TokenInfo | undefined => RESERVE_TOKENS.get(key(r));
  const hf = (data: any) => {
    const w = field(data, "borrow_health_factor_wad", "borrowHealthFactorWad");
    if (w === undefined) return undefined;
    const v = bigOf(w);
    // u128::MAX = no debt.
    return v > 10n ** 30n ? undefined : Number((v * 1000n) / 10n ** 18n) / 1000;
  };
  for (const tx of txs) {
    for (const e of events(tx)) {
      if (key(field(e.data, "margin_account", "marginAccount")) !== margin) continue;
      const base = { timestamp: ts(e.data, tx), signature: tx.signature };
      const push = (type: MarginEventType, token: TokenInfo | undefined, raw: bigint, extra: Partial<MarginHistoryRow> = {}) => {
        rows.push({ type, symbol: token?.symbol ?? "", amount: token ? fromRaw(raw, token.decimals) : "0", amountRaw: raw, ...base, ...extra });
      };
      switch (e.name) {
        case "MarginCreated":
          push("create", undefined, 0n);
          break;
        case "CollateralDeposited":
          push("deposit", tokenOfMint(field(e.data, "mint", "mint")), bigOf(field(e.data, "amount", "amount")));
          break;
        case "CollateralWithdrawn":
          push("withdraw", tokenOfMint(field(e.data, "mint", "mint")), bigOf(field(e.data, "amount", "amount")), { healthFactor: hf(e.data) });
          break;
        case "Borrowed":
          push("borrow", tokenOfReserve(field(e.data, "reserve", "reserve")), bigOf(field(e.data, "assets", "assets")), { healthFactor: hf(e.data) });
          break;
        case "DebtRepaid":
          push("repay", tokenOfReserve(field(e.data, "reserve", "reserve")), bigOf(field(e.data, "assets", "assets")));
          break;
        case "Liquidated":
          // Whole-account liquidation: every collateral is seized and every debt repaid in one
          // instruction, so there is no single token/amount — record the pre-liquidation HF.
          {
            const w = bigOf(field(e.data, "health_factor_wad", "healthFactorWad"));
            push("liquidation", undefined, 0n, { healthFactor: w > 10n ** 30n ? undefined : Number((w * 1000n) / 10n ** 18n) / 1000 });
          }
          break;
        case "DebtPositionOpened":
          push("open-debt", tokenOfReserve(field(e.data, "reserve", "reserve")), 0n);
          break;
        case "DebtPositionClosed":
          push("close-debt", tokenOfReserve(field(e.data, "reserve", "reserve")), 0n);
          break;
        case "CollateralPositionClosed":
          push("close-collateral", tokenOfMint(field(e.data, "mint", "mint")), 0n);
          break;
        case "MarginExecuted": {
          // `spent` / `received`: [{ mint, amount }] per margin vault paid out of / into. Phoenix
          // funding goes through Ember (USDC ↔ phUSD): the wrap is the perp funding, the unwrap the
          // USDC coming back; Phoenix's own calls move phUSD (shown by the Ember rows) or nothing.
          const amounts = (name: string) =>
            ((field(e.data, name, name) as any[] | undefined) ?? []).map((t) => ({ mint: key(field(t, "mint", "mint")), amount: bigOf(field(t, "amount", "amount")) }));
          const spentList = amounts("spent");
          const receivedList = amounts("received");
          const target = key(field(e.data, "program_id", "programId"));
          if (target === EMBER_PROGRAM_ID.toBase58()) {
            const usdcOut = spentList.find((t) => tokenOfMint(t.mint)?.symbol === "USDC");
            const usdcIn = receivedList.find((t) => tokenOfMint(t.mint)?.symbol === "USDC");
            if (usdcOut) push("perp-open", getToken("USDC"), usdcOut.amount, { healthFactor: hf(e.data) });
            else if (usdcIn) push("perp-settle", getToken("USDC"), usdcIn.amount);
            break;
          }
          if (target === PHOENIX_PROGRAM_ID.toBase58()) {
            if (spentList.length === 0 && receivedList.length === 0) push("perp-order", undefined, 0n, { healthFactor: hf(e.data) });
            break;
          }
          const spentMint = spentList[0]?.mint ?? "";
          const receivedMint = receivedList[0]?.mint ?? "";
          const spent = spentList[0]?.amount ?? 0n;
          const received = receivedList[0]?.amount ?? 0n;
          const kIn = receiptByMint(receivedMint);
          const kOut = receiptByMint(spentMint);
          if (kIn) {
            push("farm-deposit", tokenOfMint(spentMint), spent, { healthFactor: hf(e.data) });
          } else if (kOut) {
            push("farm-withdraw", tokenOfMint(receivedMint), received, { healthFactor: hf(e.data) });
          } else {
            const to = tokenOfMint(receivedMint);
            push("swap", tokenOfMint(spentMint), spent, {
              healthFactor: hf(e.data),
              toSymbol: to?.symbol ?? "",
              toAmount: to ? fromRaw(received, to.decimals) : "0",
              via: SWAP_VIA[target],
            });
          }
          break;
        }
        case "VenueSettled": {
          const swept = bigOf(field(e.data, "swept", "swept"));
          if (swept > 0n) push("perp-settle", getToken("USDC"), swept);
          break;
        }
      }
    }
  }
  rows.sort((a, b) => b.timestamp - a.timestamp);
  return { rows, complete, scanned };
}

export interface EarnedInterest {
  symbol: string;
  /** Net deposited principal (Σ supplied − Σ redeemed), UI units; null when history is incomplete. */
  netDeposited: number | null;
  /** Current value − net deposited; null when it can't be computed honestly. */
  earned: number | null;
  /** Why `earned` is null, if it is. */
  reason?: string;
}

/**
 * Interest earned per asset = current position value − (Σ supplied − Σ redeemed).
 *
 * NEVER defaults missing history to zero cost basis (a previous Stellar bug showed 100% of a
 * deposit as yield). The result is only trusted when the history is provably complete for that
 * asset: the net SHARES from the decoded events must equal the wallet's current share balance.
 * Otherwise (shares transferred in, scan window exhausted, …) `earned` is null with a reason.
 */
export function computeEarnedInterest(
  history: HistoryPage<EarnHistoryRow>,
  positions: Record<string, { sharesRaw: bigint; assets: number }>,
): Record<string, EarnedInterest> {
  const out: Record<string, EarnedInterest> = {};
  for (const t of TOKENS) {
    const rows = history.rows.filter((r) => r.symbol === t.symbol);
    const pos = positions[t.symbol];
    const held = pos?.sharesRaw ?? 0n;
    let netShares = 0n;
    let netAssets = 0n;
    for (const r of rows) {
      if (r.type === "supply") {
        netShares += r.sharesRaw;
        netAssets += r.amountRaw;
      } else {
        netShares -= r.sharesRaw;
        netAssets -= r.amountRaw;
      }
    }
    if (held === 0n && rows.length === 0) {
      out[t.symbol] = { symbol: t.symbol, netDeposited: 0, earned: 0 };
      continue;
    }
    if (netShares !== held) {
      out[t.symbol] = {
        symbol: t.symbol,
        netDeposited: null,
        earned: null,
        reason: history.complete ? "Share balance does not match on-chain history (shares moved outside supply/redeem)" : "History older than the scan window",
      };
      continue;
    }
    const net = Number(fromRaw(netAssets, t.decimals));
    const earned = (pos?.assets ?? 0) - net;
    out[t.symbol] = { symbol: t.symbol, netDeposited: net, earned: held === 0n ? -net : earned };
  }
  return out;
}
