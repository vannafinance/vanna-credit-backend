/* eslint-disable @typescript-eslint/no-explicit-any */
import { AccountLayout, MintLayout } from "@solana/spl-token";
import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import { getConnection, forkUnixTimestamp, getMultipleAccountsChunked } from "./connection";
import { accounts, big, getProgram } from "./program";
import { assetConfigPda, feedIdToHex, priceFeedAccount, reservePda, shareMintPda } from "./pdas";
import { TOKENS, type TokenInfo } from "./tokens";
import { KAMINO_RECEIPTS } from "./kamino";
import {
  annualBorrowRate,
  annualSupplyRate,
  availableLenderCash,
  lenderTotalAssets,
  projectReserve,
  rawToNumber,
  utilizationWad,
  WAD,
  type ReserveMathState,
} from "./math";

/** Decoded AssetConfig, bigint/primitive-normalised. */
export interface AssetConfigState {
  address: PublicKey;
  mint: PublicKey;
  tokenProgram: PublicKey;
  reserve: PublicKey;
  priceFeedIdHex: string;
  /** PriceUpdateV2 account the program reads for this asset. */
  priceUpdate: PublicKey;
  maxCollateralPerMargin: bigint;
  maxPriceAgeSecs: number;
  maxConfidenceBps: number;
  liquidationBonusBps: number;
  assetIndex: number;
  decimals: number;
  collateralEnabled: boolean;
  borrowEnabled: boolean;
  /** "pyth" | "kaminoReceipt" */
  priceSource: string;
  priceSourceAccount: PublicKey;
}

export interface ReserveState extends ReserveMathState {
  address: PublicKey;
  underlyingMint: PublicKey;
  liquidityVault: PublicKey;
  shareMint: PublicKey;
  supplyCap: bigint;
  borrowCap: bigint;
  status: number;
}

/** Everything the Earn / Margin UI needs about one lending pool, projected to fork-now. */
export interface PoolState {
  token: TokenInfo;
  asset: AssetConfigState | null;
  /** Reserve as stored on-chain (null when the pool isn't initialised). */
  reserve: ReserveState | null;
  /** Reserve with interest accrued in memory to `now` (what the next instruction will see). */
  projected: ReserveState | null;
  shareSupply: bigint;
  /** Fork clock unix seconds used for the projection. */
  now: bigint;
  // Display numbers (UI units / fractions):
  totalSupplied: number;
  totalBorrowed: number;
  availableLiquidity: number;
  utilization: number;
  borrowApr: number;
  supplyApr: number;
  /** Underlying assets per 1 share (UI units per UI share; shares use the underlying's decimals). */
  exchangeRate: number;
  reserveFactor: number;
  supplyCapUi: number | null;
  borrowCapUi: number | null;
  statusLabel: string;
}

const STATUS_LABELS = ["Active", "Supply only", "Repay only", "Frozen"];

function normaliseAsset(address: PublicKey, a: any): AssetConfigState {
  const priceFeedIdHex = feedIdToHex(a.priceFeedId);
  return {
    address,
    mint: a.mint,
    tokenProgram: a.tokenProgram,
    reserve: a.reserve,
    priceFeedIdHex,
    priceUpdate: priceFeedAccount(priceFeedIdHex),
    maxCollateralPerMargin: big(a.maxCollateralPerMargin),
    maxPriceAgeSecs: Number(a.maxPriceAgeSecs),
    maxConfidenceBps: Number(a.maxConfidenceBps),
    liquidationBonusBps: Number(a.liquidationBonusBps),
    assetIndex: Number(a.assetIndex),
    decimals: Number(a.decimals),
    collateralEnabled: Boolean(a.collateralEnabled),
    borrowEnabled: Boolean(a.borrowEnabled),
    priceSource: Object.keys(a.priceSource ?? { pyth: {} })[0] ?? "pyth",
    priceSourceAccount: a.priceSourceAccount,
  };
}

function normaliseReserve(address: PublicKey, r: any): ReserveState {
  return {
    address,
    underlyingMint: r.underlyingMint,
    liquidityVault: r.liquidityVault,
    shareMint: r.shareMint,
    supplyCap: big(r.supplyCap),
    borrowCap: big(r.borrowCap),
    accountedLiquidityAssets: big(r.accountedLiquidityAssets),
    totalBorrowAssets: big(r.totalBorrowAssets),
    totalBorrowShares: big(r.totalBorrowShares),
    borrowIndexWad: big(r.borrowIndexWad),
    accruedProtocolFees: big(r.accruedProtocolFees),
    lastUpdateTimestamp: big(r.lastUpdateTimestamp),
    reserveFactorBps: BigInt(r.reserveFactorBps),
    status: Number(r.status),
    rateCurve: {
      linearCoeffWad: big(r.rateCurve.linearCoeffWad),
      jumpCoeffWad: big(r.rateCurve.jumpCoeffWad),
      rateMultiplierWad: big(r.rateCurve.rateMultiplierWad),
    },
  };
}

export function decodeAssetConfig(address: PublicKey, info: AccountInfo<Buffer> | null): AssetConfigState | null {
  if (!info) return null;
  return normaliseAsset(address, getProgram().coder.accounts.decode("assetConfig", info.data));
}

export function decodeReserve(address: PublicKey, info: AccountInfo<Buffer> | null): ReserveState | null {
  if (!info) return null;
  return normaliseReserve(address, getProgram().coder.accounts.decode("reserve", info.data));
}

