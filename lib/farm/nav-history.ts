/** Server-only hourly observations. Missing history is never replaced with sample APY. */
import { durableStore, type RecordStore } from "../copilot/store";
import { copilotConfig } from "../copilot/config";
export interface NavPoint {
  at: number;
  price: number;
}
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let store: RecordStore<NavPoint[]> | undefined;
export function historicalApy(
  points: NavPoint[],
  current: NavPoint,
  days: number,
): number | null {
  const target = current.at - days * DAY;
  const prior = [...points]
    .reverse()
    .find((p) => p.at <= target && target - p.at <= 2 * HOUR);
  if (!prior || prior.price <= 0 || current.price <= 0) return null;
  const result =
    (Math.pow(
      current.price / prior.price,
      (365 * DAY) / (current.at - prior.at),
    ) -
      1) *
    100;
  return Number.isFinite(result) ? result : null;
}
export async function recordNav(id: string, price: number, now = Date.now()) {
  store ??= durableStore<NavPoint[]>(
    "farm_vault_nav",
    ".local/farm/nav",
    copilotConfig.storeSecret,
    /^(basis|perena)-[a-z]+$/,
  );
  const saved = await store.read(id);
  const points = (saved?.value ?? []).filter((p) => now - p.at <= 32 * DAY);
  const current = { at: now, price };
  if (
    Number.isFinite(price) &&
    price > 0 &&
    (!points.length ||
      Math.floor(points.at(-1)!.at / HOUR) < Math.floor(now / HOUR))
  ) {
    if (await store.write(id, saved?.version ?? null, [...points, current]))
      points.push(current);
  }
  return {
    apy7: historicalApy(points, current, 7),
    apy30: historicalApy(points, current, 30),
    history: points,
  };
}
