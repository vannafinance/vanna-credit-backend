import type { AccountInfo, Connection } from "@solana/web3.js";
import { forkUnixTimestamp, getMultipleAccountsChunked } from "./connection";
import { fetchAllAssetConfigs } from "./protocol-state";
import { priceFromAccounts, type OraclePrice } from "./oracle";
import { TOKENS } from "./tokens";

/**
 * Every registry token's price exactly as the program would read it now: each asset's own on-chain
 * OracleConfig (Scope chain first, Pyth fallback), from one deduplicated account fetch, with age
 * measured against the fork clock. Null for a token that isn't registered or has no usable price.
 */
export async function readOnchainPrices(connection: Connection): Promise<Record<string, OraclePrice | null>> {
  const [assetMap, now] = await Promise.all([fetchAllAssetConfigs(connection), forkUnixTimestamp(connection)]);
  // This endpoint returns registry-token prices only. Vault/venue oracles may
  // reference multi-megabyte Phoenix accounts that are neither needed nor decoded here.
  const registry = new Set(TOKENS.map(t => t.mint.toBase58()));
  const assets = [...assetMap.values()].filter(a => registry.has(a.mint.toBase58()));
  const keys = [...new Map(assets.flatMap((a) => a.oracleAccounts).map((k) => [k.toBase58(), k])).values()];
  const infos = await getMultipleAccountsChunked(connection, keys);
  const accounts = new Map(keys.map((k, i) => [k.toBase58(), infos[i] as AccountInfo<Buffer> | null]));
  return Object.fromEntries(
    TOKENS.map((t) => {
      const asset = assets.find((a) => a.mint.equals(t.mint));
      return [t.symbol, asset ? priceFromAccounts(asset.oracle, accounts, now) : null];
    }),
  );
}
