// Server-side only, FORK ONLY (the guide's "fork-only helpers" — never port to production).
//
// Phoenix gates trading: a freshly registered trader may only place orders; depositing and
// withdrawing collateral need capabilities Phoenix's delegated authority grants (its onboarding).
// On mainnet Vanna needs Phoenix to grant them to its margin traders; on the fork
// `grantPhoenixCapabilitiesOnFork` stands in for that grant.
//
// A Phoenix open (Ember wrap + deposit + market order) is three `margin_execute`s naming 70+
// accounts. Production keeps one protocol lookup table; on the fork `ensurePerpsLookupTable` writes
// a table per margin (protocol, Phoenix and price accounts + the margin's own) straight into the
// fork, so each step stays one wallet transaction. Phoenix fills market orders on-chain inside the
// transaction, so (unlike GMTrade) no keeper stands in for anything.
import { Buffer } from "buffer";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ComputeBudgetProgram, Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import { JUPITER_V6_PROGRAM_ID, ORACLE_PROGRAM_ID, SOLANA_RPC_URL, VALIDATOR_PROGRAM_ID, VANNA_PROGRAM_ID } from "../config";
import { forkFetch } from "../connection";
import { debtPositionPda, integrationPda, marginPda, marginVault, priceBookPda, protocolConfigPda, reservePda, reserveVault } from "../pdas";
import { fetchAllAssetConfigs } from "../protocol-state";
import { oracleAccounts } from "../oracle";
import { KAMINO_RECEIPTS, KLEND_PROGRAM_ID } from "../kamino";
import { TOKENS } from "../tokens";
import {
  decodeTrader,
  FULL_TRADER_CAPABILITIES,
  TRADER_FLAGS_OFFSET,
  decodeMarketBook,
  fetchPerpAssetMap,
  EMBER_PROGRAM_ID,
  PHOENIX_EXCHANGE,
  PHOENIX_LOG_AUTHORITY,
  PHOENIX_PROGRAM_ID,
  phoenixMarketBook,
  phoenixTraderPda,
  readPhoenixExchange,
} from "../phoenix";
import { TITAN_PROGRAM_ID } from "../titan";
import { callCheatcode } from "./cheatcodes";

const ADDRESS_LOOKUP_TABLE_PROGRAM = new PublicKey("AddressLookupTab1e1111111111111111111111111");

