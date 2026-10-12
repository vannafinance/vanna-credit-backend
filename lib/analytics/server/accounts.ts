/**
 * Batch margin-account reader.
 *
 * Collateral model of the CURRENT program (verified against the on-chain program source and the
 * site's own reader): a margin account does NOT register collateral per token. The program values
 * every token in the protocol's `allowed_tokens` list that the account's vault holds, plus the
 * account's active VENUES (`venue_asset_indexes`, e.g. Phoenix). Debt is still tracked per account
 * (`debt_asset_indexes`).
 *
 * The existing `fetchMarginSnapshot(owner)` is right for ONE account. Running it for every account
 * would repeat the same shared reads N times, so here the shared state is read ONCE per refresh and
 * each account costs only what is unique to it:
 *
 *   shared (once):   asset configs + price book · allowed-token list · pools · oracle accounts · clock
 *   phase 1 (batch): the margin accounts                         → venues + debt indexes
 *   phase 2 (batch): 8-byte vault balances (dataSlice) of the allowed tokens + debt positions
 *
 * Which vaults exist is learned once per account and remembered, so a steady-state pass only re-reads
 * vaults that exist (a periodic full probe catches new ones). All reads are `getMultipleAccounts`
 * chunks (the fork rejects JSON-RPC batching) with a small pause between chunks.
 *
 * Valuation uses the same math and rounding as `margin.ts` (collateral rounds down, debt rounds up)
 * so rows match `fetchMarginSnapshot` - `scripts/analytics-parity.ts` checks that live.
 */
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { forkUnixTimestamp, getConnection, getMultipleAccountsChunked } from "@/lib/solana/connection";
import { accounts, getProgram, big } from "@/lib/solana/program";
import { debtPositionPda, marginPda, marginVault, protocolConfigPda, reservePda } from "@/lib/solana/pdas";
import { fetchAllAssetConfigs, fetchPoolStates, type AssetConfigState, type PoolState } from "@/lib/solana/protocol-state";
import { priceFromAccounts, type OraclePrice } from "@/lib/solana/oracle";
import { readReserveRate, receiptByMint, underlyingForReceipts, type ReserveRate } from "@/lib/solana/kamino";
import { BALANCE_TO_BORROW_THRESHOLD_WAD, debtSharesToAssetsUp, healthFactorWad, normalizeTokenValue, projectReserve, rawToNumber, WAD } from "@/lib/solana/math";
import { loadPhoenixVenue } from "@/lib/solana/phoenix-state";
import { PHUSD_MINT } from "@/lib/solana/phoenix";
import { tokenByMint } from "@/lib/solana/tokens";
import { vaultByMint } from "@/lib/solana/vault-catalogue";
import { basisOraclePrice } from "@/lib/solana/vault-oracles";
import { EMPTY_ASSET_INDEX } from "@/lib/solana/margin";
import { classify, derivedFigures } from "../risk";
import type { AccountRow, CollateralLine, DebtLine, IncompleteReason } from "../types";

const NANO = 1_000_000_000;
/** Token-account balance lives at bytes 64..72 (same layout for Token and Token-2022). */
const AMOUNT_SLICE = { offset: 64, length: 8 } as const;
const CHUNK = 100;
const CHUNK_PAUSE_MS = 120;
/** How long a remembered "which vaults exist" answer is trusted before a full probe. */
const PROBE_TTL_MS = 15 * 60_000;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SharedContext {
  /** Fork clock (unix seconds). */
  now: bigint;
  assets: Map<number, AssetConfigState>;
  /** Token assets the program values as collateral (the protocol's allowed-token list). */
  collateralAssets: AssetConfigState[];
  pools: Record<string, PoolState>;
  prices: Map<number, OraclePrice | null>;
  receiptRates: Map<number, ReserveRate>;
  receiptErrors: Set<number>;
  venueAssetIndex: number | null;
}

