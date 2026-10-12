/**
 * Pure decoders for World's on-chain accounts (unit-tested in decode.test.ts). No RPC here.
 */
import { Buffer } from "buffer";
import { PublicKey } from "@solana/web3.js";
import {
  CASH_MINT,
  GROUP_DISCRIMINATOR_HEX,
  GROUP_MEMBER_SIZE,
  GROUP_OFFSETS,
  JANUS_ORACLE_OFFSETS,
  JANUS_ORACLE_SIZE,
  MARKET_ACCOUNT_SIZE,
  MARKET_DISCRIMINATOR_HEX,
  MARKET_OFFSETS,
} from "./constants";
import type { JanusOracle, MintMeta, RawGroup, RawMarket } from "./types";

const readKey = (data: Buffer, offset: number) => new PublicKey(data.subarray(offset, offset + 32)).toBase58();
/** Plausible epoch-millisecond window (2020 … 2049); anything else is "not set". */
const isMs = (v: number) => v > 1.6e12 && v < 2.5e12;

/** Decodes a 320-byte World `Market`; null for any other account or a non-CASH market. */
export function decodeMarket(id: string, data: Buffer): RawMarket | null {
  if (data.length !== MARKET_ACCOUNT_SIZE) return null;
  if (data.subarray(0, 8).toString("hex") !== MARKET_DISCRIMINATOR_HEX) return null;
  if (readKey(data, MARKET_OFFSETS.cashMint) !== CASH_MINT) return null;
  const start = Number(data.readBigUInt64LE(MARKET_OFFSETS.startMs));
  const end = Number(data.readBigUInt64LE(MARKET_OFFSETS.endMs));
  return {
    id,
    yesMint: readKey(data, MARKET_OFFSETS.yesMint),
    noMint: readKey(data, MARKET_OFFSETS.noMint),
    vault: readKey(data, MARKET_OFFSETS.vault),
    resolutionKind: data[MARKET_OFFSETS.resolutionKind] ?? 0,
    startMs: isMs(start) ? start : null,
    endMs: isMs(end) ? end : null,
  };
}

/** Decodes a World `Group` (mutually exclusive set of markets); null for any other account. */
export function decodeGroup(id: string, data: Buffer): RawGroup | null {
  if (data.length < GROUP_OFFSETS.members) return null;
  if (data.subarray(0, 8).toString("hex") !== GROUP_DISCRIMINATOR_HEX) return null;
  if (readKey(data, GROUP_OFFSETS.collateralMint) !== CASH_MINT) return null;
  const count = data.readUInt32LE(GROUP_OFFSETS.memberCount);
  if (GROUP_OFFSETS.members + count * GROUP_MEMBER_SIZE > data.length) return null;
  const members: string[] = [];
  for (let i = 0; i < count; i++) members.push(readKey(data, GROUP_OFFSETS.members + i * GROUP_MEMBER_SIZE));
  return { id, members };
}

/**
 * Token-2022 `TokenMetadata` extension (type 19) of a mint: name, symbol, uri. The mint's TLV
 * area starts after the 165-byte base + 1-byte account type.
 */
export function parseTokenMetadata(data: Buffer): MintMeta | null {
  let i = 166;
  while (i + 4 <= data.length) {
    const type = data.readUInt16LE(i);
    const len = data.readUInt16LE(i + 2);
    const value = data.subarray(i + 4, i + 4 + len);
    i += 4 + len;
    if (type !== 19) continue;
    let o = 64; // update authority + mint
    const str = () => {
      const n = value.readUInt32LE(o);
      o += 4;
      const s = value.subarray(o, o + n).toString("utf8");
      o += n;
      return s;
    };
    try {
      return { name: str(), symbol: str(), uri: str() };
    } catch {
      return null;
    }
  }
  return null;
}

/** SPL / Token-2022 token account amount (u64 at byte 64); 0 for a missing / short account. */
export function tokenAmountOf(data: Buffer | null | undefined): bigint {
  if (!data || data.length < 72) return 0n;
  return data.readBigUInt64LE(64);
}

/** SPL / Token-2022 mint supply (u64 at byte 36); 0 for a missing / short account. */
export function mintSupplyOf(data: Buffer | null | undefined): bigint {
  if (!data || data.length < 44) return 0n;
  return data.readBigUInt64LE(36);
}

/**
 * Decodes one JanusFI oracle account (layout in constants.ts `JANUS_ORACLE_OFFSETS`); null for any
 * other account (wrong size / version, or a mid outside 0 … 1 CASH). The caller checks the owner.
 */
export function decodeJanusOracle(data: Buffer): JanusOracle | null {
  if (data.length !== JANUS_ORACLE_SIZE || data[0] !== 1) return null;
  const O = JANUS_ORACLE_OFFSETS;
  const mid = Number(data.readBigUInt64LE(O.mid)) / 1e6;
  if (!(mid >= 0 && mid <= 1)) return null;
  return {
    market: readKey(data, O.market),
    flags: data[O.flags],
    slot: Number(data.readBigUInt64LE(O.slot)),
    updatedMs: Math.floor(Number(data.readBigUInt64LE(O.updatedNs) / 1_000_000n)),
    mid,
    halfSpread: data.readUInt32LE(O.halfSpread) / 1e6,
  };
}
