// Adapted from credit-layer/scripts/src/perena.ts (feature/phoenix-titan).
// The `buffer` package's Buffer (as in kamino.ts / phoenix.ts): the browser's global Buffer polyfill
// has no writeBigUInt64LE, which broke Perena deposits / withdrawals in the app.
import { Buffer } from "buffer";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  AccountMeta,
  Connection,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { marginVault as ata } from "./pdas";
import { getToken } from "./tokens";
const USDC_MINT = getToken("USDC").mint;

export const PERENA = new PublicKey(
  "save8RQVPMWNTzU18t3GBvBkN9hT7jsGjiCQ28FpD9H",
);
const VAULT = new PublicKey("ECJGrTZ6QYMEwiEAnL4oReWF126uc22e9Lojy9qyCjHT");
const VAULT_ORACLE = new PublicKey(
  "2YH9QB7qmEBgekeXH4C36L2dwMPfLdoPi5DDxeTi1kyP",
);
const TRANCHE_STATE = new PublicKey(
  "FbsiAonbNrC3EKWMrZxx9iSc5Q7e7zSAkro4tD8dQQJS",
);
const FEE_VAULT = new PublicKey("EAf7PeuCxhMN9gEhE1Gagmj28krmu3wEqCLMbqpSTVqg");

export const PERENA_SHARE_DECIMALS = 6;
const SHARE_PRICE_SCALE = 1_000_000n;
const JUNIOR = 0;

export type PerenaShareKey = "usdstar" | "usdstarj";

export interface PerenaShare {
  mint: PublicKey;
  account: PublicKey;
  priceAt: number;
  tranche: boolean;
}

export const PERENA_SHARES: Record<PerenaShareKey, PerenaShare> = {
  usdstar: {
    mint: new PublicKey("star9agSpjiFe3M49B3RniVU4CMBBEK3Qnaqn3RGiFM"),
    account: VAULT,
    priceAt: 1584,
    tranche: false,
  },
  usdstarj: {
    mint: new PublicKey("3AJYCjrhKitmBd8tRUurPA5dGHCAQh6A8L9DkuSC37Rm"),
    account: TRANCHE_STATE,
    priceAt: 256,
    tranche: true,
  },
};

export function perenaShareKeyFromString(value: string): PerenaShareKey {
  const v = value.toLowerCase().replace(/[^a-z]/g, "");
  if (v === "usdstar" || v === "usd" || v === "star") return "usdstar";
  if (v === "usdstarj" || v === "junior" || v === "usdstarjunior" || v === "j")
    return "usdstarj";
  throw new Error(`unknown Perena vault "${value}" — expected usdstar|junior`);
}

export function perenaOracleConfig(share: PerenaShare) {
  const unused = [65535, 65535, 65535, 65535];
  return {
    scopePrices: PublicKey.default,
    scopeChain: unused,
    scopeTwapChain: unused,
    pythPrice: PublicKey.default,
    pythFactor: PublicKey.default,
    receiptAccount: share.account,
    receiptProgram: PERENA,
    maxAgeSecs: 3_600,
    maxTwapDivergenceBps: 0,
    maxConfidenceBps: 0,
  };
}

const EXECUTE_DEPOSIT = [247, 103, 46, 184, 88, 188, 56, 46];
const EXECUTE_WITHDRAW = [255, 93, 15, 141, 187, 94, 246, 162];
const EXECUTE_TRANCHE_DEPOSIT = [231, 224, 46, 207, 175, 45, 77, 148];
const EXECUTE_TRANCHE_WITHDRAW = [240, 82, 254, 246, 177, 29, 57, 126];

export type PerenaCall = "deposit" | "withdraw";

export function perenaCallData(
  share: PerenaShare,
  call: PerenaCall,
  amount: bigint,
): Buffer {
  const selector = share.tranche
    ? call === "deposit"
      ? EXECUTE_TRANCHE_DEPOSIT
      : EXECUTE_TRANCHE_WITHDRAW
    : call === "deposit"
      ? EXECUTE_DEPOSIT
      : EXECUTE_WITHDRAW;
  const kind = share.tranche ? [JUNIOR] : [];
  const data = Buffer.alloc(8 + kind.length + 8);
  Buffer.from([...selector, ...kind]).copy(data, 0);
  data.writeBigUInt64LE(amount, 8 + kind.length);
  return data;
}

export function perenaCallAccounts(
  share: PerenaShare,
  call: PerenaCall,
  margin: PublicKey,
): AccountMeta[] {
  const w = (pubkey: PublicKey) => ({
    pubkey,
    isWritable: true,
    isSigner: false,
  });
  const r = (pubkey: PublicKey) => ({
    pubkey,
    isWritable: false,
    isSigner: false,
  });
  const marginUsdc = w(ata(margin, USDC_MINT, TOKEN_PROGRAM_ID));
  const marginShares = w(ata(margin, share.mint, TOKEN_PROGRAM_ID));
  const vaultUsdc = w(ata(VAULT, USDC_MINT, TOKEN_PROGRAM_ID));
  const fees = [w(FEE_VAULT), w(ata(FEE_VAULT, USDC_MINT, TOKEN_PROGRAM_ID))];
  const programs = [r(TOKEN_PROGRAM_ID), r(TOKEN_PROGRAM_ID)];
  if (!share.tranche) {
    return [
      r(margin),
      w(VAULT),
      r(VAULT_ORACLE),
      r(TRANCHE_STATE),
      r(USDC_MINT),
      w(share.mint),
      marginUsdc,
      vaultUsdc,
      ...fees,
      marginShares,
      ...programs,
    ];
  }
  const head = [
    w(margin),
    w(VAULT),
    r(VAULT_ORACLE),
    w(TRANCHE_STATE),
    r(USDC_MINT),
    w(share.mint),
    marginUsdc,
    vaultUsdc,
  ];
  const tail = [
    ...programs,
    r(ASSOCIATED_TOKEN_PROGRAM_ID),
    r(SystemProgram.programId),
  ];
  return call === "deposit"
    ? [...head, ...fees, marginShares, ...tail]
    : [...head, marginShares, ...tail];
}

export async function perenaShareValue(
  conn: Connection,
  share: PerenaShare,
  shares: bigint,
): Promise<bigint> {
  const info = await conn.getAccountInfo(share.account);
  if (!info)
    throw new Error(`Perena account ${share.account.toBase58()} not found`);
  const price = info.data.readBigUInt64LE(share.priceAt);
  return (shares * price * 1_000n) / SHARE_PRICE_SCALE;
}