/** Every account a margin's Phoenix (and other margin) transactions name, protocol-wide ones first. */
async function lookupTableAddresses(connection: Connection, owner: PublicKey): Promise<PublicKey[]> {
  const margin = marginPda(owner);
  const [assetMap, bookInfo] = await Promise.all([fetchAllAssetConfigs(connection), connection.getAccountInfo(phoenixMarketBook())]);
  const assets = [...assetMap.values()];
  const keys: PublicKey[] = [
    VANNA_PROGRAM_ID,
    ORACLE_PROGRAM_ID,
    VALIDATOR_PROGRAM_ID,
    PHOENIX_PROGRAM_ID,
    EMBER_PROGRAM_ID,
    KLEND_PROGRAM_ID,
    JUPITER_V6_PROGRAM_ID,
    TITAN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    SystemProgram.programId,
    ComputeBudgetProgram.programId,
    protocolConfigPda(),
    priceBookPda(),
    ...[PHOENIX_PROGRAM_ID, EMBER_PROGRAM_ID, KLEND_PROGRAM_ID, JUPITER_V6_PROGRAM_ID, TITAN_PROGRAM_ID].map((p) => integrationPda(p)),
    ...assets.flatMap((a) => [a.address, ...a.oracleAccounts]),
    ...assets.filter((a) => a.kind === "token").map((a) => a.mint),
    margin,
  ];
  if (bookInfo) {
    const book = decodeMarketBook(Buffer.from(bookInfo.data));
    const ex = await readPhoenixExchange(connection);
    const splines = await fetchPerpAssetMap(connection, ex.perpAssetMap);
    keys.push(
      book.address,
      PHOENIX_EXCHANGE,
      PHOENIX_LOG_AUTHORITY,
      ex.canonicalMint,
      ex.globalVault,
      ex.perpAssetMap,
      ex.withdrawQueue,
      ex.emberState,
      ex.emberVault,
      ...ex.traderIndex,
      ...ex.activeBuffer,
      phoenixTraderPda(margin),
      marginVault(margin, ex.canonicalMint, TOKEN_PROGRAM_ID),
      ...oracleAccounts(book.collateralPrice),
    );
    for (const m of book.markets) {
      keys.push(m.market, ...oracleAccounts(m.indexPrice));
      const spline = splines.find((s) => s.orderbook.equals(m.market))?.spline;
      if (spline) keys.push(spline);
    }
  }
  for (const t of TOKENS) {
    keys.push(marginVault(margin, t.mint, t.tokenProgram));
    if (t.lendable) keys.push(reservePda(t.mint), reserveVault(t.mint, t.tokenProgram), debtPositionPda(margin, reservePda(t.mint)));
  }
  for (const r of KAMINO_RECEIPTS) keys.push(marginVault(margin, r.collateralMint, TOKEN_PROGRAM_ID));
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
/** A margin's table is rewritten at most this often (its accounts only change when assets do). */
const TABLE_TTL_MS = 120_000;
const tableWrittenAt = new Map<string, number>();

export async function ensurePerpsLookupTable(owner: PublicKey, rpcUrl: string = SOLANA_RPC_URL): Promise<PublicKey> {
  const address = await perpsLookupTableAddress(owner);
  if (Date.now() - (tableWrittenAt.get(address.toBase58()) ?? 0) < TABLE_TTL_MS) return address;
  const connection = new Connection(rpcUrl, { commitment: "confirmed", fetch: forkFetch });
  const addresses = await lookupTableAddresses(connection, owner);
  const data = Buffer.alloc(56 + 32 * addresses.length);
  data.writeUInt32LE(1, 0);
  data.writeBigUInt64LE(0xffffffffffffffffn, 4);
  data.writeBigUInt64LE(0n, 12);
  data[20] = Math.min(255, addresses.length);
  addresses.forEach((a, i) => a.toBuffer().copy(data, 56 + 32 * i));
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
  tableWrittenAt.set(address.toBase58(), Date.now());
  return address;
}

/**
 * Fork only: gives the margin's (already registered) Phoenix trader the capabilities an onboarded
 * mainnet trader has (deposit / withdraw collateral, place orders), keeping its hot bit. Returns
 * false when the trader doesn't exist yet (the wallet registers it first).
 */
export async function grantPhoenixCapabilitiesOnFork(owner: PublicKey, rpcUrl: string = SOLANA_RPC_URL): Promise<boolean> {
  const connection = new Connection(rpcUrl, { commitment: "confirmed", fetch: forkFetch });
  const trader = phoenixTraderPda(marginPda(owner));
  const info = await connection.getAccountInfo(trader);
  if (!info || info.data.length < TRADER_FLAGS_OFFSET + 4 || !info.owner.equals(PHOENIX_PROGRAM_ID)) return false;
  const data = Buffer.from(info.data);
  if ((decodeTrader(data).capabilities & FULL_TRADER_CAPABILITIES) === FULL_TRADER_CAPABILITIES) return true;
  data.writeUInt32LE(data.readUInt32LE(TRADER_FLAGS_OFFSET) | FULL_TRADER_CAPABILITIES, TRADER_FLAGS_OFFSET);
  await callCheatcode("surfnet_setAccount", [
    trader.toBase58(),
    { lamports: info.lamports, data: data.toString("hex"), owner: PHOENIX_PROGRAM_ID.toBase58(), executable: false, rentEpoch: 0 },
  ]);
  return true;
}

/**
 * Fork only: copies Phoenix's shared state from mainnet as ONE consistent snapshot (one
 * `getMultipleAccounts` = one slot): the exchange, the perp asset map, the trader-index and
 * active-trader arenas, and each Vanna-listed market's orderbook and spline. Surfpool clones each
 * account lazily at a different moment, so resting orders can point at maker nodes the cloned
 * arenas don't have ("Failed to lookup trader at index NodePointer(n)"). Phoenix traders registered
 * on the fork before a resync lose their arena node, so run it only before any Vanna margin holds
 * a Phoenix position (scripts/fork-phoenix-resync.ts). Token accounts (vaults) are left alone.
 */
export async function resyncPhoenixOnFork(rpcUrl: string = SOLANA_RPC_URL, mainnetUrl = process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com"): Promise<string[]> {
  const fork = new Connection(rpcUrl, { commitment: "confirmed", fetch: forkFetch });
  const mainnet = new Connection(mainnetUrl, "confirmed");
  const bookInfo = await fork.getAccountInfo(phoenixMarketBook());
  if (!bookInfo) throw new Error("No Phoenix market book on the fork");
  const book = decodeMarketBook(Buffer.from(bookInfo.data));
  const ex = await readPhoenixExchange(mainnet);
  const splines = await fetchPerpAssetMap(mainnet, ex.perpAssetMap);
  const keys = [
    PHOENIX_EXCHANGE,
    ex.perpAssetMap,
    ...ex.traderIndex,
    ...ex.activeBuffer,
    ...book.markets.map((m) => m.market),
    ...book.markets.flatMap((m) => splines.filter((s) => s.orderbook.equals(m.market)).map((s) => s.spline)),
  ];
  const infos = await mainnet.getMultipleAccountsInfo(keys, "confirmed");
  const written: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    const info = infos[i];
    if (!info || !info.owner.equals(PHOENIX_PROGRAM_ID)) continue;
    await callCheatcode("surfnet_setAccount", [
      keys[i].toBase58(),
      { lamports: info.lamports, data: Buffer.from(info.data).toString("hex"), owner: PHOENIX_PROGRAM_ID.toBase58(), executable: false, rentEpoch: 0 },
    ]);
    written.push(keys[i].toBase58());
  }
  return written;
}

