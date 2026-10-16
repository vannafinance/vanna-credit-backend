import { vaultByMint } from "./vault-catalogue";
import { basisOraclePrice } from "./vault-oracles";
import { singleFlight, type ReadScope } from "../async";
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Margin-account service layer for the core program `vanna_credit_layer` (Frontend Integration
 * Guide): user_create_margin, user_deposit_collateral, user_borrow (opens the debt position itself),
 * user_repay_from_margin (the only repay path), user_withdraw_collateral, user_reclaim_rent.
 *
 * Prices come from the oracle AGENT: health-checked instructions end their `remaining_accounts`
 * with its segment `[vanna_oracle, price_book, ...price accounts]`. The Phoenix venue (the margin's
 * Phoenix trader account) counts as one holding at the value the oracle reports (collateral +
 * position equity).
 *
 * Health model (V1, account-wide): HF = Σ collateral USD / Σ debt USD, liquidatable at HF <= 1.10.
 * The margin vault's live balance IS the collateral, and borrowed tokens land in the vault, so a
 * borrow raises both sides of the ratio.
 *
 * Risk-checked instructions (borrow, withdraw) must pass EVERY other active position in
 * `remaining_accounts`, in the margin account's array slot order — see
 * {@link buildHealthRemainingAccounts}. Several instructions can be batched in one transaction;
 * {@link MarginIndexModel} replays each instruction's effect on the active-asset arrays so every
 * instruction in the batch gets the account list the program will expect at that point.
 *
 * `margin_execute` (Jupiter swaps, Kamino farm supply / redeem) is built in lib/solana/exec.ts on
 * top of this module's batch context and health-scan builder.
 */
import { BN } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import { PublicKey, SystemProgram, type AccountMeta, type AccountInfo, type TransactionInstruction } from "@solana/web3.js";
import { BATCH_COMPUTE_UNITS, ORACLE_PROGRAM_ID, SAFE_HEALTH_FACTOR, LIQUIDATION_HEALTH_FACTOR } from "./config";
import { forkUnixTimestamp, getConnection, getMultipleAccountsChunked } from "./connection";
import { accounts, big, getProgram } from "./program";
import {
  assetConfigPda,
  debtPositionPda,
  marginPda,
  marginVault,
  priceBookPda,
  protocolConfigPda,
  reservePda,
  reserveVault,
  walletAta,
} from "./pdas";
import {
  fetchAllAssetConfigs,
  decodeReserve,
  fetchPoolStates,
  tokenAccountAmount,
  type AssetConfigState,
  type PoolState,
} from "./protocol-state";
import { type OnchainPrice } from "./pyth";
import { priceFromAccounts } from "./oracle";
import { fetchWalletBalances, spendableLamports } from "./balances";
import { findToken, getToken, TOKENS, tokenByMint, type TokenInfo } from "./tokens";
import {
  assetsToDebtSharesUp,
  debtSharesToAssetsUp,
  fromRaw,
  healthFactorWad,
  normalizeTokenValue,
  projectReserve,
  rawToNumber,
  toRaw,
  WAD,
} from "./math";
import { sendInstructions } from "./tx";
import { getActiveSigner, type TxSigner } from "./wallet-bridge";
import { ensureFreshPrices } from "./price-refresh";
import { temporaryWsolReceiver, wrapSolInstructions } from "./wsol";
import { readReserveRate, receiptByMint, underlyingForReceipts, type ReserveRate } from "./kamino";
import { loadPhoenixVenue, venueOracleAccounts, type PhoenixVenueContext } from "./phoenix-state";
import { phoenixTraderPda } from "./phoenix";

/** Sentinel for an empty slot in `collateral_asset_indexes` / `debt_asset_indexes`. */
export const EMPTY_ASSET_INDEX = 65535;
/** nano-USD per USD. */
const NANO = 1_000_000_000;

