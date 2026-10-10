import { BASIS_PROGRAM, PERENA_PROGRAM } from './vault-catalogue';

export const MARKET_SESSION_MESSAGE = 'Deposits are closed while this market is outside its trading session or reopening. Try again when the session is open. Withdrawals remain subject to available liquidity.';
export const PERENA_STALE_MESSAGE = 'Perena pricing is out of date. The refresh could not restore a valid quote; please retry shortly. No vault transaction was sent.';

/** Program identity matters: custom error numbers overlap between integrations. */
export function vaultFailure(logs: string[]): 'perena-stale' | 'market-closed' | null {
  if (logs.some(l => l.includes(`Program ${PERENA_PROGRAM} failed:`) && /0x1b61\b|\b7009\b/.test(l))) return 'perena-stale';
  if (logs.some(l => l.includes(`Program ${BASIS_PROGRAM} failed:`) && /0x177f\b|\b6015\b/.test(l))) return 'market-closed';
  return null;
}
