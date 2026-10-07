/**
 * FORK ONLY. Copies Phoenix's shared state from mainnet as one consistent snapshot, then realigns
 * the exchange's last-restart slot with the fork (see lib/solana/server/perps-keeper.ts
 * `resyncPhoenixOnFork`). Run once before Phoenix trading on a fresh fork, never while a Vanna
 * margin holds a Phoenix position.
 *
 *   npx tsx --env-file=.env.local scripts/fork-phoenix-resync.ts
 */
import { Connection } from "@solana/web3.js";
import { SOLANA_RPC_URL } from "@/lib/solana/config";
import { resyncPhoenixOnFork } from "@/lib/solana/server/perps-keeper";
import { alignPhoenixExchangeOnFork } from "@/lib/solana/server/fork-prices";

(async () => {
  const written = await resyncPhoenixOnFork();
  await alignPhoenixExchangeOnFork(new Connection(SOLANA_RPC_URL, "confirmed"));
  console.log(`✔ Phoenix resynced from mainnet: ${written.length} accounts`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