/**
 * Every AssetConfig this app knows about — the registry tokens plus their Kamino receipt
 * (cToken) assets — keyed by asset_index, read by PDA in one batched `getMultipleAccounts`.
 *
 * Deliberately NOT `getProgramAccounts`: the hosted Surfpool fork forwards that call to its
 * upstream mainnet RPC, which rate-limits it (HTTP 429 → "Internal error"). Every asset the
 * protocol registers for this app is in this known set; if a margin account ever had an active
 * index outside it, `buildHealthRemainingAccounts` throws a clear error (and the program would
 * reject an incomplete scan anyway), so this fails closed rather than hiding a position.
 */
export async function fetchAllAssetConfigs(connection: Connection = getConnection()): Promise<Map<number, AssetConfigState>> {
  const mints = [...TOKENS.map((t) => t.mint), ...KAMINO_RECEIPTS.map((r) => r.collateralMint)];
  const addresses = mints.map((m) => assetConfigPda(m));
  const infos = await getMultipleAccountsChunked(connection, addresses);
  const map = new Map<number, AssetConfigState>();
  infos.forEach((info, i) => {
    const asset = decodeAssetConfig(addresses[i], info as AccountInfo<Buffer> | null);
    if (asset) map.set(asset.assetIndex, asset);
  });
  return map;
}

function buildPoolState(token: TokenInfo, asset: AssetConfigState | null, reserve: ReserveState | null, shareSupply: bigint, now: bigint): PoolState {
  const projected = reserve ? projectReserve(reserve, now) : null;
  const d = token.decimals;
  const util = projected ? utilizationWad(projected.accountedLiquidityAssets, projected.totalBorrowAssets) : 0n;
  const lenderTotal = projected ? lenderTotalAssets(projected) : 0n;
  return {
    token,
    asset,
    reserve,
    projected,
    shareSupply,
    now,
    totalSupplied: rawToNumber(lenderTotal, d),
    totalBorrowed: projected ? rawToNumber(projected.totalBorrowAssets, d) : 0,
    availableLiquidity: projected ? rawToNumber(availableLenderCash(projected), d) : 0,
    utilization: Number((util * 1_000_000n) / WAD) / 1e6,
    borrowApr: projected ? annualBorrowRate(projected.rateCurve, util) : 0,
    supplyApr: projected ? annualSupplyRate(projected.rateCurve, util, projected.reserveFactorBps) : 0,
    exchangeRate: shareSupply > 0n ? Number((lenderTotal * 1_000_000_000n) / shareSupply) / 1e9 : 1,
    reserveFactor: projected ? Number(projected.reserveFactorBps) / 10_000 : 0,
    supplyCapUi: reserve && reserve.supplyCap > 0n ? rawToNumber(reserve.supplyCap, d) : null,
    borrowCapUi: reserve && reserve.borrowCap > 0n ? rawToNumber(reserve.borrowCap, d) : null,
    statusLabel: reserve ? (STATUS_LABELS[reserve.status] ?? `Status ${reserve.status}`) : "Not initialised",
  };
}

/**
 * Reads every registry token's AssetConfig + Reserve + share mint and the fork clock in one
 * batched account read, and projects accrued interest to the fork's `now`.
 */
export async function fetchPoolStates(connection: Connection = getConnection()): Promise<Record<string, PoolState>> {
  const keys: PublicKey[] = [];
  for (const t of TOKENS) keys.push(assetConfigPda(t.mint), reservePda(t.mint), shareMintPda(t.mint));
  const [infos, now] = await Promise.all([getMultipleAccountsChunked(connection, keys), forkUnixTimestamp(connection)]);
  const out: Record<string, PoolState> = {};
  TOKENS.forEach((token, i) => {
    const assetInfo = infos[i * 3] as AccountInfo<Buffer> | null;
    const reserveInfo = infos[i * 3 + 1] as AccountInfo<Buffer> | null;
    const mintInfo = infos[i * 3 + 2] as AccountInfo<Buffer> | null;
    const asset = decodeAssetConfig(keys[i * 3], assetInfo);
    const reserve = decodeReserve(keys[i * 3 + 1], reserveInfo);
    const shareSupply = mintInfo ? MintLayout.decode(mintInfo.data.subarray(0, MintLayout.span)).supply : 0n;
    out[token.symbol] = buildPoolState(token, asset, reserve, shareSupply, now);
  });
  return out;
}

/** SPL token account amount from raw account info (0 when missing / wrong owner). */
export function tokenAccountAmount(info: AccountInfo<Buffer> | null, tokenProgram: PublicKey): bigint {
  if (!info || !info.owner.equals(tokenProgram) || info.data.length < AccountLayout.span) return 0n;
  return AccountLayout.decode(info.data.subarray(0, AccountLayout.span)).amount;
}

/** JSON-safe view of a PoolState for API routes. */
export function serializePoolState(p: PoolState) {
  return {
    symbol: p.token.symbol,
    mint: p.token.mint.toBase58(),
    decimals: p.token.decimals,
    reserve: p.reserve?.address.toBase58() ?? null,
    assetConfig: p.asset?.address.toBase58() ?? null,
    initialised: Boolean(p.reserve),
    collateralEnabled: p.asset?.collateralEnabled ?? false,
    borrowEnabled: p.asset?.borrowEnabled ?? false,
    totalSupplied: p.totalSupplied,
    totalBorrowed: p.totalBorrowed,
    availableLiquidity: p.availableLiquidity,
    utilization: p.utilization,
    borrowApr: p.borrowApr,
    supplyApr: p.supplyApr,
    exchangeRate: p.exchangeRate,
    reserveFactor: p.reserveFactor,
    supplyCap: p.supplyCapUi,
    borrowCap: p.borrowCapUi,
    status: p.statusLabel,
    shareSupply: p.shareSupply.toString(),
    forkTimestamp: Number(p.now),
  };
}
export type SerializedPoolState = ReturnType<typeof serializePoolState>;
