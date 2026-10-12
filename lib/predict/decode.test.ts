import { describe, expect, it } from "vitest";
import { Buffer } from "buffer";
import { Keypair, PublicKey } from "@solana/web3.js";
import { CASH_MINT, GROUP_DISCRIMINATOR_HEX, MARKET_DISCRIMINATOR_HEX } from "./constants";
import { decodeGroup, decodeJanusOracle, decodeMarket, mintSupplyOf, parseTokenMetadata, tokenAmountOf } from "./decode";

const key = () => Keypair.generate().publicKey;

function marketBuffer(opts: { cash?: PublicKey; startMs?: number; endMs?: number; kind?: number } = {}) {
  const d = Buffer.alloc(320);
  Buffer.from(MARKET_DISCRIMINATOR_HEX, "hex").copy(d, 0);
  (opts.cash ?? new PublicKey(CASH_MINT)).toBuffer().copy(d, 40);
  const yes = key(), no = key(), vault = key();
  yes.toBuffer().copy(d, 72);
  no.toBuffer().copy(d, 104);
  vault.toBuffer().copy(d, 136);
  d[224] = opts.kind ?? 5;
  d.writeBigUInt64LE(BigInt(opts.startMs ?? 0), 258);
  d.writeBigUInt64LE(BigInt(opts.endMs ?? 0), 266);
  return { d, yes, no, vault };
}

describe("decodeMarket", () => {
  it("reads mints, vault, kind and leaves non-window times null", () => {
    const { d, yes, no, vault } = marketBuffer();
    const m = decodeMarket("m1", d)!;
    expect(m).toMatchObject({ id: "m1", yesMint: yes.toBase58(), noMint: no.toBase58(), vault: vault.toBase58(), resolutionKind: 5, startMs: null, endMs: null });
  });
  it("reads Up / Down window times in ms", () => {
    const { d } = marketBuffer({ startMs: 1_790_000_000_000, endMs: 1_790_000_900_000, kind: 1 });
    expect(decodeMarket("w", d)).toMatchObject({ startMs: 1_790_000_000_000, endMs: 1_790_000_900_000, resolutionKind: 1 });
  });
  it("rejects other sizes, discriminators and collateral", () => {
    expect(decodeMarket("x", Buffer.alloc(113))).toBeNull();
    const { d } = marketBuffer();
    d[0] ^= 1;
    expect(decodeMarket("x", d)).toBeNull();
    expect(decodeMarket("x", marketBuffer({ cash: key() }).d)).toBeNull();
  });
});

describe("decodeGroup", () => {
  it("reads every member of a Group (36-byte entries from offset 123)", () => {
    const members = [key(), key(), key()];
    const d = Buffer.alloc(123 + 36 * members.length);
    Buffer.from(GROUP_DISCRIMINATOR_HEX, "hex").copy(d, 0);
    new PublicKey(CASH_MINT).toBuffer().copy(d, 40);
    d.writeUInt32LE(members.length, 119);
    members.forEach((m, i) => m.toBuffer().copy(d, 123 + 36 * i));
    expect(decodeGroup("g", d)).toEqual({ id: "g", members: members.map((m) => m.toBase58()) });
  });
  it("rejects a count that overruns the account", () => {
    const d = Buffer.alloc(159);
    Buffer.from(GROUP_DISCRIMINATOR_HEX, "hex").copy(d, 0);
    new PublicKey(CASH_MINT).toBuffer().copy(d, 40);
    d.writeUInt32LE(2, 119);
    expect(decodeGroup("g", d)).toBeNull();
  });
});

describe("parseTokenMetadata", () => {
  it("reads name / symbol / uri from the TokenMetadata TLV (type 19)", () => {
    const str = (s: string) => {
      const b = Buffer.from(s, "utf8");
      const len = Buffer.alloc(4);
      len.writeUInt32LE(b.length);
      return Buffer.concat([len, b]);
    };
    const value = Buffer.concat([Buffer.alloc(64), str("Kamala Harris (Yes)"), str("DN-KHAR-Y"), str("https://m.world.xyz/abc")]);
    const other = Buffer.alloc(4 + 8); // some other extension first
    other.writeUInt16LE(18, 0);
    other.writeUInt16LE(8, 2);
    const head = Buffer.alloc(4);
    head.writeUInt16LE(19, 0);
    head.writeUInt16LE(value.length, 2);
    const data = Buffer.concat([Buffer.alloc(166), other, head, value]);
    expect(parseTokenMetadata(data)).toEqual({ name: "Kamala Harris (Yes)", symbol: "DN-KHAR-Y", uri: "https://m.world.xyz/abc" });
  });
});

describe("token account helpers", () => {
  it("reads amount (byte 64) and supply (byte 36)", () => {
    const acct = Buffer.alloc(165);
    acct.writeBigUInt64LE(123_456n, 64);
    expect(tokenAmountOf(acct)).toBe(123_456n);
    const mint = Buffer.alloc(82);
    mint.writeBigUInt64LE(9n, 36);
    expect(mintSupplyOf(mint)).toBe(9n);
    expect(tokenAmountOf(null)).toBe(0n);
  });
});

describe("decodeJanusOracle", () => {
  // Real mainnet bytes (2026-10-12) of the oracle 6LMTMvvyuJLvtQxz5tF6AeU7JumwsYAinoyev4vkBrHx
  // (Atalanta vs Venezia, market FVJzqhab…): mid 63.5¢, half-spread 0.55¢.
  const real = Buffer.from(
    "010000000000000057212d1b00000000609f47b445b3dd184a4d0100000000000000000000000000480e010000000000" +
      "000000000000000078b00900000000000000000000000000" +
      "7c15000000ffd7443aaa5a9cea186f24ef822d9a932f6bac" +
      "e90fc7c3ff4319e8c0b1cdc8d0f90003",
    "hex",
  );
  it("reads mid, half-spread, flags, slot, write time and market", () => {
    expect(real.length).toBe(112);
    const o = decodeJanusOracle(real)!;
    expect(o.market).toBe("FVJzqhabn1ruSdEoiuFCzHeokuCWuWMH8kuVcSPugNmv");
    expect(o.mid).toBeCloseTo(0.635, 9);
    expect(o.halfSpread).toBeCloseTo(0.0055, 9);
    expect(o.flags).toBe(0);
    expect(o.slot).toBe(455_942_487);
    expect(o.updatedMs).toBeGreaterThan(1.79e12);
    expect(o.updatedMs).toBeLessThan(1.8e12);
  });
  it("rejects other sizes, versions and out-of-range mids", () => {
    expect(decodeJanusOracle(real.subarray(0, 111))).toBeNull();
    const v2 = Buffer.from(real);
    v2[0] = 2;
    expect(decodeJanusOracle(v2)).toBeNull();
    const bad = Buffer.from(real);
    bad.writeBigUInt64LE(2_000_000n, 56);
    expect(decodeJanusOracle(bad)).toBeNull();
  });
});