export interface MarginServiceOptions {
  /** Defaults to the connected browser wallet. */
  signer?: TxSigner;
  onStatus?: (status: string) => void;
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

export interface MarginAccountRaw {
  address: PublicKey;
  authority: PublicKey;
  status: number;
  collateralCount: number;
  /** Global allowed tokens, followed by active venues in collateralAssetIndexes. */
  allowedTokenIndexes?: number[];
  debtCount: number;
  collateralAssetIndexes: number[];
  debtAssetIndexes: number[];
  eventSequence: bigint;
}

export async function fetchMarginAccount(owner: PublicKey): Promise<MarginAccountRaw | null> {
  const address = marginPda(owner);
  const [raw, protocol] = await Promise.all([accounts().marginAccount.fetchNullable(address), accounts().protocolConfig.fetch(protocolConfigPda())]);
  const allowed = (protocol.allowedTokens as number[]).filter((i) => i !== EMPTY_ASSET_INDEX);
  if (!raw) return null;
  return {
    address,
    authority: raw.authority,
    status: Number(raw.status),
    collateralCount: allowed.length + Number(raw.venueCount),
    allowedTokenIndexes: allowed,
    debtCount: Number(raw.debtCount),
    collateralAssetIndexes: [...allowed, ...(raw.venueAssetIndexes as number[]).map(Number)],
    debtAssetIndexes: (raw.debtAssetIndexes as number[]).map(Number),
    eventSequence: big(raw.eventSequence),
  };
}

export interface CollateralPosition {
  symbol: string;
  /** Registry token, or null for an on-chain asset this UI doesn't list. */
  token: TokenInfo | null;
  assetIndex: number;
  mint: PublicKey;
  vault: PublicKey;
  amountRaw: bigint;
  amount: number;
  /** nano-USD, rounded down like the program. */
  valueNano: bigint;
  usd: number;
  /** True when counted in the health factor (active in collateral_asset_indexes). */
  active: boolean;
}

export interface DebtPositionView {
  symbol: string;
  token: TokenInfo | null;
  assetIndex: number;
  mint: PublicKey;
  debtPosition: PublicKey;
  borrowShares: bigint;
  /** Current debt accrued to fork-now, rounded up like the program. */
  debtRaw: bigint;
  debt: number;
  valueNano: bigint;
  usd: number;
  borrowApr: number;
}

export interface MarginSnapshot {
  owner: string;
  exists: boolean;
  address: string;
  raw: MarginAccountRaw | null;
  /** Fork clock used for accrual projection and staleness checks. */
  now: bigint;
  collateral: CollateralPosition[];
  debts: DebtPositionView[];
  /** Registry symbols whose debt_position PDA exists (open, possibly with zero shares). */
  openDebtPositions: string[];
  totalCollateralNano: bigint;
  totalDebtNano: bigint;
  totalCollateralUsd: number;
  totalDebtUsd: number;
  /** null = infinite (no debt). */
  healthFactor: number | null;
  healthFactorWad: bigint | null;
  /** The Phoenix venue, when the margin holds it (counted in the totals above). */
  venue: PhoenixVenueContext | null;
  prices: Record<string, OnchainPrice | null>;
  /** Symbols whose on-chain price is older than their asset's max_price_age_secs. */
  stalePrices: string[];
}

/**
 * Display valuation at the last on-chain price. A stale price is NOT zeroed: on the fork the keeper
 * refreshes prices in between, and zeroing made collateral vanish and the health factor jump (2.03 →
 * 1.04) until the next refresh. Staleness is reported separately (`stalePrices`), and every
 * transaction refreshes prices before the program values anything.
 */
function valueOf(amount: bigint, price: OnchainPrice | null, decimals: number, roundUp: boolean): bigint {
  if (!price || price.price <= 0n) return 0n;
  return normalizeTokenValue(amount, price.price, price.exponent, decimals, roundUp);
}

/**
 * Full margin snapshot for `owner`: every collateral vault (registry tokens + any other active
 * on-chain asset), every debt position accrued to fork-now, on-chain prices and the exact HF.
 */
/** Last good simulated price per Basis receipt mint (process / page memory, never persisted). */
const lastBasisPrice = new Map<string, NonNullable<Awaited<ReturnType<typeof basisOraclePrice>>>>();

const fetchMarginSnapshotReads = singleFlight<string, MarginSnapshot>();
export function fetchMarginSnapshot(owner: PublicKey, scope?: ReadScope): Promise<MarginSnapshot> {
  return fetchMarginSnapshotReads(owner.toBase58(), () => readMarginSnapshot(owner, scope), scope);
}

async function readMarginSnapshot(owner: PublicKey, scope?: ReadScope): Promise<MarginSnapshot> {
  const connection = getConnection();
  const margin = marginPda(owner);
  const [raw, assetMap, pools, now] = await Promise.all([
    fetchMarginAccount(owner),
    fetchAllAssetConfigs(connection, scope),
    fetchPoolStates(connection, scope),
    forkUnixTimestamp(connection, scope),
  ]);
  const empty: MarginSnapshot = {
    owner: owner.toBase58(),
    exists: false,
    address: margin.toBase58(),
    raw: null,
    now,
    collateral: [],
    debts: [],
    openDebtPositions: [],
    totalCollateralNano: 0n,
    totalDebtNano: 0n,
    totalCollateralUsd: 0,
    totalDebtUsd: 0,
    healthFactor: null,
    healthFactorWad: null,
    venue: null,
    prices: {},
    stalePrices: [],
  };

  // Assets to read: all registry tokens + any active index outside the registry.
  const assetsByMint = new Map<string, AssetConfigState>();
  for (const a of assetMap.values()) assetsByMint.set(a.mint.toBase58(), a);
  const activeCol = raw ? raw.collateralAssetIndexes.filter((i) => i !== EMPTY_ASSET_INDEX) : [];
  const activeDebt = raw ? raw.debtAssetIndexes.filter((i) => i !== EMPTY_ASSET_INDEX) : [];
  const readAssets = new Map<number, AssetConfigState>();
  for (const t of TOKENS) {
    const a = assetsByMint.get(t.mint.toBase58());
    if (a) readAssets.set(a.assetIndex, a);
  }
  for (const i of [...activeCol, ...activeDebt]) {
    const a = assetMap.get(i);
    if (a) readAssets.set(i, a);
  }
  // A venue isn't a token: the oracle values it from the margin's Phoenix trader (below), not a vault.
  const assetList = [...readAssets.values()].filter((a) => a.kind === "token");
  const venueAsset = [...assetMap.values()].find((a) => a.kind === "venue" && activeCol.includes(a.assetIndex)) ?? null;

  // Per asset: [margin vault, debt position, reserve]. Prices come from each asset's own on-chain
  // OracleConfig (Scope chain first, Pyth fallback), read from one deduplicated fetch of every
  // oracle account involved — which also holds each Kamino receipt's klend reserve.
  const keys: PublicKey[] = [];
  for (const a of assetList) {
    keys.push(marginVault(margin, a.mint, a.tokenProgram), debtPositionPda(margin, reservePda(a.mint)), reservePda(a.mint));
  }
  const oracleKeys = [...new Map(assetList.filter(a => vaultByMint(a.mint.toBase58())?.kind !== "basis").flatMap((a) => a.oracleAccounts).map((k) => [k.toBase58(), k])).values()];
  const infosRead = raw ? getMultipleAccountsChunked(connection, keys) : Promise.resolve([] as (AccountInfo<Buffer> | null)[]);
  // Basis valuation depends on held vault balances, not the unrelated token oracle read.
  const basisPricesRead = infosRead.then(async (infos) => {
    const basisPrices = new Map<number, Awaited<ReturnType<typeof basisOraclePrice>>>();
    await Promise.all(assetList.map(async (a,i) => {
      const def = vaultByMint(a.mint.toBase58());
      if (def?.kind !== "basis" || !raw || tokenAccountAmount(infos[i*3],a.tokenProgram) === 0n) return;
      const key = a.mint.toBase58();
      try {
        const p = await basisOraclePrice(def, connection, scope);
        basisPrices.set(a.assetIndex, p);
        if (p && p.price > 0n) lastBasisPrice.set(key, p);
      } catch {
        // Keep the existing stale-price fallback when simulation fails; never invent a price.
        const last = lastBasisPrice.get(key);
        if (last) basisPrices.set(a.assetIndex, { ...last, fresh: false });
      }
    }));
    return basisPrices;
  });
  const [infos, oracleInfos, basisPrices, venue] = await Promise.all([
    infosRead,
    getMultipleAccountsChunked(connection, oracleKeys),
    basisPricesRead,
    venueAsset ? loadPhoenixVenue(connection, margin, now) : Promise.resolve(null),
  ]);
  const oracleMap = new Map(oracleKeys.map((k, i) => [k.toBase58(), oracleInfos[i] as AccountInfo<Buffer> | null]));
  const priceOf = (a: AssetConfigState) => basisPrices.get(a.assetIndex) ?? priceFromAccounts(a.oracle, oracleMap, now);
  if (!raw) {
    empty.prices = Object.fromEntries(assetList.map((a) => [tokenByMint(a.mint)?.symbol ?? a.mint.toBase58(), priceOf(a)]));
    return empty;
  }

  // Kamino receipt (cToken) collateral is priced like the program prices it: the reserve's
  // exchange rate × the underlying's price (a receipt's OracleConfig is its underlying's, plus the
  // klend reserve).
  const receiptRates = new Map<number, ReserveRate>();
  for (const a of assetList) {
    if (a.priceSource !== "kaminoReceipt") continue;
    const info = oracleMap.get(a.priceSourceAccount.toBase58());
    if (!info) continue;
    try {
      receiptRates.set(a.assetIndex, readReserveRate(info.data, a.mint));
    } catch {
      // Unexpected layout — leave it unvalued (the program would fail closed too).
    }
  }

  const collateral: CollateralPosition[] = [];
  const debts: DebtPositionView[] = [];
  const openDebtPositions: string[] = [];
  const prices: Record<string, OnchainPrice | null> = {};
  const stalePrices: string[] = [];
  let totalCollateralNano = 0n;
  let totalDebtNano = 0n;

  assetList.forEach((asset, i) => {
    const token = tokenByMint(asset.mint) ?? null;
    const symbol = token?.symbol ?? receiptByMint(asset.mint)?.symbol ?? vaultByMint(asset.mint.toBase58())?.symbol ?? asset.mint.toBase58().slice(0, 6);
    const vaultInfo = infos[i * 3] as AccountInfo<Buffer> | null;
    const debtInfo = infos[i * 3 + 1] as AccountInfo<Buffer> | null;
    const reserveInfo = infos[i * 3 + 2] as AccountInfo<Buffer> | null;
    const price = priceOf(asset);
    prices[symbol] = price;


    const vaultAmount = tokenAccountAmount(vaultInfo, asset.tokenProgram);
    const isActiveCol = activeCol.includes(asset.assetIndex);
    if (vaultAmount > 0n && (!price || !price.fresh)) stalePrices.push(symbol);
    if (vaultAmount > 0n) {
      // Kamino receipts: underlying = receipts × total_liquidity / collateral_supply, valued with the
      // underlying's decimals — exactly `oracle/valuation.rs::collateral_value`. An unreadable reserve
      // leaves the receipt at 0 USD rather than guessing.
      const rate = receiptRates.get(asset.assetIndex);
      const valueNano =
        asset.priceSource !== "kaminoReceipt"
          ? valueOf(vaultAmount, price, asset.decimals, false)
          : rate
            ? valueOf(underlyingForReceipts(rate, vaultAmount), price, rate.liquidityDecimals, false)
            : 0n;
      if (isActiveCol) totalCollateralNano += valueNano;
      collateral.push({
        symbol,
        token,
        assetIndex: asset.assetIndex,
        mint: asset.mint,
        vault: keys[i * 3],
        amountRaw: vaultAmount,
        amount: rawToNumber(vaultAmount, asset.decimals),
        valueNano,
        usd: Number(valueNano) / NANO,
        active: isActiveCol,
      });
    }

    if (debtInfo) {
      if (token) openDebtPositions.push(token.symbol);
      const dp = getProgram().coder.accounts.decode("debtPosition", debtInfo.data);
      const shares = big(dp.borrowShares);
      const pool = token ? pools[token.symbol] : undefined;
      let reserveState = pool?.reserve ?? null;
      if (!reserveState && reserveInfo) reserveState = decodeReserve(keys[i * 3 + 2], reserveInfo);
      if (shares > 0n && reserveState) {
        const projected = projectReserve(reserveState, now);
        const debtRaw = debtSharesToAssetsUp(shares, projected.totalBorrowShares, projected.totalBorrowAssets);
        const valueNano = valueOf(debtRaw, price, asset.decimals, true);
        totalDebtNano += valueNano;
        debts.push({
          symbol,
          token,
          assetIndex: asset.assetIndex,
          mint: asset.mint,
          debtPosition: keys[i * 3 + 1],
          borrowShares: shares,
          debtRaw,
          debt: rawToNumber(debtRaw, asset.decimals),
          valueNano,
          usd: Number(valueNano) / NANO,
          borrowApr: pool?.borrowApr ?? 0,
        });
      }
    }
  });

  if (venueAsset) {
    if (venue) {
      // Counted at full value, like every holding (the guide: LTV/threshold aren't used yet).
      totalCollateralNano += venue.valueNano;
      collateral.push({
        symbol: "Phoenix",
        token: null,
        assetIndex: venueAsset.assetIndex,
        mint: venueAsset.mint,
        vault: phoenixTraderPda(margin),
        amountRaw: 0n,
        amount: 0,
        valueNano: venue.valueNano,
        usd: Number(venue.valueNano) / NANO,
        active: true,
      });
    }
  }
  const hfWad = healthFactorWad(totalCollateralNano, totalDebtNano);
  // Order rows by the registry, unknown assets last.
  const order = (s: string) => {
    const idx = TOKENS.findIndex((t) => t.symbol === s);
    return idx === -1 ? 999 : idx;
  };
  collateral.sort((a, b) => order(a.symbol) - order(b.symbol));
  debts.sort((a, b) => order(a.symbol) - order(b.symbol));

  return {
    owner: owner.toBase58(),
    exists: true,
    address: margin.toBase58(),
    raw,
    now,
    collateral,
    debts,
    openDebtPositions,
    totalCollateralNano,
    totalDebtNano,
    totalCollateralUsd: Number(totalCollateralNano) / NANO,
    totalDebtUsd: Number(totalDebtNano) / NANO,
    healthFactor: hfWad === null ? null : Number((hfWad * 1_000_000n) / WAD) / 1e6,
    healthFactorWad: hfWad,
    venue,
    prices,
    stalePrices,
  };
}

// ---------------------------------------------------------------------------------------------
// Health-scan remaining accounts
// ---------------------------------------------------------------------------------------------

/**
 * Client-side replica of the margin account's canonical active-asset arrays. Replays each
 * instruction's effect (`add_active_*` fills the FIRST empty slot, `remove_active_*` empties the
 * slot in place) so a batched transaction's later instructions get the exact account order the
 * program will scan at that point.
 */
export class MarginIndexModel {
  collateral: number[];
  debt: number[];
  /** Simulated vault balances per asset index (only used for was-zero decisions). */
  vault = new Map<number, bigint>();
  /** Simulated debt shares > 0 per asset index. */
  hasDebt = new Set<number>();
  readonly allowedTokens: Set<number> | undefined;

