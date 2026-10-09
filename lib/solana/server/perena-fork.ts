/** Hosted-fork clock adapter only. Keeps the cloned NAV and every balance unchanged. */
import { Connection, PublicKey } from "@solana/web3.js";
import { forkUnixTimestamp } from "../connection";
import { PERENA_PROGRAM, VAULTS } from "../vault-catalogue";
import { callCheatcode } from "./cheatcodes";
export async function alignPerenaNavClock(connection: Connection) {
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
      defs.map((v) => new PublicKey(v.account)),
    ),
    forkUnixTimestamp(connection),
  ]);
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
    if ((now > stamped ? now - stamped : stamped - now) < 1800n) continue;
    const data = Buffer.from(info.data);
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
  return changed;
}