/** Everything that is the same for every account, read once. */
export async function loadSharedContext(): Promise<SharedContext> {
  const connection = getConnection();
  const [assets, pools, now, protocol] = await Promise.all([
    fetchAllAssetConfigs(connection), fetchPoolStates(connection), forkUnixTimestamp(connection),
    accounts().protocolConfig.fetch(protocolConfigPda()),
  ]);
  const allowed = new Set((protocol.allowedTokens as number[]).map(Number).filter((i) => i !== EMPTY_ASSET_INDEX));
  const tokenAssets = [...assets.values()].filter((a) => a.kind === "token");
  const isBasis = (a: AssetConfigState) => vaultByMint(a.mint.toBase58())?.kind === "basis";
  const keys = [...new Map(tokenAssets.filter((a) => !isBasis(a)).flatMap((a) => a.oracleAccounts).map((k) => [k.toBase58(), k])).values()];
  const infos = await getMultipleAccountsChunked(connection, keys);
  const oracleMap = new Map(keys.map((k, i) => [k.toBase58(), infos[i] as AccountInfo<Buffer> | null]));
  const prices = new Map<number, OraclePrice | null>();
  const receiptRates = new Map<number, ReserveRate>();
  const receiptErrors = new Set<number>();
  for (const a of tokenAssets) {
    // Basis vault shares are priced by the oracle program itself (a simulated read), only when someone holds them.
    prices.set(a.assetIndex, isBasis(a) ? null : priceFromAccounts(a.oracle, oracleMap, now));
    if (a.priceSource === "kaminoReceipt") {
      const info = oracleMap.get(a.priceSourceAccount.toBase58());
      try {
        if (!info) throw new Error("missing reserve");
        receiptRates.set(a.assetIndex, readReserveRate(info.data, a.mint));
      } catch {
        receiptErrors.add(a.assetIndex); // an unexpected layout fails closed, like the program
      }
    }
  }
  const venue = [...assets.values()].find((a) => a.kind === "venue");
  return {
    now, assets, pools, prices, receiptRates, receiptErrors, venueAssetIndex: venue?.assetIndex ?? null,
    collateralAssets: tokenAssets.filter((a) => allowed.has(a.assetIndex)),
  };
}

const symbolOf = (a: AssetConfigState) =>
  tokenByMint(a.mint)?.symbol ?? receiptByMint(a.mint)?.symbol ?? vaultByMint(a.mint.toBase58())?.symbol ?? (a.mint.equals(PHUSD_MINT) ? "phUSD" : a.mint.toBase58().slice(0, 6));
/** The registry symbol a line is priced off (a Kamino receipt or vault share → its underlying). */
const underlyingOf = (a: AssetConfigState) => receiptByMint(a.mint)?.underlying ?? vaultByMint(a.mint.toBase58())?.asset ?? symbolOf(a);
const kindOf = (a: AssetConfigState): CollateralLine["kind"] =>
  a.priceSource === "kaminoReceipt" || vaultByMint(a.mint.toBase58()) ? "receipt" : a.mint.equals(PHUSD_MINT) ? "venue" : "direct";

const valueOf = (amount: bigint, price: OraclePrice | null, decimals: number, roundUp: boolean): bigint =>
  !price || price.price <= 0n ? 0n : normalizeTokenValue(amount, price.price, price.exponent, decimals, roundUp);

interface DecodedMargin {
  address: PublicKey;
  owner: PublicKey;
  venueIndexes: number[];
  debtIndexes: number[];
}

/** Which collateral vaults exist for an account (learned by a full probe, then remembered). */
const KNOWN_VAULTS = new Map<string, { at: number; indexes: number[] }>();

/** For persistence: which vaults each account was last found to hold (so a restart does not re-probe them all). */
export const exportKnownVaults = (): Record<string, number[]> => Object.fromEntries([...KNOWN_VAULTS].map(([k, v]) => [k, v.indexes]));
export function importKnownVaults(saved: Record<string, number[]>, at: number): void {
  for (const [k, indexes] of Object.entries(saved)) if (!KNOWN_VAULTS.has(k)) KNOWN_VAULTS.set(k, { at, indexes });
}
export const knownVaultCount = () => KNOWN_VAULTS.size;

