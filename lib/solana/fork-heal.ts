import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { SOLANA_RPC_URL } from "./config";

/**
 * Program IDs for the concentrated-liquidity AMMs Jupiter can route through on this fork
 * (Raydium CLMM, Meteora DLMM, Orca Whirlpool). Their pool state is lazy-cloned once and then
 * frozen, so it drifts from live mainnet the longer the fork runs.
 */
const STALE_PRONE_DEX_PROGRAMS = new Set([
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", // Raydium CLMM
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", // Meteora DLMM
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", // Orca Whirlpool
]);

/**
 * Self-heal for the Surfpool-fork stale-pool-clone class of failure (ported from
 * Backend-Solana lib/solana/jupiter.ts `healStaleDexPools`): re-clones every account this
 * transaction touches that's owned by a known concentrated-liquidity AMM program (plus those
 * pools' token vaults and any lookup table shorter than the indexes the tx references) via
 * Surfpool's `surfnet_resetAccount` cheatcode. Resetting re-clones the account fresh from live
 * mainnet — exactly the state Jupiter's quote was computed against — so the same already-built
 * transaction becomes valid again.
 *
 * Returns the number of accounts reset, so callers only retry when something was fixed (and
 * never mask a genuinely different failure as "stale pool").
 */
export async function healStaleDexPools(connection: Connection, tx: VersionedTransaction): Promise<number> {
  try {
    const message = tx.message;
    const staticKeys = message.staticAccountKeys.map((k) => k.toBase58());
    const lutKeys: string[] = [];
    // A lookup TABLE itself can also be stale: mainnet keeps extending a route's ALT while the
    // fork's clone is frozen at its clone-time length ("contains an invalid index").
    const staleTables: string[] = [];
    for (const lookup of message.addressTableLookups ?? []) {
      const info = await connection.getAddressLookupTable(lookup.accountKey);
      const table = info.value;
      const highestIndex = Math.max(-1, ...lookup.writableIndexes, ...lookup.readonlyIndexes);
      if (!table || table.state.addresses.length <= highestIndex) {
        staleTables.push(lookup.accountKey.toBase58());
        continue;
      }
      for (const idx of [...lookup.writableIndexes, ...lookup.readonlyIndexes]) {
        const addr = table.state.addresses[idx];
        if (addr) lutKeys.push(addr.toBase58());
      }
    }
    const allKeys = [...staticKeys, ...lutKeys];
    const infos: (import("@solana/web3.js").AccountInfo<Buffer> | null)[] = [];
    for (let i = 0; i < allKeys.length; i += 100) {
      infos.push(...(await connection.getMultipleAccountsInfo(allKeys.slice(i, i + 100).map((k) => new PublicKey(k)))));
    }
    const dexOwned = allKeys.filter((_, i) => {
      const owner = infos[i]?.owner.toBase58();
      return owner && STALE_PRONE_DEX_PROGRAMS.has(owner);
    });
    // A pool's token vaults are owned by the token program, not the DEX program, but use the
    // pool account as their authority (bytes 32..64) — reset them together with the pool so the
    // pool's bins and the vault balances stay consistent.
    const dexOwnedSet = new Set(dexOwned);
    const poolVaults = allKeys.filter((_, i) => {
      const info = infos[i];
      if (!info || info.data.length < 64) return false;
      if (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID)) return false;
      return dexOwnedSet.has(new PublicKey(info.data.subarray(32, 64)).toBase58());
    });
    const stale = [...new Set([...dexOwned, ...poolVaults, ...staleTables])];
    if (stale.length === 0) return 0;
    await Promise.all(
      stale.map((address) =>
        fetch(SOLANA_RPC_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "surfnet_resetAccount", params: [address] }),
        }).catch(() => null),
      ),
    );
    return stale.length;
  } catch {
    return 0;
  }
}
