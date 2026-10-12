/**
 * Shapes of the Predict integration: the raw World market model (server internal), the UI model
 * served by `/api/predict/*`, and the trade-build contract.
 *
 * The UI model (`PredictEvent`, `PredictOutcome`, `PredictPosition`, `PredictSummary`,
 * `PredictVault`, `PredictImportable`) mirrors the sample shapes in `lib/predict-sample.ts` field
 * for field so the Predict UI can switch data source. Deviations are marked `DEVIATION` below and
 * listed in docs/PREDICT_INTEGRATION.md. Extra fields carry real data the sample does not have.
 */

export type Side = "yes" | "no";
export type TradeSide = "buy" | "sell";
export type EventType = "binary" | "updown" | "match" | "multi" | "date" | "strike";
/** DEVIATION: the sample's `Cat` has no "other"; World lists culture / misc markets too. */
export type Cat = "crypto" | "sports" | "politics" | "economics" | "other";

// -------------------------------------------------------------------------------------------------
// Raw World data (server internal)
// -------------------------------------------------------------------------------------------------

/** Prices in CASH per outcome token (0–1). `null` when there is no recent mainnet trade. */
export interface MarketPrices {
  /** What one YES costs to buy now (ask). */
  yesAsk: number | null;
  /** What one NO costs to buy now (ask). */
  noAsk: number | null;
  /** What one YES sells for now (bid). */
  yesBid: number | null;
  /** What one NO sells for now (bid). */
  noBid: number | null;
  /** Milliseconds since epoch of the mainnet trade the prices come from. */
  lastTradeAt: number | null;
  /**
   * "quote" = JanusFI's live on-chain quote (the maker World routes to); "trades" = derived from
   * mainnet fills; "reference" = no trade yet, 50/50 opening price.
   */
  source: "quote" | "trades" | "reference" | "none";
}

/** One decoded JanusFI oracle account (see constants.ts `JANUS_ORACLE_OFFSETS`). */
export interface JanusOracle {
  /** World market the quote is for. */
  market: string;
  /** 0 = ordinary, 1 / 2 = mid at an extreme, 3 = paused (no quote used). */
  flags: number;
  slot: number;
  /** When World's keeper last wrote it (epoch ms). */
  updatedMs: number;
  /** YES mid price (0–1); NO mid is 1 − mid. */
  mid: number;
  /** Oracle half-spread (0–1). */
  halfSpread: number;
}

/** A market as decoded from its 320-byte account. */
export interface RawMarket {
  id: string;
  yesMint: string;
  noMint: string;
  vault: string;
  resolutionKind: number;
  startMs: number | null;
  endMs: number | null;
}

/** A World `Group` (mutually exclusive set of markets). */
export interface RawGroup {
  id: string;
  members: string[];
}

/** Token-2022 metadata extension of an outcome mint. */
export interface MintMeta {
  name: string;
  symbol: string;
  uri: string;
}

/** World's per-mint JSON at https://m.world.xyz/<mint>. */
export interface JsonMeta {
  description?: string;
  image?: string;
  name?: string;
  symbol?: string;
}

/** One market with everything the grouping step needs (no prices / pool data yet). */
export interface MarketInfo {
  id: string;
  yesMint: string;
  noMint: string;
  vault: string;
  resolutionKind: number;
  startMs: number | null;
  endMs: number | null;
  /** On-chain YES mint name, e.g. "Kamala Harris (Yes)", "BTC Up". */
  name: string;
  /** On-chain YES mint symbol, e.g. "DN-KHAR-Y". */
  symbol: string;
  /** Question text, e.g. "Will Kamala Harris win the 2028 Democratic presidential nomination?". */
  question: string;
  description: string | null;
  image: string | null;
  category: Cat;
  /** League / series label (NFL, La Liga, F1 …) or a topic label. */
  league: string | null;
  /** World Group this market belongs to, if any. */
  groupId: string | null;
}

// -------------------------------------------------------------------------------------------------
// UI model (mirrors lib/predict-sample.ts)
// -------------------------------------------------------------------------------------------------

/** Live yield-pool figures for one market, outcome-token units (UI). */
export interface PoolDetail {
  /** The pool is allowlisted by the program admin (Buy auto-deposits into it). */
  allowlisted: boolean;
  /** The Pool account exists (otherwise the first deposit creates it in the same batch). */
  exists: boolean;
  /** YES / NO sitting in the pool's own token accounts, not merged yet. */
  yesDangling: number;
  noDangling: number;
  /** USDC the pool has lent into Vanna's USDC reserve, valued at the reserve's live exchange rate. */
  invested: number;
  /** Matched YES+NO the keeper can merge right now: min(yesDangling, noDangling). */
  pendingMerge: number;
}

