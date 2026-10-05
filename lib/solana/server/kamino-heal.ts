// Server-side only: keeps the fork's cloned Kamino Lend reserves usable.
import { forkFetch } from "../connection";
import { Connection } from "@solana/web3.js";
import { SOLANA_RPC_URL } from "../config";
import { KAMINO_RECEIPTS, KLEND_PROGRAM_ID } from "../kamino";
import { callCheatcode } from "./cheatcodes";

/** klend `Reserve.last_update` = { slot: u64 @16, stale: u8 @24, ... } (after discriminator + version). */
const LAST_UPDATE_SLOT_OFFSET = 16;
const LAST_UPDATE_STALE_OFFSET = 24;

export interface HealedReserve {
  underlying: string;
  reserve: string;
  fromSlot: number;
  toSlot: number;
}

/**
 * A Surfpool fork clones each Kamino reserve lazily, the first time it is touched, with mainnet's
 * CURRENT `last_update.slot`. When the fork's own slot is behind mainnet (the hosted fork is), that
 * slot is in the fork's future, and klend's internal interest refresh (`slots_elapsed =
 * current − last_update.slot`, `state/last_update.rs`) underflows → `MathOverflow` on every
 * deposit / redeem. Rewind such a reserve's `last_update.slot` to the fork's current slot (and mark
 * it stale, so klend refreshes it) via `surfnet_setAccount`. Reserves already behind the fork are
 * left untouched.
 */
export async function healKaminoReserves(rpcUrl: string = SOLANA_RPC_URL): Promise<HealedReserve[]> {
  const connection = new Connection(rpcUrl, { commitment: "confirmed", fetch: forkFetch });
  const [slot, infos] = await Promise.all([
    connection.getSlot("confirmed"),
    connection.getMultipleAccountsInfo(KAMINO_RECEIPTS.map((r) => r.reserve), "confirmed"),
  ]);
  const healed: HealedReserve[] = [];
  for (const [i, info] of infos.entries()) {
    if (!info || !info.owner.equals(KLEND_PROGRAM_ID)) continue;
    const lastSlot = info.data.readBigUInt64LE(LAST_UPDATE_SLOT_OFFSET);
    if (lastSlot <= BigInt(slot)) continue;
    const data = Buffer.from(info.data);
    data.writeBigUInt64LE(BigInt(slot), LAST_UPDATE_SLOT_OFFSET);
    data[LAST_UPDATE_STALE_OFFSET] = 1;
    await callCheatcode("surfnet_setAccount", [
      KAMINO_RECEIPTS[i].reserve.toBase58(),
      {
        lamports: info.lamports,
        data: data.toString("hex"),
        owner: info.owner.toBase58(),
        executable: false,
        rentEpoch: 0,
      },
    ]);
    healed.push({ underlying: KAMINO_RECEIPTS[i].underlying, reserve: KAMINO_RECEIPTS[i].reserve.toBase58(), fromSlot: Number(lastSlot), toSlot: slot });
  }
  return healed;
}
