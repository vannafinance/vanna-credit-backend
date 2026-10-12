/**
 * Allowlists World markets for outcome_yield_pool on the hosted fork (`allow_market`, admin only),
 * optionally creating their pools. DRY RUN by default: prints what it would do and sends nothing.
 *
 *   npx tsx scripts/predict-allow-markets.ts <marketId…>          # dry run for these markets
 *   npx tsx scripts/predict-allow-markets.ts --live                # dry run: every listed market not yet allowlisted
 *   npx tsx scripts/predict-allow-markets.ts --live --apply        # send (admin signs)
 *   … --create-pool                                                # also create each pool (payer = admin)
 *
 * The admin keypair is PREDICT_POOL_ADMIN_KEYPAIR (path to a JSON keypair file), else
 * ~/.config/solana/id.json; it must equal the pool Config's `admin` (checked first). Up-or-down
 * windows are never allowlisted (they expire within minutes).
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

async function main() {
  const { readFileSync } = await import("node:fs");
  const { homedir } = await import("node:os");
  const path = await import("node:path");
  const { Keypair, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } = await import("@solana/web3.js");
  const { getConnection } = await import("../lib/solana/connection");
  const { confirmSignatureHttp } = await import("../lib/solana/confirmation");
  const { allowMarketIx, createPoolIx, readAllowlist, readPoolConfig, readPoolStates } = await import("../lib/predict/pool.server");
  const { getMarketInfo, listMarketInfos } = await import("../lib/predict/catalog.server");

  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const createPool = args.includes("--create-pool");
  const live = args.includes("--live");
  const explicit = args.filter((a) => !a.startsWith("--"));

  const keyPath = process.env.PREDICT_POOL_ADMIN_KEYPAIR ?? path.join(homedir(), ".config", "solana", "id.json");
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8")) as number[]));
  const cfg = await readPoolConfig();
  if (!cfg) throw new Error("outcome_yield_pool config not found on the fork");
  console.log(`admin key ${admin.publicKey.toBase58()} (${keyPath}); config admin ${cfg.admin.toBase58()}`);
  if (!cfg.admin.equals(admin.publicKey)) throw new Error("This key is not the pool config admin: it cannot allow_market");

  let ids = explicit;
  if (live) {
    const { markets } = await listMarketInfos();
    ids = [...new Set([...ids, ...markets.filter((m) => m.startMs === null).map((m) => m.id)])];
  }
  if (!ids.length) throw new Error("Pass market ids or --live");
  for (const id of ids) new PublicKey(id);
  const allowed = await readAllowlist(ids);
  const todo = ids.filter((id) => !allowed.get(id));
  const pools = createPool ? await readPoolStates(ids) : new Map();
  const needPool = createPool ? ids.filter((id) => !pools.get(id)?.exists) : [];
  console.log(`${ids.length} markets: ${ids.length - todo.length} already allowlisted, ${todo.length} to allow${createPool ? `, ${needPool.length} pools to create` : ""}`);
  for (const id of todo) {
    const info = await getMarketInfo(id);
    console.log(`  allow ${id}  ${info?.question ?? "(unknown market)"}`);
  }
  if (!apply) {
    console.log("\nDRY RUN — nothing sent. Re-run with --apply to send.");
    return;
  }

  const conn = getConnection();
  const send = async (label: string, ixs: Awaited<ReturnType<typeof allowMarketIx>>[]) => {
    const latest = await conn.getLatestBlockhash("confirmed");
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: admin.publicKey, recentBlockhash: latest.blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...ixs] }).compileToV0Message());
    tx.sign([admin]);
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: "confirmed" });
    await confirmSignatureHttp(conn, sig, latest.lastValidBlockHeight);
    console.log(`  ${label}: ${sig}`);
  };
  for (let i = 0; i < todo.length; i += 4) {
    const batch = todo.slice(i, i + 4);
    await send(`allow ${batch.length}`, await Promise.all(batch.map((id) => allowMarketIx(admin.publicKey, id))));
  }
  for (const id of needPool) {
    const info = await getMarketInfo(id);
    if (!info) continue;
    await send(`create pool ${id}`, [await createPoolIx(admin.publicKey, { marketId: id, yesMint: info.yesMint, noMint: info.noMint })]);
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