export interface PredictOutcome {
  /** The World market id (stable outcome key). */
  k: string;
  name: string;
  /** Team / party abbreviation (match events). */
  ab?: string;
  /**
   * Yes / No ask price in cents. DEVIATION: `null` when the market has no mainnet trade to price
   * it from (the sample always has a number); such an outcome is not tradable (`tradable: false`).
   */
  y: number | null;
  n: number | null;
  /** 24h change, points. Not available (no price history is indexed); always omitted. */
  d?: number;
  /** Best-effort 24h CASH volume from the maker-fill scanner. */
  vol: number;
  /**
   * Outcome shares supplied to Vanna's yield vault per side: dangling tokens of that side plus the
   * USDC the matched pairs became, so `min(yes, no)` = USDC lent + pairs pending merge, exactly the
   * sample's semantics. The raw token-account balances are in `poolDetail`.
   */
  pool: { yes: number; no: number };
  /** Custom labels for the Yes / No sides (Up / Down …). */
  yl?: string;
  nl?: string;
  grp?: "lines";
  /** Resolved side. Not decoded from chain yet; always omitted. */
  res?: Side;
  /** Price target (strike events). */
  lv?: number;
  uid: string;
  // ---- extra (not in the sample) ----
  marketId: string;
  yesMint: string;
  noMint: string;
  symbol: string;
  image: string | null;
  /** Real bids in cents (the sample derives bid = ask − 1 tick). */
  yBid: number | null;
  nBid: number | null;
  /** CASH in the market's vault (open interest). */
  oi: number;
  lastTradeAt: number | null;
  /** Where the prices come from: World's live maker quote, the last mainnet fills, or nothing. */
  priceSource: "quote" | "fill" | null;
  /** A buy / sell can be built (priced, not ended). */
  tradable: boolean;
  poolDetail: PoolDetail;
}
/** Same name as the sample's type. */
export type Outcome = PredictOutcome;

export interface PredictEvent {
  /** World Group id, a market id (single-market events) or a derived family key (`f-…`). */
  id: string;
  type: EventType;
  cat: Cat;
  tag: string;
  title: string;
  /** Short badge text (symbol root / asset). The real artwork URL is in `image`. */
  ic: string;
  /** An Up / Down window that is running now. */
  live?: boolean;
  score?: string;
  when?: string;
  /** "3m ago" — last mainnet trade on any outcome. */
  last: string;
  /** End date ("Oct 12, 2026") when chain data has one (Up / Down windows); "" otherwise. */
  ends: string;
  opened: string;
  /** DEVIATION: lifetime volume is not indexed; this equals `v24` (best-effort 24h). */
  vol: number;
  v24: number;
  /** Sum of the outcomes' open interest (CASH in their vaults). */
  oi: number;
  source: string;
  note?: string;
  rules: string;
  /** false = the listed outcomes can all lose (independent markets, not a World Group). */
  exh?: boolean;
  /** DEVIATION: any World crypto asset ("BTC" | "ETH" | "SOL" | "XRP" | "HYPE" …), not only BTC / SOL. */
  asset?: string;
  open?: number;
  countdown?: string;
  outs: PredictOutcome[];
  // ---- extra ----
  image: string | null;
  league: string | null;
  /** How the event was grouped (see lib/predict/grouping.ts). */
  groupedBy: "group" | "vs" | "wins" | "template" | "level" | "date" | "symbol" | "single" | "window";
  startMs: number | null;
  endMs: number | null;
}

export interface PredictSummary {
  /** Positions value at the mark, USD. */
  value: number;
  cost: number;
  pnl: number;
  /** USDC of matched YES/NO pairs lent in the USDC Earn pool. */
  inVault: number;
  earned: number;
  /** Passive yield on the positions, %. */
  apy: number;
  /** Max payout if every pick wins, USD. */
  payout: number;
  count: number;
  perMonth: number;
}

