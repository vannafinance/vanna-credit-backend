import { expect, it } from 'vitest';
import { BASIS_PROGRAM, PERENA_PROGRAM } from './vault-catalogue';
import { vaultFailure } from './vault-errors';
import { decodePerpAssetMap } from './phoenix';
it('maps upstream failures without confusing program-specific codes', () => {
  expect(vaultFailure([`Program ${PERENA_PROGRAM} failed: custom program error: 0x1b61`])).toBe('perena-stale');
  expect(vaultFailure([`Program ${BASIS_PROGRAM} failed: custom program error: 0x177f`])).toBe('market-closed');
  expect(vaultFailure([`Program ${BASIS_PROGRAM} failed: custom program error: 0x1b61`])).toBeNull();
  expect(vaultFailure([])).toBeNull();
});
it.each([[0,false],[1,false],[2,true],[4,true],[6,true]])('decodes market session flags %i', (flags, closed) => {
  const data = Buffer.alloc(48 + 1584);
  data.writeUInt32LE(1, 32);
  data[48 + 1472] = Number(flags);
  expect(decodePerpAssetMap(data)[0].afterHours).toBe(closed);
});