  constructor(raw: MarginAccountRaw | null, snapshot?: MarginSnapshot, allowedTokenIndexes?: number[]) {
    const allowed = raw?.allowedTokenIndexes ?? allowedTokenIndexes;
    this.allowedTokens = allowed ? new Set(allowed) : undefined;
    this.collateral = raw ? [...raw.collateralAssetIndexes] : [...(allowed ?? []), ...new Array(24).fill(EMPTY_ASSET_INDEX)];
    this.debt = raw ? [...raw.debtAssetIndexes] : new Array(24).fill(EMPTY_ASSET_INDEX);
    for (const c of snapshot?.collateral ?? []) this.vault.set(c.assetIndex, c.amountRaw);
    for (const d of snapshot?.debts ?? []) if (d.borrowShares > 0n) this.hasDebt.add(d.assetIndex);
    for (const i of this.debt) if (i !== EMPTY_ASSET_INDEX) this.hasDebt.add(i);
  }

  private add(list: number[], index: number) {
    if (list.includes(index)) return;
    const slot = list.indexOf(EMPTY_ASSET_INDEX);
    if (slot === -1) throw new Error("Margin account already holds the maximum number of active assets");
    list[slot] = index;
  }

  /**
   * Token collateral: the program scans the protocol's allowed-token list, never a per-margin token
   * slot, so a token outside that list must not take a slot (the trailing slots are venues).
   */
  private addToken(index: number) {
    if (this.allowedTokens && !this.allowedTokens.has(index)) return;
    this.add(this.collateral, index);
  }

