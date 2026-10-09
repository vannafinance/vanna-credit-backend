import { Buffer } from "buffer";
import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";
import {
  fetchVault,
  vaultProgram,
  type VaultInfo,
} from "@vanna/phoenix-vault-client";
import { getConnection } from "./connection";
import { ORACLE_PROGRAM_ID } from "./config";
import { priceBookPda } from "./pdas";
import {
  decodeMarketBook,
  PHOENIX_EXCHANGE,
  phoenixMarketBook,
  readPhoenixExchange,
} from "./phoenix";
import { oracleAccounts, type OraclePrice } from "./oracle";
import { singleFlight } from "../async";
import { type VaultDefinition, BASIS_PROGRAM } from "./vault-catalogue";

export const VIEW_PAYER = new PublicKey(
  "B7rDiCsL9DAWcd144RxPAiryc6AfVMHmq5n6KtiRmU8R",
);
const staticReads = singleFlight<
  string,
  { vault: VaultInfo; accounts: PublicKey[] }
>();
const staticCache = new Map<
  string,
  { at: number; value: { vault: VaultInfo; accounts: PublicKey[] } }
>();
/** Account membership only is cached; balances and prices are always read fresh. */
export function basisOracleAccounts(
  def: VaultDefinition,
  conn: Connection = getConnection(),
) {
  const key = `${conn.rpcEndpoint}:${def.id}`;
  return staticReads(key, async () => {
    const cached = staticCache.get(key);
    if (cached && Date.now() - cached.at < 300_000) return cached.value;
    const info = await conn.getAccountInfo(new PublicKey(def.account));
    if (!info || !info.owner.equals(new PublicKey(BASIS_PROGRAM)))
      throw new Error(`${def.name} is not deployed on this network`);
    const [vault, exchange, bookInfo] = await Promise.all([
      fetchVault(vaultProgram(conn), new PublicKey(def.assetMint!)),
      readPhoenixExchange(conn),
      conn.getAccountInfo(phoenixMarketBook()),
    ]);
    if (!vault.shareMint.equals(new PublicKey(def.mint)))
      throw new Error("Basis share mint mismatch");
    if (!bookInfo) throw new Error("Phoenix oracle market book is missing");
    const book = decodeMarketBook(bookInfo.data);
    const entry = book.markets.find((e) => e.assetId === vault.assetId);
    if (!entry)
      throw new Error(
        `${def.asset} is not registered in the Phoenix oracle market book`,
      );
    const accounts = [
      vault.address,
      vault.shareMint,
      vault.traderAccount,
      ...(vault.assetAccount ? [vault.assetAccount] : []),
      phoenixMarketBook(),
      PHOENIX_EXCHANGE,
      exchange.perpAssetMap,
      ...oracleAccounts(book.collateralPrice),
      entry.market,
      ...oracleAccounts(entry.indexPrice),
    ];
    const value = { vault, accounts };
    staticCache.set(key, { at: Date.now(), value });
    return value;
  });
}

const oracleReads = singleFlight<string, OraclePrice>();
/** Conservative Vanna collateral price, not Phoenix's optimistic displayed NAV. */
export function basisOraclePrice(
  def: VaultDefinition,
  conn: Connection = getConnection(),
): Promise<OraclePrice> {
  return oracleReads(`${conn.rpcEndpoint}:${def.id}`, async () => {
    const { accounts } = await basisOracleAccounts(def, conn);
    const query = Buffer.alloc(4 + 32 + 8 + 1 + 32);
    query.writeUInt32LE(1);
    new PublicKey(def.mint).toBuffer().copy(query, 4);
    query.writeBigUInt64LE(1_000_000n, 36);
    const unique = [
      ...new Map(
        [priceBookPda(), ...accounts].map((k) => [k.toBase58(), k]),
      ).values(),
    ];
    const ix = new TransactionInstruction({
      programId: ORACLE_PROGRAM_ID,
      keys: unique.map((pubkey) => ({
        pubkey,
        isSigner: false,
        isWritable: false,
      })),
      data: Buffer.concat([
        Buffer.from([238, 38, 193, 106, 228, 32, 210, 33]),
        query,
      ]),
    });
    const tx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: VIEW_PAYER,
        recentBlockhash: (await conn.getLatestBlockhash()).blockhash,
        instructions: [ix],
      }).compileToV0Message(),
    );
    const result = await conn.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
    });
    if (
      result.value.err ||
      result.value.returnData?.programId !== ORACLE_PROGRAM_ID.toBase58()
    )
      throw new Error(`${def.name} collateral valuation is unavailable`);
    const data = Buffer.alloc(38);
    Buffer.from(result.value.returnData.data[0], "base64").copy(data);
    if (data.readUInt32LE(0) !== 1)
      throw new Error("Invalid oracle result count");
    const value = data.readBigUInt64LE(20) + (data.readBigUInt64LE(28) << 64n);
    return {
      price: value,
      usd: Number(value) / 1e9,
      exponent: -9,
      conf: 0n,
      publishTime: BigInt(Math.floor(Date.now() / 1000)),
      source: "receipt",
      fresh: (data[36] & 7) === 7,
    };
  });
}
