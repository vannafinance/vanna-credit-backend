import { describe, expect, it } from 'vitest';
import { Connection, PublicKey } from '@solana/web3.js';
import { alignedPerenaOracle, alignPerenaNavClock } from './perena-fork';
function oracle() {
  const data = Buffer.alloc(2096, 7);
  Buffer.from([55,234,122,181,207,61,41,204]).copy(data);
  data[9] = 0;
  new PublicKey('ECJGrTZ6QYMEwiEAnL4oReWF126uc22e9Lojy9qyCjHT').toBuffer().copy(data, 16);
  data.writeBigInt64LE(1000n, 56);
  return data;
}
describe('fork oracle clock alignment', () => {
  it('changes only settled timestamp, preserving prices, votes and staleness limit', () => {
    const before = oracle(), after = alignedPerenaOracle(before, 100000n)!;
    expect(after.readBigInt64LE(56)).toBe(100000n);
    expect(before.readBigInt64LE(56)).toBe(1000n);
    after.writeBigInt64LE(1000n, 56);
    expect(after.equals(before)).toBe(true);
  });
  it('does not rewrite fresh timestamps', () => expect(alignedPerenaOracle(oracle(), 2000n)).toBeNull());
  it('aligns future snapshot time to fork time', () => expect(alignedPerenaOracle(oracle(), 100n)?.readBigInt64LE(56)).toBe(100n));
  it('rejects unexpected account layouts', () => {
    for (const offset of [0, 9, 16]) {
      const data = oracle(); data[offset] ^= 1;
      expect(() => alignedPerenaOracle(data, 100000n)).toThrow('Unsupported');
    }
    expect(() => alignedPerenaOracle(Buffer.alloc(2095), 100000n)).toThrow('Unsupported');
  });
  it('never aligns mainnet or unsupported RPCs', async () => {
    expect(await alignPerenaNavClock(new Connection('https://api.mainnet-beta.solana.com'))).toEqual([]);
  });
});

import { alignedPerenaHoldings } from './perena-fork';
it('aligns active holding price caches without changing their prices or balances', () => {
  const data = Buffer.alloc(10016);
  Buffer.from([211,8,232,43,2,152,117,119]).copy(data);
  data[2256] = 1; data[2256 + 50] = 2;
  data.writeBigUInt64LE(999866n, 2256 + 32);
  data.writeBigUInt64LE(100000000n, 2256 + 88);
  const after = alignedPerenaHoldings(data, 100000n)!;
  expect(after.readBigInt64LE(2256 + 40)).toBe(100000n);
  expect(alignedPerenaHoldings(after, 100001n)).toBeNull();
  after.writeBigInt64LE(0n, 2256 + 40);
  expect(after.equals(data)).toBe(true);
  expect(() => alignedPerenaHoldings(Buffer.alloc(10016), 1n)).toThrow('Unsupported');
});
