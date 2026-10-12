/** Bounded, cached, read-only event fallback. Never fabricate history or fetch every transaction. */
import { PublicKey } from '@solana/web3.js';
import { parseEvents, vaultProgram } from '@vanna/phoenix-vault-client';
import { getConnection } from '../connection';
import type { VaultDefinition } from '../vault-catalogue';
import { DAY, type NavPoint } from '../../farm/nav-math';
import { depositPrice } from '../../farm/yield';

const cache = new Map<string, { at: number; points: NavPoint[] }>();
const pending = new Map<string, Promise<NavPoint[]>>();
const TTL = 10 * 60_000;

export function basisDepositPrices(def: VaultDefinition): Promise<NavPoint[]> {
  const conn = getConnection();
  const key = `${conn.rpcEndpoint}:${def.account}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < TTL) return Promise.resolve(cached.points);
  const running = pending.get(key);
  if (running) return running;
  const load = async () => {
    const now = Date.now();
    const signatures = await conn.getSignaturesForAddress(new PublicKey(def.account), { limit: 100 }, 'confirmed');
    // Inspect candidates around BOTH cutoffs. A busy/truncated RPC history is not treated as zero APY.
    const eligible = signatures.filter(s => !s.err && s.blockTime && s.blockTime * 1000 <= now - 7 * DAY);
    const candidates = [...new Map([
      ...eligible.slice(0, 6),
      ...eligible.filter(s => s.blockTime! * 1000 <= now - 30 * DAY).slice(0, 6),
    ].map(s => [s.signature, s])).values()];
    const points: NavPoint[] = [];
    const program = vaultProgram(conn);
    // Two concurrent reads at a time; scanning isn't on the wallet's transaction path.
    for (let i = 0; i < candidates.length; i += 2) {
      await Promise.all(candidates.slice(i, i + 2).map(async s => {
        const tx = await conn.getTransaction(s.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
        if (!tx?.meta || tx.meta.err || !tx.blockTime || !tx.meta.logMessages) return;
        for (const event of parseEvents(program, tx.meta.logMessages)) {
          if (event.name.toLowerCase() !== 'deposited') continue;
          const d = event.data as Record<string, unknown>;
          if (String(d.basisVault ?? d.basis_vault) !== def.account) continue;
          const price = depositPrice(BigInt(String(d.valueUsd ?? d.value_usd)), BigInt(String(d.shares)));
          if (price !== null) points.push({ at: tx.blockTime * 1000, price });
        }
      }));
    }
    cache.set(key, { at: now, points });
    return points;
  };
  const request = load().catch(() => {
    // Back off on RPC failure; don't turn partial reads into a claimed rate.
    cache.set(key, { at: Date.now(), points: [] });
    return [];
  }).finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}

const launchCache = new Map<string, number>();
/**
 * Unix seconds of a vault account's first transaction (its launch), read once per process by paging
 * its signatures back to the oldest; null when the history can't be read.
 */
export async function basisLaunchedAt(def: VaultDefinition): Promise<number | null> {
  const hit = launchCache.get(def.account);
  if (hit) return hit;
  try {
    const conn = getConnection();
    let before: string | undefined;
    let oldest: number | null = null;
    for (let page = 0; page < 20; page++) {
      const sigs = await conn.getSignaturesForAddress(new PublicKey(def.account), { limit: 1000, before }, 'confirmed');
      if (!sigs.length) break;
      for (const s of sigs) if (s.blockTime && s.blockTime > 1.6e9) oldest = oldest === null ? s.blockTime : Math.min(oldest, s.blockTime);
      before = sigs[sigs.length - 1].signature;
      if (sigs.length < 1000) break;
    }
    if (oldest !== null) launchCache.set(def.account, oldest);
    return oldest;
  } catch {
    return null;
  }
}

/** Compounded annual rate of a share price that started at 1.0, `seconds` after launch. */
export function sinceLaunchApy(sharePrice: number, seconds: number): number | null {
  // Under a day the annualised figure is too noisy to show.
  if (!(sharePrice > 0) || !(seconds >= DAY / 1000)) return null;
  const v = (Math.pow(sharePrice, (365 * 86400) / seconds) - 1) * 100;
  return Number.isFinite(v) ? v : null;
}