  private remove(list: number[], index: number) {
    if (list === this.collateral && this.allowedTokens?.has(index)) return;
    const slot = list.indexOf(index);
    if (slot !== -1) list[slot] = EMPTY_ASSET_INDEX;
  }

  /** `user_deposit_collateral`: activates the collateral when the vault was empty. */
  deposit(index: number, amount: bigint) {
    const before = this.vault.get(index) ?? 0n;
    if (before === 0n) this.addToken(index);
    this.vault.set(index, before + amount);
  }

  /** `user_borrow`: activates the debt; activates collateral when the vault was empty. */
  borrow(index: number, amount: bigint, collateralEnabled: boolean) {
    const before = this.vault.get(index) ?? 0n;
    this.hasDebt.add(index);
    this.add(this.debt, index);
    this.vault.set(index, before + amount);
    if (before === 0n && collateralEnabled && !this.collateral.includes(index)) this.addToken(index);
  }

  /** `user_withdraw_collateral`: deactivates the collateral when the vault reaches zero. */
  withdraw(index: number, amount: bigint) {
    const after = (this.vault.get(index) ?? 0n) - amount;
    this.vault.set(index, after > 0n ? after : 0n);
    if (after <= 0n) this.remove(this.collateral, index);
  }

  /**
   * `margin_execute`: a drained spent vault leaves the collateral list, a newly funded received
   * vault joins it (`exec.rs::update_active_assets`).
   */
  execute(spentIndex: number, spent: bigint, receivedIndex: number, received: bigint) {
    const spentAfter = (this.vault.get(spentIndex) ?? 0n) - spent;
    this.vault.set(spentIndex, spentAfter > 0n ? spentAfter : 0n);
    if (spentAfter <= 0n) this.remove(this.collateral, spentIndex);
    const receivedBefore = this.vault.get(receivedIndex) ?? 0n;
    this.vault.set(receivedIndex, receivedBefore + received);
    if (received > 0n) this.addToken(receivedIndex);
  }

  /**
   * `margin_execute` at a venue: a call the validator marks `opens_venue` (a deposit into Phoenix,
   * an order) puts the venue on the collateral list; once the venue holds nothing (`closes`: the
   * whole Phoenix balance withdrawn, no position left) it leaves.
   */
  venueCall(venueIndex: number, opens: boolean, closes = false) {
    if (opens) this.add(this.collateral, venueIndex);
    if (closes) this.remove(this.collateral, venueIndex);
  }

  /** Repay that fully clears the debt (and, from margin, may empty the vault). */
  repay(index: number, clearsDebt: boolean, vaultAfter?: bigint) {
    if (clearsDebt) {
      this.hasDebt.delete(index);
      this.remove(this.debt, index);
    }
    if (vaultAfter !== undefined) {
      this.vault.set(index, vaultAfter);
      if (vaultAfter === 0n) this.remove(this.collateral, index);
    }
  }
}

const readonlyMeta = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });

/** The venue part of a scan when the margin holds (or a call targets) the Phoenix venue. */
export interface VenueScan {
  venue: PhoenixVenueContext;
  /** Markets to value on top of the open ones (a call's target market). */
  extraAssetIds?: number[];
  /** A call AT the venue: the program values the venue even before it is on the collateral list. */
  always?: boolean;
}

/**
 * Builds a health-checked instruction's `remaining_accounts` as the guide's "Position accounts in
 * remaining_accounts" (port of `scripts/src/devnet-positions.ts::buildRemainingAccounts`):
 *   1. collateral groups in the margin's SLOT order (skip 65535), minus `exclude`:
 *      `[asset_config, margin vault]`, or `[asset_config, margin]` for the Phoenix venue;
 *   2. debt groups `[asset_config, reserve, debt_position]`, minus `exclude.debt`;
 *   3. `extraGroups` (caller-supplied extra groups; margin_execute no longer takes `new_assets`, so
 *      current callers pass none);
 *   4. the oracle segment `[vanna_oracle, price_book, ...]`: the price accounts of EVERY active
 *      position (excluded ones too) and of `priced`, each once; with Phoenix also the market book,
 *      exchange, perp asset map, the trader, USDC price accounts and each open (+ extra) market's
 *      orderbook and index price accounts.
 */
