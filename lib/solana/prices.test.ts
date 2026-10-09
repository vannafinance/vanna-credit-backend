import { describe, expect, it, vi } from 'vitest';
import { PublicKey, type Connection } from '@solana/web3.js';
import { TOKENS } from './tokens';
import { VAULTS } from './vault-catalogue';
const mocks = vi.hoisted(()=>({assets:vi.fn(),read:vi.fn()}));
vi.mock('./protocol-state',()=>({fetchAllAssetConfigs:mocks.assets}));
vi.mock('./connection',()=>({forkUnixTimestamp:async()=>1n,getMultipleAccountsChunked:mocks.read}));
vi.mock('./oracle',()=>({priceFromAccounts:()=>null}));
import { readOnchainPrices } from './prices';
describe('registry prices',()=>{
 it('does not download large venue accounts for unrelated vault receipts',async()=>{
  const tokenPrice = new PublicKey('11111111111111111111111111111112');
  const largeVenue = new PublicKey('11111111111111111111111111111113');
  mocks.assets.mockResolvedValue(new Map([
   [0,{mint:TOKENS[0].mint,oracleAccounts:[tokenPrice],oracle:{}}],
   [1,{mint:new PublicKey(VAULTS[0].mint),oracleAccounts:[largeVenue],oracle:{}}],
  ]));
  mocks.read.mockResolvedValue([null]);
  await readOnchainPrices({} as Connection);
  expect(mocks.read.mock.calls[0][1].map((p:PublicKey)=>p.toBase58())).toEqual([tokenPrice.toBase58()]);
 });
});
