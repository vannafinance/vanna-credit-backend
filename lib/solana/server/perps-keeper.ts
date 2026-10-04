// Server-side only, FORK ONLY (the guide's "fork-only helpers" — never port to production).
//
//  - GMTrade's keepers fill every order a few seconds after it is created. They don't run on a
//    Surfpool fork, so `fillPendingOrders` stands in for them, exactly like the scripts'
//    `gmtrade-simulate-fill`: at the on-chain index price, the position account is rewritten, the
//    order and its escrow are closed, and a decrease's output (collateral + PnL) is paid to the
//    venue account's USDC ATA. Settling it back to the margin stays the wallet's `public_venue_settle`.
//  - A GMTrade `margin_execute` names 50+ accounts. The guide keeps "one protocol lookup table" in
//    production; on the fork `ensurePerpsLookupTable` writes a table per margin (protocol accounts +
//    the margin's own) straight into the fork, so each step stays one wallet transaction.
import { Buffer } from "buffer";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ComputeBudgetProgram, Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import { JUPITER_V6_PROGRAM_ID, ORACLE_PROGRAM_ID, SOLANA_RPC_URL, VALIDATOR_PROGRAM_ID, VANNA_PROGRAM_ID } from "../config";
import { forkUnixTimestamp, forkFetch } from "../connection";
import { debtPositionPda, integrationPda, marginPda, marginVault, priceBookPda, protocolConfigPda, reservePda, reserveVault } from "../pdas";
import { fetchAllAssetConfigs } from "../protocol-state";
import { oracleAccounts } from "../oracle";
import { fetchMarginAccount, legsOf } from "../margin";
import { KAMINO_RECEIPTS, KLEND_PROGRAM_ID } from "../kamino";
import { TOKENS } from "../tokens";
import {
  encodeGmPosition,
  gmEscrow,
  gmOrderPda,
  gmPositionPda,
  gmUserPda,
  GMTRADE_EVENT_AUTHORITY,
  GMTRADE_PROGRAM_ID,
  GMTRADE_STORE,
  GMTRADE_STORE_WALLET,
  marketBook,
  MARKET_INCREASE,
  venueAccountOf,
  venueOracleAccounts,
  type GmPosition,
} from "../perps-accounts";
import { fetchMarketBook, readVenueState } from "../perps-state";
import { callCheatcode } from "./cheatcodes";

const ADDRESS_LOOKUP_TABLE_PROGRAM = new PublicKey("AddressLookupTab1e1111111111111111111111111");

/** Every account a margin's GMTrade (and other margin) transactions name, protocol-wide ones first. */
async function lookupTableAddresses(connection: Connection, owner: PublicKey): Promise<PublicKey[]> {
  const margin = marginPda(owner);
  const venueAccount = venueAccountOf(margin);
  const [book, assetMap] = await Promise.all([fetchMarketBook(connection), fetchAllAssetConfigs(connection)]);
  const assets = [...assetMap.values()];
  const keys: PublicKey[] = [
    VANNA_PROGRAM_ID,
    ORACLE_PROGRAM_ID,
    VALIDATOR_PROGRAM_ID,
    GMTRADE_PROGRAM_ID,
    KLEND_PROGRAM_ID,
    JUPITER_V6_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    SystemProgram.programId,
    ComputeBudgetProgram.programId,
    protocolConfigPda(),
    priceBookPda(),
    marketBook(),
    GMTRADE_STORE,
    GMTRADE_STORE_WALLET,
    GMTRADE_EVENT_AUTHORITY,
    ...[GMTRADE_PROGRAM_ID, KLEND_PROGRAM_ID, JUPITER_V6_PROGRAM_ID].map((p) => integrationPda(p)),
    ...assets.flatMap((a) => [a.address, ...a.oracleAccounts]),
    ...assets.filter((a) => a.kind === "token").map((a) => a.mint),
    margin,
    venueAccount,
    gmUserPda(venueAccount),
  ];
  for (const t of TOKENS) {
    keys.push(marginVault(margin, t.mint, t.tokenProgram));
    if (t.lendable) keys.push(reservePda(t.mint), reserveVault(t.mint, t.tokenProgram), debtPositionPda(margin, reservePda(t.mint)));
  }
  for (const r of KAMINO_RECEIPTS) keys.push(marginVault(margin, r.collateralMint, TOKEN_PROGRAM_ID));
  if (book) keys.push(...oracleAccounts(book.collateralPrice), ...venueOracleAccounts(venueAccount, book, (1n << BigInt(book.markets.length)) - 1n));
  return [...new Map(keys.map((k) => [k.toBase58(), k])).values()].slice(0, 256);
}

/** The margin's lookup table address (deterministic, owned by the lookup-table program). */
export function perpsLookupTableAddress(owner: PublicKey): Promise<PublicKey> {
  return PublicKey.createWithSeed(marginPda(owner), "vanna-perps-lookup", ADDRESS_LOOKUP_TABLE_PROGRAM);
}

/**
 * Writes (or rewrites) the margin's lookup table. LookupTableMeta (56 bytes): u32 state (1 = table)
 * | deactivation_slot (u64::MAX = active) | last_extended_slot | last_extended_slot_start_index |
 * authority (none) | padding; then the 32-byte addresses. A start index past every address keeps
 * them all usable in any slot.
 */