export function buildHealthRemainingAccounts(
  margin: PublicKey,
  model: { collateral: number[]; debt: number[]; vault?: Map<number, bigint> },
  assetMap: Map<number, AssetConfigState>,
  exclude: { collateral?: number[]; debt?: number } = {},
  priced: AssetConfigState[] = [],
  opts: { venue?: VenueScan; writable?: PublicKey[]; extraGroups?: AccountMeta[] } = {},
): AccountMeta[] {
  const metas: AccountMeta[] = [];
  const oracles: PublicKey[] = priced.flatMap((a) => a.oracleAccounts);
  const skipCol = new Set(exclude.collateral ?? []);
  const writable = new Set((opts.writable ?? []).map((k) => k.toBase58()));
  const meta = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: writable.has(pubkey.toBase58()) });
  let holdsVenue = false;
  for (const index of model.collateral) {
    if (index === EMPTY_ASSET_INDEX) continue;
    const asset = assetMap.get(index);
    if (!asset) throw new Error(`Active collateral asset index ${index} has no AssetConfig on-chain`);
    if (asset.kind === "venue") {
      holdsVenue = true;
      if (!skipCol.has(index)) metas.push(meta(asset.address), meta(margin));
      continue;
    }
    // The core skips pricing zero balances. Keep every required token group, but
    // do not load large venue/oracle accounts for tokens this account does not hold.
    // Newly received assets are explicitly included in `priced` by the caller.
    if (!model.vault || (model.vault.get(index) ?? 0n) > 0n) oracles.push(...asset.oracleAccounts);
    if (skipCol.has(index)) continue;
    metas.push(meta(asset.address), meta(marginVault(margin, asset.mint, asset.tokenProgram)));
  }
  for (const index of model.debt) {
    if (index === EMPTY_ASSET_INDEX) continue;
    const asset = assetMap.get(index);
    if (!asset) throw new Error(`Active debt asset index ${index} has no AssetConfig on-chain`);
    oracles.push(...asset.oracleAccounts);
    if (index === exclude.debt) continue;
    const reserve = reservePda(asset.mint);
    metas.push(meta(asset.address), meta(reserve), meta(debtPositionPda(margin, reserve)));
  }
  metas.push(...(opts.extraGroups ?? []));
  if (holdsVenue || opts.venue?.always) {
    if (!opts.venue) throw new Error("This margin account holds Phoenix positions — refresh and try again");
    oracles.push(...venueOracleAccounts(margin, opts.venue.venue, opts.venue.extraAssetIds ?? []));
  }
  metas.push(readonlyMeta(ORACLE_PROGRAM_ID), readonlyMeta(priceBookPda()));
  const seen = new Set<string>([ORACLE_PROGRAM_ID.toBase58(), priceBookPda().toBase58()]);
  for (const key of oracles) {
    const id = key.toBase58();
    if (seen.has(id)) continue;
    seen.add(id);
    metas.push(readonlyMeta(key));
  }
  return metas;
}

// ---------------------------------------------------------------------------------------------
// Instruction builders
// ---------------------------------------------------------------------------------------------

export function assetFor(assetMap: Map<number, AssetConfigState>, token: TokenInfo): AssetConfigState {
  for (const a of assetMap.values()) if (a.mint.equals(token.mint)) return a;
  throw new Error(`${token.symbol} is not registered with the protocol`);
}

export async function createMarginIx(owner: PublicKey): Promise<TransactionInstruction> {
  return getProgram()
    .methods.userCreateMargin()
    .accountsStrict({ authority: owner, payer: owner, marginAccount: marginPda(owner), systemProgram: SystemProgram.programId } as any)
    .instruction();
}