/** Balances (raw) of the given vault accounts, 8 bytes each. Missing/closed accounts are 0. */
async function readVaultAmounts(keys: PublicKey[], owners: PublicKey[]): Promise<bigint[]> {
  const connection = getConnection();
  const out: bigint[] = [];
  for (let i = 0; i < keys.length; i += CHUNK) {
    const slice = keys.slice(i, i + CHUNK);
    const infos = await connection.getMultipleAccountsInfo(slice, { commitment: "confirmed", dataSlice: AMOUNT_SLICE });
    infos.forEach((info, j) => out.push(info && info.owner.equals(owners[i + j]) && info.data.length >= 8 ? Buffer.from(info.data).readBigUInt64LE(0) : 0n));
    if (i + CHUNK < keys.length) await pause(CHUNK_PAUSE_MS);
  }
  return out;
}

/** Reads and values a set of margin accounts. `margins` are verified margin PDAs. */
export async function readAccountRows(ctx: SharedContext, margins: Array<{ address: string; owner: string }>): Promise<AccountRow[]> {
  if (!margins.length) return [];
  const connection = getConnection();
  const coder = getProgram().coder;
  const readAt = Date.now();

  // ---- phase 1: the margin accounts ----------------------------------------------------------
  const marginKeys = margins.map((m) => new PublicKey(m.address));
  const marginInfos = await getMultipleAccountsChunked(connection, marginKeys);
  const decoded: Array<DecodedMargin | null> = marginInfos.map((info, i) => {
    if (!info) return null;
    const raw = coder.accounts.decode("marginAccount", info.data);
    const active = (list: unknown) => (list as number[]).map(Number).filter((n) => n !== EMPTY_ASSET_INDEX);
    return { address: marginKeys[i], owner: raw.authority as PublicKey, venueIndexes: active(raw.venueAssetIndexes), debtIndexes: active(raw.debtAssetIndexes) };
  });

  // ---- phase 2a: collateral vault balances ------------------------------------------------------
  const amountsBy = new Map<string, Map<number, bigint>>(); // margin → asset index → raw amount
  const probeKeys: PublicKey[] = [], probeOwners: PublicKey[] = [], probeOf: Array<{ margin: string; index: number }> = [];
  for (const m of decoded) {
    if (!m) continue;
    const addr = m.address.toBase58();
    const known = KNOWN_VAULTS.get(addr);
    const fresh = known && Date.now() - known.at < PROBE_TTL_MS;
    for (const a of ctx.collateralAssets) {
      if (fresh && !known!.indexes.includes(a.assetIndex)) continue;
      probeKeys.push(marginVault(m.address, a.mint, a.tokenProgram)); probeOwners.push(a.tokenProgram); probeOf.push({ margin: addr, index: a.assetIndex });
    }
  }
  const amounts = await readVaultAmounts(probeKeys, probeOwners);
  const probedFully = new Set<string>();
  probeOf.forEach((p, i) => {
    const m = amountsBy.get(p.margin) ?? new Map<number, bigint>();
    if (amounts[i] > 0n) m.set(p.index, amounts[i]);
    amountsBy.set(p.margin, m);
  });
  for (const m of decoded) {
    if (!m) continue;
    const addr = m.address.toBase58();
    const known = KNOWN_VAULTS.get(addr);
    if (!known || Date.now() - known.at >= PROBE_TTL_MS) probedFully.add(addr);
  }
  // Remember which vaults hold something (a fully probed account's answer; others keep theirs plus anything new).
  for (const addr of probedFully) KNOWN_VAULTS.set(addr, { at: Date.now(), indexes: [...(amountsBy.get(addr)?.keys() ?? [])] });

  // ---- phase 2b: debt positions -------------------------------------------------------------------
  const debtKeys: PublicKey[] = [];
  for (const m of decoded) for (const i of m?.debtIndexes ?? []) { const a = ctx.assets.get(i); if (a) debtKeys.push(debtPositionPda(m!.address, reservePda(a.mint))); }
  const debtInfos = debtKeys.length ? await getMultipleAccountsChunked(connection, debtKeys) : [];
  const debtByKey = new Map(debtKeys.map((k, i) => [k.toBase58(), debtInfos[i] as AccountInfo<Buffer> | null]));

  // Vault shares priced by the oracle program: one read per share type that someone actually holds.
  const prices = new Map(ctx.prices);
  const heldBasis = new Set<number>();
  for (const held of amountsBy.values()) for (const index of held.keys()) { const a = ctx.assets.get(index); if (a && vaultByMint(a.mint.toBase58())?.kind === "basis") heldBasis.add(index); }
  await Promise.all([...heldBasis].map(async (index) => {
    const def = vaultByMint(ctx.assets.get(index)!.mint.toBase58())!;
    try { prices.set(index, await basisOraclePrice(def, connection)); } catch { prices.set(index, null); }
  }));

  // Phoenix venue: loaded only for accounts that hold it, a few at a time.
  const venueByMargin = new Map<string, Awaited<ReturnType<typeof loadPhoenixVenue>> | "error">();
  const venueHolders = decoded.filter((m): m is DecodedMargin => !!m && ctx.venueAssetIndex !== null && m.venueIndexes.includes(ctx.venueAssetIndex));
  for (let i = 0; i < venueHolders.length; i += 3) {
    await Promise.all(venueHolders.slice(i, i + 3).map(async (m) => {
      try { venueByMargin.set(m.address.toBase58(), await loadPhoenixVenue(connection, m.address, ctx.now)); }
      catch { venueByMargin.set(m.address.toBase58(), "error"); }
    }));
  }

  // ---- values ----------------------------------------------------------------------------------
  return margins.map((m, n): AccountRow => {
    const d = decoded[n];
    const base = { owner: m.owner, address: m.address, readAt };
    const empty = { collateral: [] as CollateralLine[], debts: [] as DebtLine[], composition: { direct: 0, receipt: 0, venue: 0 }, venueHeld: false };
    if (!d) {
      return { ...base, ...empty, status: "incomplete", valued: false, reasons: [{ code: "unknown_asset", assetIndexes: [] }], collateralUsd: null, debtUsd: null, equityUsd: null, healthFactor: null, leverage: null, bufferPct: null, bufferUsd: null, liquidatable: false };
    }
    const reasons: IncompleteReason[] = [];
    const stale = new Set<string>(), missing = new Set<string>(), unreadableReceipts = new Set<string>(), unknown: number[] = [];
    const collateral: CollateralLine[] = [];
    const debts: DebtLine[] = [];
    let collateralNano = 0n, debtNano = 0n;
    let venueHeld = false;
    const held = amountsBy.get(d.address.toBase58()) ?? new Map<number, bigint>();

    // Allowed tokens the vault holds.
    for (const [i, raw] of held) {
      const a = ctx.assets.get(i)!;
      const symbol = symbolOf(a);
      const price = prices.get(i) ?? null;
      if (!price) { missing.add(symbol); continue; }
      if (!price.fresh) stale.add(symbol);
      let valueNano: bigint;
      if (a.priceSource === "kaminoReceipt") {
        const rate = ctx.receiptRates.get(i);
        if (!rate) { unreadableReceipts.add(symbol); continue; }
        valueNano = valueOf(underlyingForReceipts(rate, raw), price, rate.liquidityDecimals, false);
      } else {
        valueNano = valueOf(raw, price, a.decimals, false);
      }
      collateralNano += valueNano;
      collateral.push({ symbol, mint: a.mint.toBase58(), assetIndex: i, kind: kindOf(a), underlying: underlyingOf(a), amount: rawToNumber(raw, a.decimals), usd: Number(valueNano) / NANO });
    }

    // Active venues (Phoenix).
    for (const i of d.venueIndexes) {
      const a = ctx.assets.get(i);
      if (!a) { unknown.push(i); continue; }
      if (a.kind !== "venue") continue; // a token index in the venue list carries nothing of its own
      venueHeld = true;
      const venue = venueByMargin.get(d.address.toBase58());
      if (!venue || venue === "error") { reasons.push({ code: "venue_unreadable" }); continue; }
      collateralNano += venue.valueNano;
      collateral.push({ symbol: "Phoenix", mint: a.mint.toBase58(), assetIndex: i, kind: "venue", underlying: "Phoenix", amount: 0, usd: Number(venue.valueNano) / NANO });
    }

    // Debt.
    for (const i of d.debtIndexes) {
      const a = ctx.assets.get(i);
      if (!a || a.kind !== "token") { unknown.push(i); continue; }
      const symbol = symbolOf(a);
      const info = debtByKey.get(debtPositionPda(d.address, reservePda(a.mint)).toBase58());
      if (!info) { unknown.push(i); continue; }
      const shares = big(coder.accounts.decode("debtPosition", info.data).borrowShares);
      if (shares === 0n) continue;
      const pool = tokenByMint(a.mint) ? ctx.pools[tokenByMint(a.mint)!.symbol] : undefined;
      if (!pool?.reserve) { unknown.push(i); continue; }
      const price = prices.get(i) ?? null;
      if (!price) { missing.add(symbol); continue; }
      if (!price.fresh) stale.add(symbol);
      const projected = projectReserve(pool.reserve, ctx.now);
      const debtRaw = debtSharesToAssetsUp(shares, projected.totalBorrowShares, projected.totalBorrowAssets);
      const valueNano = valueOf(debtRaw, price, a.decimals, true);
      debtNano += valueNano;
      debts.push({ symbol, mint: a.mint.toBase58(), assetIndex: i, amount: rawToNumber(debtRaw, a.decimals), usd: Number(valueNano) / NANO, borrowApr: pool.borrowApr });
    }

    if (missing.size) reasons.push({ code: "missing_price", symbols: [...missing] });
    if (unreadableReceipts.size) reasons.push({ code: "receipt_unreadable", symbols: [...unreadableReceipts] });
    if (unknown.length) reasons.push({ code: "unknown_asset", assetIndexes: [...new Set(unknown)] });

    const composition = { direct: 0, receipt: 0, venue: 0 };
    for (const l of collateral) composition[l.kind] += l.usd;
    const valued = reasons.length === 0;
    if (!valued) {
      return { ...base, status: "incomplete", valued: false, reasons, collateralUsd: null, debtUsd: null, equityUsd: null, healthFactor: null, leverage: null, bufferPct: null, bufferUsd: null,
        liquidatable: false, collateral, debts, composition, venueHeld, stalePrices: [...stale] };
    }
    const hfWad = healthFactorWad(collateralNano, debtNano);
    const liquidatable = hfWad !== null && hfWad <= BALANCE_TO_BORROW_THRESHOLD_WAD;
    const collateralUsd = Number(collateralNano) / NANO, debtUsd = Number(debtNano) / NANO;
    const figures = derivedFigures(collateralUsd, debtUsd);
    const healthFactor = hfWad === null ? null : Number((hfWad * 1_000_000n) / WAD) / 1e6;
    return {
      ...base, valued, reasons, collateralUsd, debtUsd, equityUsd: figures.equityUsd, healthFactor, leverage: figures.leverage,
      bufferPct: figures.bufferPct, bufferUsd: figures.bufferUsd, liquidatable, collateral, debts, composition, venueHeld, stalePrices: [...stale],
      status: classify({ valued, collateralUsd, debtUsd, healthFactor, liquidatable }),
    };
  });
}

/** Convenience for the parity script and manual lookups. */
export async function readOneAccountRow(owner: PublicKey): Promise<AccountRow> {
  const ctx = await loadSharedContext();
  const [row] = await readAccountRows(ctx, [{ address: marginPda(owner).toBase58(), owner: owner.toBase58() }]);
  return row;
}