export async function ensurePerpsLookupTable(owner: PublicKey, rpcUrl: string = SOLANA_RPC_URL): Promise<PublicKey> {
  const connection = new Connection(rpcUrl, { commitment: "confirmed", fetch: forkFetch });
  const addresses = await lookupTableAddresses(connection, owner);
  const data = Buffer.alloc(56 + 32 * addresses.length);
  data.writeUInt32LE(1, 0);
  data.writeBigUInt64LE(0xffffffffffffffffn, 4);
  data.writeBigUInt64LE(0n, 12);
  data[20] = Math.min(255, addresses.length);
  addresses.forEach((a, i) => a.toBuffer().copy(data, 56 + 32 * i));
  const address = await perpsLookupTableAddress(owner);
  await callCheatcode("surfnet_setAccount", [
    address.toBase58(),
    {
      lamports: await connection.getMinimumBalanceForRentExemption(data.length),
      data: data.toString("hex"),
      owner: ADDRESS_LOOKUP_TABLE_PROGRAM.toBase58(),
      executable: false,
      rentEpoch: 0,
    },
  ]);
  return address;
}

export interface KeeperFill {
  market: string;
  side: "long" | "short";
  kind: "increase" | "decrease";
  price: number;
  sizeUsd: number;
  /** USDC paid to the venue account by a decrease. */
  payoutUsdc: number;
}

/** Fills every pending order of `owner`'s venue account at the current on-chain index price. */
export async function fillPendingOrders(owner: PublicKey, rpcUrl: string = SOLANA_RPC_URL): Promise<KeeperFill[]> {
  const connection = new Connection(rpcUrl, { commitment: "confirmed", fetch: forkFetch });
  const [raw, book, now, assets] = await Promise.all([fetchMarginAccount(owner), fetchMarketBook(connection), forkUnixTimestamp(connection), fetchAllAssetConfigs(connection)]);
  if (!raw || !book) return [];
  const venueAsset = [...assets.values()].find((a) => a.kind === "venue");
  const state = await readVenueState(connection, marginPda(owner), book, venueAsset ? legsOf(raw, venueAsset.assetIndex) : 0n, now);
  const collateral = book.collateralMint;
  const venueAccount = state.venueAccount;
  let idle = state.idleRaw;
  const fills: KeeperFill[] = [];
  for (const m of state.markets) {
    const index = m.indexPrice;
    if (!index || !m.market) continue;
    for (const order of m.orders) {
      if (!order) continue;
      const isLong = order.isLong;
      const positionKey = gmPositionPda(venueAccount, m.entry.marketToken, collateral, isLong);
      const positionInfo = await connection.getAccountInfo(positionKey);
      if (!positionInfo) continue; // prepare_position never ran: nothing to fill into
      const side = isLong ? 0 : 1;
      const p: GmPosition = m.positions[side]?.raw ?? { sizeInTokens: 0n, collateralAmount: 0n, sizeInUsd: 0n, borrowingFactor: 0n, fundingFeeAmountPerSize: 0n };
      // USD (1e20) per smallest index unit at the oracle's index price.
      const unitPrice = (index.usd * 1e20) / 10 ** m.entry.indexDecimals;
      let next: GmPosition;
      let payout = 0n;
      if (order.raw.kind === MARKET_INCREASE) {
        next = {
          sizeInTokens: p.sizeInTokens + BigInt(Math.floor(Number(order.raw.sizeDeltaValue) / unitPrice)),
          collateralAmount: p.collateralAmount + order.escrowedRaw,
          sizeInUsd: p.sizeInUsd + order.raw.sizeDeltaValue,
          borrowingFactor: m.market.borrowingFactor[side],
          fundingFeeAmountPerSize: m.market.fundingPerSize[side][m.market.longToken.equals(collateral) ? 0 : 1],
        };
      } else {
        const closed = order.raw.sizeDeltaValue >= p.sizeInUsd ? p.sizeInUsd : order.raw.sizeDeltaValue;
        if (closed === 0n) continue;
        const tokens = BigInt(Math.floor(Number(p.sizeInTokens) * (Number(closed) / Number(p.sizeInUsd))));
        const pnl = ((Number(tokens) * unitPrice - Number(closed)) / 1e20) * (isLong ? 1 : -1);
        const full = closed === p.sizeInUsd;
        const released = full ? p.collateralAmount : order.raw.initialCollateralDeltaAmount;
        payout = BigInt(Math.max(0, Math.floor(Number(released) + pnl * 10 ** book.collateralDecimals)));
        next = {
          sizeInTokens: full ? 0n : p.sizeInTokens - tokens,
          collateralAmount: full ? 0n : p.collateralAmount - released,
          sizeInUsd: p.sizeInUsd - closed,
          borrowingFactor: p.borrowingFactor,
          fundingFeeAmountPerSize: p.fundingFeeAmountPerSize,
        };
      }
      await callCheatcode("surfnet_setAccount", [
        positionKey.toBase58(),
        { lamports: positionInfo.lamports, data: encodeGmPosition(Buffer.from(positionInfo.data), next).toString("hex"), owner: GMTRADE_PROGRAM_ID.toBase58(), executable: false, rentEpoch: 0 },
      ]);
      const orderKey = gmOrderPda(venueAccount, m.entry.leg, isLong);
      for (const account of [orderKey, gmEscrow(orderKey, collateral)]) {
        await callCheatcode("surfnet_setAccount", [account.toBase58(), { lamports: 0, data: "", owner: SystemProgram.programId.toBase58(), executable: false, rentEpoch: 0 }]);
      }
      if (payout > 0n) {
        idle += payout;
        await callCheatcode("surfnet_setTokenAccount", [venueAccount.toBase58(), collateral.toBase58(), { amount: Number(idle) }, TOKEN_PROGRAM_ID.toBase58()]);
      }
      fills.push({
        market: m.entry.meta?.key ?? m.entry.market.toBase58(),
        side: isLong ? "long" : "short",
        kind: order.increase ? "increase" : "decrease",
        price: index.usd,
        sizeUsd: order.sizeUsd,
        payoutUsdc: Number(payout) / 10 ** book.collateralDecimals,
      });
    }
  }
  return fills;
}