export async function depositIx(owner: PublicKey, token: TokenInfo, amount: bigint, source: PublicKey): Promise<TransactionInstruction> {
  const margin = marginPda(owner);
  return getProgram()
    .methods.userDepositCollateral(new BN(amount.toString()))
    .accountsStrict({
      authority: owner,
      protocolConfig: protocolConfigPda(),
      marginAccount: margin,
      assetConfig: assetConfigPda(token.mint),
      mint: token.mint,
      sourceTokenAccount: source,
      marginVault: marginVault(margin, token.mint, token.tokenProgram),
      tokenProgram: token.tokenProgram,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as any)
    .instruction();
}

export async function borrowIx(
  owner: PublicKey,
  asset: AssetConfigState,
  token: TokenInfo,
  amount: bigint,
  maxDebtShares: bigint,
  remaining: AccountMeta[],
): Promise<TransactionInstruction> {
  const margin = marginPda(owner);
  const reserve = reservePda(token.mint);
  return getProgram()
    .methods.userBorrow(new BN(amount.toString()), new BN(maxDebtShares.toString()))
    .accountsStrict({
      authority: owner,
      protocolConfig: protocolConfigPda(),
      marginAccount: margin,
      assetConfig: asset.address,
      reserve,
      debtPosition: debtPositionPda(margin, reserve),
      mint: token.mint,
      reserveVault: reserveVault(token.mint, token.tokenProgram),
      marginVault: marginVault(margin, token.mint, token.tokenProgram),
      tokenProgram: token.tokenProgram,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as any)
    .remainingAccounts(remaining)
    .instruction();
}

export async function repayFromMarginIx(owner: PublicKey, token: TokenInfo, maxAssets: bigint, repayAll: boolean) {
  const margin = marginPda(owner);
  const reserve = reservePda(token.mint);
  return getProgram()
    .methods.userRepayFromMargin(new BN(maxAssets.toString()), repayAll)
    .accountsStrict({
      authority: owner,
      marginAccount: margin,
      assetConfig: assetConfigPda(token.mint),
      reserve,
      debtPosition: debtPositionPda(margin, reserve),
      mint: token.mint,
      marginVault: marginVault(margin, token.mint, token.tokenProgram),
      reserveVault: reserveVault(token.mint, token.tokenProgram),
      tokenProgram: token.tokenProgram,
    } as any)
    .instruction();
}

export async function withdrawIx(
  owner: PublicKey,
  asset: AssetConfigState,
  token: TokenInfo,
  amount: bigint,
  minHealthFactorWad: bigint,
  destination: PublicKey,
  remaining: AccountMeta[],
) {
  const margin = marginPda(owner);
  return getProgram()
    .methods.userWithdrawCollateral(new BN(amount.toString()), new BN(minHealthFactorWad.toString()))
    .accountsStrict({
      authority: owner,
      protocolConfig: protocolConfigPda(),
      marginAccount: margin,
      assetConfig: asset.address,
      mint: token.mint,
      destinationTokenAccount: destination,
      marginVault: marginVault(margin, token.mint, token.tokenProgram),
      tokenProgram: token.tokenProgram,
    } as any)
    .remainingAccounts(remaining)
    .instruction();
}

/**
 * `user_reclaim_rent`: closes an empty, inactive margin vault and/or a zero-share, inactive debt
 * position of one token, returning their rent to the owner. Pass at least one.
 */
export async function reclaimRentIx(owner: PublicKey, token: TokenInfo, close: { vault?: boolean; debt?: boolean }) {
  const margin = marginPda(owner);
  return getProgram()
    .methods.userReclaimRent()
    .accountsStrict({
      authority: owner,
      marginAccount: margin,
      assetConfig: assetConfigPda(token.mint),
      mint: token.mint,
      marginVault: close.vault ? marginVault(margin, token.mint, token.tokenProgram) : null,
      debtPosition: close.debt ? debtPositionPda(margin, reservePda(token.mint)) : null,
      tokenProgram: token.tokenProgram,
    } as any)
    .instruction();
}

// ---------------------------------------------------------------------------------------------
// Risk math for the UI (max borrow / leverage / withdraw), derived from the account-wide rule
// ---------------------------------------------------------------------------------------------

/**
 * Max additional USD that can be borrowed of an asset whose borrowed tokens count as collateral:
 * after borrowing B, HF = (C + B) / (D + B) >= h  ⇔  B <= (C − h·D) / (h − 1).
 * Uses {@link SAFE_HEALTH_FACTOR} by default so the strict on-chain `HF > 1.10` holds with margin.
 */
export function maxBorrowUsd(collateralUsd: number, debtUsd: number, targetHf = SAFE_HEALTH_FACTOR, borrowedCountsAsCollateral = true): number {
  if (borrowedCountsAsCollateral) return Math.max(0, (collateralUsd - targetHf * debtUsd) / (targetHf - 1));
  // Not collateral-enabled: HF = C / (D + B) >= h ⇔ B <= C/h − D.
  return Math.max(0, collateralUsd / targetHf - debtUsd);
}

/**
 * Max leverage for a fresh deposit of equity E (no existing positions): borrow B <= E / (h − 1),
 * so leverage = (E + B) / E <= h / (h − 1). With h = 1.15 → ~7.67x; at the raw 1.10 threshold 11x.
 */
export function maxLeverage(targetHf = SAFE_HEALTH_FACTOR): number {
  return targetHf / (targetHf - 1);
}

/**
 * Max leverage for adding equity E to an existing account (collateral C, debt D): the borrow B
 * satisfies (C + E + B) / (D + B) >= h, leverage on the new equity = 1 + B / E.
 */
export function maxLeverageFor(equityUsd: number, collateralUsd: number, debtUsd: number, targetHf = SAFE_HEALTH_FACTOR): number {
  if (equityUsd <= 0) return 1;
  const b = maxBorrowUsd(collateralUsd + equityUsd, debtUsd, targetHf, true);
  return 1 + b / equityUsd;
}

/** Projected HF after hypothetical USD changes (null = infinite). */
export function projectHealthFactor(collateralUsd: number, debtUsd: number): number | null {
  if (debtUsd <= 0) return null;
  return collateralUsd / debtUsd;
}

/**
 * Max USD of collateral that can be withdrawn while HF stays >= h: C − W >= h·D ⇔ W <= C − h·D.
 */
export function maxWithdrawUsd(collateralUsd: number, debtUsd: number, targetHf = SAFE_HEALTH_FACTOR): number {
  if (debtUsd <= 0) return collateralUsd;
  return Math.max(0, collateralUsd - targetHf * debtUsd);
}

export { LIQUIDATION_HEALTH_FACTOR, SAFE_HEALTH_FACTOR };

// ---------------------------------------------------------------------------------------------
// High-level actions
// ---------------------------------------------------------------------------------------------

export interface MarginTxResult {
  signature: string;
}

export interface AmountItem {
  symbol: string;
  /** UI units. */
  amount: string | number;
}

export interface BatchContext {
  owner: PublicKey;
  margin: PublicKey;
  snapshot: MarginSnapshot;
  assetMap: Map<number, AssetConfigState>;
  pools: Record<string, PoolState>;
  model: MarginIndexModel;
  /** The Phoenix venue, when the margin holds it (or a Phoenix call loads it). */
  venue: PhoenixVenueContext | null;
  instructions: TransactionInstruction[];
  suffix: TransactionInstruction[];
}

/** The venue part of this batch's health scans (undefined when Phoenix isn't involved). */
export function venueScan(ctx: BatchContext): VenueScan | undefined {
  return ctx.venue ? { venue: ctx.venue } : undefined;
}

export async function loadContext(owner: PublicKey): Promise<BatchContext> {
  const [snapshot, assetMap, pools] = await Promise.all([fetchMarginSnapshot(owner), fetchAllAssetConfigs(), fetchPoolStates()]);
  // A create + deposit + borrow batch must scan the global token list even
  // before the new margin account exists on-chain.
  const allowed = snapshot.raw ? undefined :
    ((await accounts().protocolConfig.fetch(protocolConfigPda())).allowedTokens as number[]).filter(i => i !== EMPTY_ASSET_INDEX);
  return {
    owner,
    margin: marginPda(owner),
    snapshot,
    assetMap,
    pools,
    model: new MarginIndexModel(snapshot.raw, snapshot, allowed),
    venue: snapshot.venue,
    instructions: [],
    suffix: [],
  };
}

export async function appendDeposits(ctx: BatchContext, deposits: AmountItem[]) {
  const balances = deposits.length ? await fetchWalletBalances(ctx.owner) : null;
  for (const item of deposits) {
    const token = getToken(item.symbol);
    const asset = assetFor(ctx.assetMap, token);
    if (!asset.collateralEnabled) throw new Error(`${token.symbol} is not enabled as collateral`);
    const amount = toRaw(item.amount, token.decimals);
    if (amount <= 0n) continue;
    const available = token.isNative ? spendableLamports(balances!.raw.SOL) : balances!.raw[token.symbol];
    if (amount > available) {
      throw new Error(`Insufficient ${token.symbol}: wallet has ${fromRaw(available, token.decimals)} available${token.isNative ? " after the SOL fee reserve" : ""}`);
    }
    let source = walletAta(ctx.owner, token.mint, token.tokenProgram);
    if (token.isNative) {
      const wrap = await wrapSolInstructions(ctx.owner, amount);
      ctx.instructions.push(...wrap.instructions);
      source = wrap.ata;
      if (!wrap.existed) ctx.suffix.push(createCloseAccountInstruction(wrap.ata, ctx.owner, ctx.owner));
    }
    ctx.instructions.push(await depositIx(ctx.owner, token, amount, source));
    ctx.model.deposit(asset.assetIndex, amount);
  }
}

export async function appendBorrows(ctx: BatchContext, borrows: AmountItem[]) {
  for (const item of borrows) {
    const token = getToken(item.symbol);
    // The app only lends out its Earn-pool tokens (SOL, USDC, USDT); staking tokens are collateral-only.
    if (!token.lendable) throw new Error(`${token.symbol} can't be borrowed — it is collateral-only`);
    const asset = assetFor(ctx.assetMap, token);
    if (!asset.borrowEnabled) throw new Error(`${token.symbol} is not enabled for borrowing`);
    const amount = toRaw(item.amount, token.decimals);
    if (amount <= 0n) continue;
    const pool = ctx.pools[token.symbol];
    if (!pool?.projected) throw new Error(`${token.symbol} lending pool is not initialised`);
    if (amount > pool.projected.accountedLiquidityAssets) {
      throw new Error(`The ${token.symbol} pool only has ${fromRaw(pool.projected.accountedLiquidityAssets, token.decimals)} ${token.symbol} available to borrow`);
    }
    // The first borrow of a token creates its debt position itself (no separate "open" call).
    // Bound debt shares at +0.5% over the projection (interest accrues between quote and landing
    // only in the borrower's favour for share count — more assets per share → fewer shares).
    const expectedShares = assetsToDebtSharesUp(amount, pool.projected.totalBorrowShares, pool.projected.totalBorrowAssets);
    const maxShares = expectedShares + expectedShares / 200n + 1n;
    // Exclude the asset's own collateral AND debt: user_borrow values both itself.
    const remaining = buildHealthRemainingAccounts(
      ctx.margin,
      ctx.model,
      ctx.assetMap,
      { collateral: [asset.assetIndex], debt: asset.assetIndex },
      [asset],
      { venue: venueScan(ctx) },
    );
    ctx.instructions.push(await borrowIx(ctx.owner, asset, token, amount, maxShares, remaining));
    ctx.model.borrow(asset.assetIndex, amount, asset.collateralEnabled);
  }
}

export async function send(ctx: BatchContext, label: string, opts: MarginServiceOptions, signer: TxSigner) {
  const all = [...ctx.instructions, ...ctx.suffix];
  if (all.length === 0) throw new Error("Nothing to do");
  return sendInstructions(all, {
    signer,
    label,
    computeUnits: BATCH_COMPUTE_UNITS,
    onStatus: opts.onStatus as never,
  });
}

/** `user_create_margin` — one margin account per wallet. */
export async function createMarginAccount(opts: MarginServiceOptions = {}): Promise<MarginTxResult & { address: string }> {
  const signer = opts.signer ?? getActiveSigner();
  const existing = await fetchMarginAccount(signer.publicKey);
  if (existing) return { signature: "", address: existing.address.toBase58() };
  const signature = await sendInstructions([await createMarginIx(signer.publicKey)], {
    signer,
    label: "Create margin account",
    onStatus: opts.onStatus as never,
  });
  return { signature, address: marginPda(signer.publicKey).toBase58() };
}

/**
 * THE margin write path: optionally create the account, deposit any number of assets from the
 * wallet, then borrow any number of assets (single / dual / cross-asset),
 * all in ONE transaction (600k CU). Prices are refreshed first when anything is borrowed.
 */
export async function depositAndBorrow(
  input: { deposits?: AmountItem[]; borrows?: AmountItem[]; createIfMissing?: boolean },
  opts: MarginServiceOptions = {},
): Promise<MarginTxResult> {
  const signer = opts.signer ?? getActiveSigner();
  const deposits = (input.deposits ?? []).filter((d) => Number(d.amount) > 0);
  const borrows = (input.borrows ?? []).filter((b) => Number(b.amount) > 0);
  if (!deposits.length && !borrows.length) throw new Error("Enter an amount greater than zero");
  if (borrows.length) {
    await ensureFreshPrices();
  }
  const ctx = await loadContext(signer.publicKey);
  if (!ctx.snapshot.exists) {
    if (!input.createIfMissing) throw new Error("Create a margin account first");
    ctx.instructions.push(await createMarginIx(signer.publicKey));
  }
  await appendDeposits(ctx, deposits);
  await appendBorrows(ctx, borrows);
  const parts = [
    deposits.length ? `Deposit ${deposits.map((d) => `${d.amount} ${canon(d.symbol)}`).join(" + ")}` : "",
    borrows.length ? `Borrow ${borrows.map((b) => `${b.amount} ${canon(b.symbol)}`).join(" + ")}` : "",
  ].filter(Boolean);
  return { signature: await send(ctx, parts.join(" & "), opts, signer) };
}

const canon = (s: string) => findToken(s)?.symbol ?? s;

/** Deposit collateral from the wallet (no borrow). */
export function depositCollateral(deposits: AmountItem[], opts: MarginServiceOptions = {}) {
  return depositAndBorrow({ deposits }, opts);
}

/** Borrow one or more assets against existing collateral (single / dual / cross-asset). */
export function borrow(borrows: AmountItem[], opts: MarginServiceOptions = {}) {
  return depositAndBorrow({ borrows }, opts);
}

export interface RepayRequest {
  symbol: string;
  /** UI amount; ignored when `all`. */
  amount?: string | number;
  /** Repay the entire accrued debt (`repay_all = true`). */
  all?: boolean;
  /**
   * "margin" = from the margin vault; "wallet" = the wallet's tokens are deposited into the margin
   * vault and repaid from it in the same transaction (repay always pays from the margin vault).
   */
  source: "margin" | "wallet";
  /** After a full repay, also close the (now empty) debt position to reclaim its rent. Default true. */
  closePosition?: boolean;
}

/** Headroom for a repay_all: covers interest accrued between quote and landing. */
const REPAY_ALL_BUFFER_BPS = 20n; // 0.2%

export async function repay(req: RepayRequest, opts: MarginServiceOptions = {}): Promise<MarginTxResult> {
  const signer = opts.signer ?? getActiveSigner();
  const owner = signer.publicKey;
  const token = getToken(req.symbol);
  const snapshot = await fetchMarginSnapshot(owner);
  if (!snapshot.exists) throw new Error("No margin account found");
  const debt = snapshot.debts.find((d) => d.symbol === token.symbol);
  if (!debt || debt.debtRaw === 0n) throw new Error(`No outstanding ${token.symbol} debt`);
  const requested = req.all ? debt.debtRaw : toRaw(req.amount ?? "0", token.decimals);
  if (requested <= 0n) throw new Error("Enter an amount greater than zero");
  const target = requested > debt.debtRaw ? debt.debtRaw : requested;
  const repayAll = Boolean(req.all) || target >= debt.debtRaw;
  const needed = repayAll ? target + (target * REPAY_ALL_BUFFER_BPS) / 10_000n + 1n : target;

  const instructions: TransactionInstruction[] = [];
  const suffix: TransactionInstruction[] = [];
  if (req.source === "margin") {
    const vault = snapshot.collateral.find((c) => c.symbol === token.symbol)?.amountRaw ?? 0n;
    if (vault < needed) {
      throw new Error(
        `Your margin account holds ${fromRaw(vault, token.decimals)} ${token.symbol}, less than the ${fromRaw(needed, token.decimals)} needed${repayAll ? " (debt + accrual buffer)" : ""}. Repay from wallet or deposit more ${token.symbol} first.`,
      );
    }
  } else {
    // user_deposit_collateral then user_repay_from_margin, in one transaction (the guide's wallet
    // repay). A repay_all's small accrual buffer stays in the margin account as collateral.
    const balances = await fetchWalletBalances(owner);
    let source = walletAta(owner, token.mint, token.tokenProgram);
    if (token.isNative) {
      const need = needed > balances.wsolRaw ? needed - balances.wsolRaw : 0n;
      if (need > spendableLamports(balances.raw.SOL)) throw new Error(`Insufficient SOL in wallet to repay ${fromRaw(needed, 9)} SOL`);
      const wrap = await wrapSolInstructions(owner, need);
      instructions.push(...wrap.instructions);
      source = wrap.ata;
      if (!wrap.existed) suffix.push(createCloseAccountInstruction(wrap.ata, owner, owner));
    } else if ((balances.raw[token.symbol] ?? 0n) < needed) {
      throw new Error(`Insufficient ${token.symbol} in wallet: need ${fromRaw(needed, token.decimals)}`);
    }
    instructions.push(await depositIx(owner, token, needed, source));
  }
  instructions.push(await repayFromMarginIx(owner, token, target, repayAll));
  if (repayAll && req.closePosition !== false) instructions.push(await reclaimRentIx(owner, token, { debt: true }));
  const signature = await sendInstructions([...instructions, ...suffix], {
    signer,
    label: `Repay ${repayAll ? "all " : ""}${token.symbol}`,
    computeUnits: BATCH_COMPUTE_UNITS,
    onStatus: opts.onStatus as never,
  });
  return { signature };
}

export interface WithdrawRequest {
  symbol: string;
  amount?: string | number;
  /** Withdraw the whole vault balance (only allowed when HF stays healthy). */
  all?: boolean;
  /** Optional floor for the post-withdraw HF (WAD). 0 = only the protocol's 1.10 rule. */
  minHealthFactorWad?: bigint;
}

/** `user_withdraw_collateral` to the wallet (SOL is unwrapped). Refreshes prices first. */
export async function withdrawCollateral(req: WithdrawRequest, opts: MarginServiceOptions = {}): Promise<MarginTxResult> {
  const signer = opts.signer ?? getActiveSigner();
  const owner = signer.publicKey;
  const token = getToken(req.symbol);
  await ensureFreshPrices();
  const ctx = await loadContext(owner);
  if (!ctx.snapshot.exists) throw new Error("No margin account found");
  const asset = assetFor(ctx.assetMap, token);
  const position = ctx.snapshot.collateral.find((c) => c.symbol === token.symbol);
  const held = position?.amountRaw ?? 0n;
  const amount = req.all ? held : toRaw(req.amount ?? "0", token.decimals);
  if (amount <= 0n) throw new Error("Enter an amount greater than zero");
  if (amount > held) throw new Error(`Your margin account only holds ${fromRaw(held, token.decimals)} ${token.symbol}`);

  let destination = walletAta(owner, token.mint, token.tokenProgram);
  if (token.isNative) {
    const temp = await temporaryWsolReceiver(owner);
    ctx.instructions.push(...temp.setup);
    ctx.suffix.push(...temp.cleanup);
    destination = temp.account;
  } else {
    ctx.instructions.push(createAssociatedTokenAccountIdempotentInstruction(owner, destination, owner, token.mint, token.tokenProgram));
  }
  // Exclude this asset's collateral: user_withdraw_collateral values the projected vault itself.
  // No debt → no health check and no remaining accounts (the guide's user_withdraw_collateral).
  const remaining =
    ctx.model.debt.some((i) => i !== EMPTY_ASSET_INDEX)
      ? buildHealthRemainingAccounts(ctx.margin, ctx.model, ctx.assetMap, { collateral: [asset.assetIndex] }, [asset], { venue: venueScan(ctx) })
      : [];
  ctx.instructions.push(await withdrawIx(owner, asset, token, amount, req.minHealthFactorWad ?? 0n, destination, remaining));
  return { signature: await send(ctx, `Withdraw ${fromRaw(amount, token.decimals)} ${token.symbol}`, opts, signer) };
}

/** Close an empty, inactive collateral vault (reclaims its rent). */
export async function closeCollateralPosition(symbol: string, opts: MarginServiceOptions = {}): Promise<MarginTxResult> {
  const signer = opts.signer ?? getActiveSigner();
  const token = getToken(symbol);
  const signature = await sendInstructions([await reclaimRentIx(signer.publicKey, token, { vault: true })], {
    signer,
    label: `Close ${token.symbol} collateral position`,
    onStatus: opts.onStatus as never,
  });
  return { signature };
}

/** Close an empty debt position (reclaims its rent). */
export async function closeDebtPosition(symbol: string, opts: MarginServiceOptions = {}): Promise<MarginTxResult> {
  const signer = opts.signer ?? getActiveSigner();
  const token = getToken(symbol);
  const signature = await sendInstructions([await reclaimRentIx(signer.publicKey, token, { debt: true })], {
    signer,
    label: `Close ${token.symbol} debt position`,
    onStatus: opts.onStatus as never,
  });
  return { signature };
}

/** JSON-safe snapshot for API routes / React Query. */
export function serializeMarginSnapshot(s: MarginSnapshot) {
  return {
    owner: s.owner,
    exists: s.exists,
    address: s.address,
    forkTimestamp: Number(s.now),
    collateral: s.collateral.map((c) => ({
      symbol: c.symbol,
      assetIndex: c.assetIndex,
      mint: c.mint.toBase58(),
      amountRaw: c.amountRaw.toString(),
      amount: c.amount,
      usd: c.usd,
      active: c.active,
    })),
    debts: s.debts.map((d) => ({
      symbol: d.symbol,
      assetIndex: d.assetIndex,
      mint: d.mint.toBase58(),
      borrowShares: d.borrowShares.toString(),
      debtRaw: d.debtRaw.toString(),
      debt: d.debt,
      usd: d.usd,
      borrowApr: d.borrowApr,
    })),
    openDebtPositions: s.openDebtPositions,
    totalCollateralUsd: s.totalCollateralUsd,
    totalDebtUsd: s.totalDebtUsd,
    healthFactor: s.healthFactor,
    prices: Object.fromEntries(Object.entries(s.prices).map(([k, p]) => [k, p ? { usd: p.usd, publishTime: Number(p.publishTime) } : null])),
    stalePrices: s.stalePrices,
    collateralAssetIndexes: s.raw?.collateralAssetIndexes ?? [],
    debtAssetIndexes: s.raw?.debtAssetIndexes ?? [],
  };
}
export type SerializedMarginSnapshot = ReturnType<typeof serializeMarginSnapshot>;