export interface PredictPosition {
  id: string;
  eventId: string;
  marketId: string;
  event: string;
  market: string;
  outcome: string;
  side: Side;
  label: string;
  shares: number;
  yieldShares: number;
  avg: number;
  mark: number;
  value: number;
  cost: number;
  pnl: number;
  inVault: number;
  /** Share of the position matched (lent), 0–100. */
  matched: number;
  earned: number;
  apy: number;
  pays: number;
  since: string;
  /** Shares waiting for the Earn pool to free USDC (queued sell). Always 0: redeem is synchronous. */
  queued?: number;
  /** Just bought / deposited: pairs are being merged into USDC (earns 0 meanwhile). */
  merging?: boolean;
  /** Where the position came from. */
  src?: "vanna" | "wallet" | "polymarket";
  // ---- extra ----
  /** Outcome tokens in the wallet (not earning). */
  walletShares: number;
  /** Pool shares held (9-decimal share token, UI units). */
  poolShares: number;
  /** Outcome tokens those pool shares redeem for right now. */
  poolValueShares: number;
}

export interface PredictVault {
  deposited: number;
  /** DEVIATION: lifetime yield needs a deposit history index; always 0 for now. */
  earned: number;
  apy: number;
  pairs: number;
  share: number;
  events: number;
}

export interface PredictImportable {
  id: string;
  source: "wallet" | "polymarket";
  event: string;
  market: string;
  side: Side;
  label: string;
  shares: number;
  value: number;
  apy: number;
  /** Listed on Vanna (can be moved / deposited). */
  listed?: boolean;
  eventId?: string | null;
  marketId?: string | null;
}

// -------------------------------------------------------------------------------------------------
// API contract
// -------------------------------------------------------------------------------------------------

export interface EventsResponse {
  events: PredictEvent[];
  updatedAt: number;
}

export interface TradeLegRequest {
  marketId: string;
  outcome: Side;
  /** "deposit" moves wallet outcome tokens into the yield pool without trading. */
  side: TradeSide | "deposit";
  /** buy: CASH (or USDC when pay = "USDC") to spend; sell / deposit: outcome tokens. UI units. */
  amount: number;
}

export interface TradeRequest {
  owner: string;
  legs: TradeLegRequest[];
  /** Currency buys are paid in. USDC is swapped to CASH (Jupiter, Manifest) first. Default CASH. */
  pay?: "CASH" | "USDC";
  /** Skip the automatic pool deposit after a buy on an allowlisted market. */
  noPool?: boolean;
}

export interface TradeQuote {
  legIndex: number;
  marketId: string;
  outcome: Side;
  side: TradeSide | "deposit";
  /** CASH paid (buy) or outcome tokens sold / deposited, UI units. */
  amountIn: number;
  /** Outcome tokens received (buy) or CASH received (sell), UI units. */
  amountOut: number;
  price: number;
  /** CASH paid out if the outcome wins. */
  payoutIfWin: number;
  /** Outcome tokens deposited into the yield pool by this leg. */
  pooled: number;
  /** Pool shares redeemed to fund a sell (UI units, 9-decimal share token). */
  redeemedShares: number;
}

export interface BuiltTransaction {
  /** base64 v0 transaction. Maker-signed when `makerSigned`; the wallet adds the owner signature. */
  transaction: string;
  label: string;
  legIndexes: number[];
  makerSigned: boolean;
}

export interface TradeBuildResponse {
  transactions: BuiltTransaction[];
  quotes: TradeQuote[];
  /** Blockhash expiry shared by every transaction (send them in order before it). */
  lastValidBlockHeight: number;
  /** Markets whose pool should be merged by the keeper once the batch confirms. */
  mergeMarkets: string[];
  /** USDC → CASH swap included (pay = USDC). */
  swap: { usdcIn: number; cashOutMin: number } | null;
  warnings: string[];
}

export interface PositionsResponse {
  owner: string;
  wallet: { cash: number; usdc: number; sol: number };
  positions: PredictPosition[];
  summary: PredictSummary;
  vault: PredictVault;
  importable: PredictImportable[];
}

/** One trade of this wallet on the fork, reconstructed from its token balance changes. */
export interface TradeEvent {
  signature: string;
  /** Milliseconds since epoch. */
  time: number | null;
  marketId: string;
  eventId: string | null;
  question: string;
  outcome: Side;
  outcomeLabel: string;
  side: TradeSide;
  shares: number;
  cash: number;
  price: number;
  /** Outcome tokens that went into (+) / out of (−) the yield pool in the same transaction. */
  pooled: number;
}

export interface MergeResult {
  marketId: string;
  signature?: string;
  merged?: number;
  skipped?: string;
  error?: string;
}
