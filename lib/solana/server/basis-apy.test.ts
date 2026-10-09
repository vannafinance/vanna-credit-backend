import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DAY } from '../../farm/nav-math';
import type { VaultDefinition } from '../vault-catalogue';
const mocks = vi.hoisted(() => ({ signatures: vi.fn(), tx: vi.fn(), endpoint: '' }));
vi.mock('../connection', () => ({ getConnection: () => ({ rpcEndpoint: mocks.endpoint, getSignaturesForAddress: mocks.signatures, getTransaction: mocks.tx }) }));
vi.mock('@vanna/phoenix-vault-client', () => ({ vaultProgram: () => ({}), parseEvents: (_: unknown, logs: string[]) => JSON.parse(logs[0]) }));
import { basisDepositPrices } from './basis-apy';
const def = { account: 'BLeEcGjJnbGQyDBeTgckreKnKD87xFDDBFTfQYEyZ1j7' } as VaultDefinition;
const old = Math.floor((Date.now() - 8 * DAY) / 1000);
beforeEach(() => { vi.clearAllMocks(); mocks.endpoint = String(Math.random()); });
describe('cached Basis event baseline reads', () => {
  it('does not fetch transactions when all signatures are too recent or failed', async () => {
    mocks.signatures.mockResolvedValue([{ signature: 'young', blockTime: Date.now() / 1000, err: null }, { signature: 'failed', blockTime: old, err: {} }]);
    expect(await basisDepositPrices(def)).toEqual([]);
    expect(mocks.tx).not.toHaveBeenCalled();
  });
  it('accepts only successful deposits for this vault, and coalesces/caches reads', async () => {
    mocks.signatures.mockResolvedValue([{ signature: 'old', blockTime: old, err: null }]);
    mocks.tx.mockResolvedValue({ blockTime: old, meta: { err: null, logMessages: [JSON.stringify([
      { name: 'Deposited', data: { basis_vault: 'other', value_usd: '9000000', shares: '10000000' } },
      { name: 'Withdrawn', data: {} },
      { name: 'deposited', data: { basisVault: def.account, valueUsd: '9980000', shares: '10000000' } },
    ])] } });
    const [a, b] = await Promise.all([basisDepositPrices(def), basisDepositPrices(def)]);
    expect(a).toEqual([{ at: old * 1000, price: .998 }]);
    expect(b).toEqual(a);
    await basisDepositPrices(def);
    expect(mocks.signatures).toHaveBeenCalledTimes(1);
    expect(mocks.tx).toHaveBeenCalledTimes(1);
  });
  it('rejects failed transaction metadata and backs off on RPC failures', async () => {
    mocks.signatures.mockResolvedValue([{ signature: 'old', blockTime: old, err: null }]);
    mocks.tx.mockResolvedValue({ blockTime: old, meta: { err: {}, logMessages: [] } });
    expect(await basisDepositPrices(def)).toEqual([]);
    mocks.endpoint += 'failure';
    mocks.signatures.mockRejectedValue(new Error('RPC unavailable'));
    expect(await basisDepositPrices(def)).toEqual([]);
    expect(await basisDepositPrices(def)).toEqual([]);
    expect(mocks.signatures).toHaveBeenCalledTimes(2);
  });
});
