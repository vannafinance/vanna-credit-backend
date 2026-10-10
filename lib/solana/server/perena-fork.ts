/** Hosted-fork clock adapter only. Keeps the cloned NAV and every balance unchanged. */
import { Connection, PublicKey } from "@solana/web3.js";
import { forkUnixTimestamp } from "../connection";
import { PERENA_PROGRAM, VAULTS } from "../vault-catalogue";
import { callCheatcode } from "./cheatcodes";
export const PERENA_VAULT_ORACLE = "2YH9QB7qmEBgekeXH4C36L2dwMPfLdoPi5DDxeTi1kyP";
const USDSTAR_VAULT = "ECJGrTZ6QYMEwiEAnL4oReWF126uc22e9Lojy9qyCjHT";

/** Perena vault-sdk 1.0.56: 48-byte account header + payload settled NAV timestamp at 8.
 * This is different from vault.accounting.last_update_ts. Never alter signer votes or prices.
 */
export function alignedPerenaOracle(data: Buffer, now: bigint): Buffer | null {
  if (data.length !== 2096 || !data.subarray(0, 8).equals(Buffer.from([55,234,122,181,207,61,41,204])) ||
      data[9] !== 0 || !data.subarray(16, 48).equals(new PublicKey(USDSTAR_VAULT).toBuffer())) {
    throw new Error("Unsupported Perena oracle layout; clock refresh stopped");
  }
  const stamped = data.readBigInt64LE(56);
  if (now >= stamped && now - stamped < 1800n) return null;
  const updated = Buffer.from(data);
  updated.writeBigInt64LE(now, 56);
  return updated;
}

/** Snapshot-only price-cache alignment. SDK Vault.holdings starts at 2256; each
 * 184-byte holding stores last_update_ts at +40. Prices and amounts stay unchanged. */
export function alignedPerenaHoldings(data: Buffer, now: bigint): Buffer | null {
  if (data.length !== 10016 || !data.subarray(0, 8).equals(Buffer.from([211,8,232,43,2,152,117,119]))) {
    throw new Error("Unsupported Perena vault layout; clock refresh stopped");
  }
  let updated: Buffer | null = null;
  for (let i = 0; i < 12; i++) {
    const at = 2256 + i * 184;
    if (data.subarray(at, at + 32).every(b => b === 0) || data[at + 50] === 0) continue;
    const stamped = data.readBigInt64LE(at + 40);
    if (now >= stamped && now - stamped < 1800n) continue;
    updated ??= Buffer.from(data);
    updated.writeBigInt64LE(now, at + 40);
  }
  return updated;
}

let inflight: Promise<string[]> | null = null;
export function alignPerenaNavClock(connection: Connection): Promise<string[]> {
  // Scope mutation to the explicitly supported test fork; never restamp a mainnet oracle.
  if (new URL(connection.rpcEndpoint).hostname !== "rpc-devnet.solana.vanna.finance") return Promise.resolve([]);
  inflight ??= align(connection).finally(() => { inflight = null; });
  return inflight;
}
async function align(connection: Connection) {
  // Only the hosted test fork carries the cloned Perena accounts; on any other RPC (local
  // Surfpool, a private FORK_RPC_URL) skip quietly so the price refresh that calls this succeeds.
  if (
    new URL(connection.rpcEndpoint).hostname !==
    "rpc-devnet.solana.vanna.finance"
  )
    return [];
  const defs = VAULTS.filter((v) => v.kind === "perena");
  const [infos, now] = await Promise.all([
    connection.getMultipleAccountsInfo(
      [...defs.map((v) => new PublicKey(v.account)), new PublicKey(PERENA_VAULT_ORACLE)],
    ),
    forkUnixTimestamp(connection),
  ]);
  const oracle = infos[defs.length];
  if (!oracle || oracle.owner.toBase58() !== PERENA_PROGRAM) throw new Error("Perena vault oracle is unavailable");
  const data = alignedPerenaOracle(oracle.data, now);
  const holdings = infos[0] ? alignedPerenaHoldings(infos[0].data, now) : null;
  const changed: string[] = [];
  for (let i = 0; i < defs.length; i++) {
    const info = infos[i],
      at = defs[i].priceAt! + 8;
    if (
      !info ||
      info.owner.toBase58() !== PERENA_PROGRAM ||
      info.data.length < at + 8
    )
      continue;
    const stamped = info.data.readBigInt64LE(at);
    if ((now > stamped ? now - stamped : stamped - now) < 1800n && !(i === 0 && holdings)) continue;
    const data = i === 0 && holdings ? holdings : Buffer.from(info.data);
    data.writeBigInt64LE(now, at);
    await callCheatcode("surfnet_setAccount", [
      defs[i].account,
      {
        lamports: info.lamports,
        owner: info.owner.toBase58(),
        executable: false,
        data: data.toString("hex"),
      },
    ]);
    changed.push(defs[i].id);
  }
  if (data) {
    await callCheatcode("surfnet_setAccount", [PERENA_VAULT_ORACLE, {
      lamports: oracle.lamports, owner: oracle.owner.toBase58(), executable: false, data: data.toString("hex"),
    }]);
    changed.push("perena-oracle");
  }
  return changed;
}