/**
 * Fork only: makes the fork re-clone one Vanna-listed market's orderbook and spline from its upstream
 * mainnet RPC (`surfnet_resetAccount`, ~1 s) right before a trade. Nobody re-quotes on a fork, so
 * the cloned book goes stale (makers' resting orders expire) and market orders stop filling. The
 * arenas are left as they are, so Vanna's registered traders keep their nodes. `market` is the
 * Phoenix symbol ("SOL", "TSLA", …). Uploading the 1.2 MB book ourselves took ~11 s per trade.
 */
/** A market's book is re-cloned at most this often (trades seconds apart reuse it). */
const BOOK_REFRESH_MIN_MS = 10_000;
const lastBookRefresh = new Map<string, number>();

export async function refreshPhoenixBookOnFork(market: string, rpcUrl: string = SOLANA_RPC_URL): Promise<number> {
  const key = market.toUpperCase();
  if (Date.now() - (lastBookRefresh.get(key) ?? 0) < BOOK_REFRESH_MIN_MS) return 0;
  lastBookRefresh.set(key, Date.now());
  const fork = new Connection(rpcUrl, { commitment: "confirmed", fetch: forkFetch });
  const bookInfo = await fork.getAccountInfo(phoenixMarketBook());
  if (!bookInfo) return 0;
  const listed = decodeMarketBook(Buffer.from(bookInfo.data)).markets.map((m) => m.market.toBase58());
  const ex = await readPhoenixExchange(fork);
  const m = (await fetchPerpAssetMap(fork, ex.perpAssetMap)).find((x) => x.symbol === key && listed.includes(x.orderbook.toBase58()));
  if (!m) return 0;
  await Promise.all([m.orderbook, m.spline].map((k) => callCheatcode("surfnet_resetAccount", [k.toBase58()])));
  return 2;
}
