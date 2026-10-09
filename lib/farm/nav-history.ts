/** Server-only hourly observations. Missing history is never replaced with sample APY. */
import { durableStore, type RecordStore } from "../copilot/store";
import { copilotConfig } from "../copilot/config";
import { DAY, HOUR, historicalApy, type NavPoint } from "./nav-math";
export { historicalApy, type NavPoint } from "./nav-math";
/** Kept long enough for the 90-day APY and the vault pages' "3 Months" charts. */
const RETENTION_DAYS = 100;
let store: RecordStore<NavPoint[]> | undefined;
function navStore() {
  store ??= durableStore<NavPoint[]>(
    "farm_vault_nav",
    ".local/farm/nav",
    copilotConfig.storeSecret,
    /^(basis|perena)-[a-z]+$/,
  );
  return store;
}
/** The recorded hourly share-price observations of one vault, oldest first (empty when none). */
export async function readNav(id: string, now = Date.now()): Promise<NavPoint[]> {
  const saved = await navStore().read(id);
  return (saved?.value ?? []).filter((p) => now - p.at <= RETENTION_DAYS * DAY);
}
export async function recordNav(id: string, price: number, now = Date.now()) {
  const saved = await navStore().read(id);
  const points = (saved?.value ?? []).filter(
    (p) => now - p.at <= RETENTION_DAYS * DAY,
  );
  const current = { at: now, price };
  if (
    Number.isFinite(price) &&
    price > 0 &&
    (!points.length ||
      Math.floor(points.at(-1)!.at / HOUR) < Math.floor(now / HOUR))
  ) {
    if (await navStore().write(id, saved?.version ?? null, [...points, current]))
      points.push(current);
  }
  return {
    apy7: historicalApy(points, current, 7),
    apy30: historicalApy(points, current, 30),
    history: points,
  };
}
