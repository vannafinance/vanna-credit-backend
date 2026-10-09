/** Dry-run by default. Preserve legacy limits and initialize the new reserve share counter. */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());
import { readFileSync, writeFileSync } from "node:fs";
import { BN, BorshAccountsCoder } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { getConnection } from "../lib/solana/connection";
import { VANNA_PROGRAM_ID } from "../lib/solana/config";
import { protocolConfigPda } from "../lib/solana/pdas";
import { callCheatcode } from "../lib/solana/server/cheatcodes";
async function main() {
  const c = getConnection();
  if (new URL(c.rpcEndpoint).hostname !== "rpc-devnet.solana.vanna.finance")
    throw Error("Hosted fork only");
  const snapshot = JSON.parse(
    readFileSync("/tmp/vanna-fork-before-upgrade.json", "utf8"),
  ).result.value;
  const oldCoder = new BorshAccountsCoder(
    JSON.parse(readFileSync("idl/vanna_credit_layer_legacy.json", "utf8")),
  );
  const newCoder = new BorshAccountsCoder(
    JSON.parse(readFileSync("idl/vanna_credit_layer.json", "utf8")),
  );
  const changes = [];
  for (const [key, saved] of Object.entries(snapshot) as [
    string,
    { owner: string; data: string },
  ][]) {
    if (saved.owner !== VANNA_PROGRAM_ID.toBase58()) continue;
    for (const [type, fields] of [
      ["AssetConfig", ["max_collateral_per_margin"]],
      ["Reserve", ["supply_cap", "borrow_cap"]],
    ] as const) {
      let old;
      try {
        old = oldCoder.decode(type, Buffer.from(saved.data, "base64"));
      } catch {
        continue;
      }
      // Old unused venue records can carry a previous reserved-byte schema.
      // Token caps and reserve accounting are the scope of this migration.
      if (type === "AssetConfig" && old.kind.Venue) continue;
      const before = await c.getAccountInfo(new PublicKey(key));
      if (!before) throw Error("Missing " + key);
      let now;
      try {
        now = newCoder.decode(type, before.data);
      } catch (error) {
        throw Error(`${type} ${key}: ${String(error)}`);
      }
      const changed: string[] = [];
      for (const f of fields)
        if (old[f].toString() === "0" && now[f].toString() === "0") {
          now[f] = new BN("18446744073709551615");
          changed.push(`${f}: legacy unlimited → u64::MAX`);
        }
      if (type === "Reserve" && now.total_supply_shares.isZero()) {
        const mint = await c.getAccountInfo(now.share_mint);
        if (!mint || mint.data.length < 82)
          throw Error("Missing reserve share mint");
        const supply = mint.data.readBigUInt64LE(36);
        if (supply > 0n) {
          now.total_supply_shares = new BN(supply.toString());
          changed.push(`total_supply_shares: 0 → ${supply}`);
        }
      }
      if (!changed.length) continue;
      const after = Buffer.from(before.data);
      (await newCoder.encode(type, now)).copy(after);
      changes.push({ key, before, after, changed });
      console.log(type, key, changed.join("; "));
    }
  }
  writeFileSync(
    "/tmp/vanna-legacy-state-migration-plan.json",
    JSON.stringify(
      changes.map(({ key, changed }) => ({ key, changed })),
      null,
      2,
    ),
  );
  if (!process.argv.includes("--apply")) {
    console.log("Dry run records:", changes.length);
    return;
  }
  const protocol = await c.getAccountInfo(protocolConfigPda());
  if (!protocol) throw Error("Missing protocol");
  const backup = Object.fromEntries(
    changes.map((x) => [
      x.key,
      {
        ...x.before,
        owner: x.before.owner.toBase58(),
        data: x.before.data.toString("base64"),
      },
    ]),
  );
  writeFileSync(
    `/tmp/vanna-before-legacy-state-migration-${Date.now()}.json`,
    JSON.stringify(backup),
  );
  const write = (
    key: string,
    info: NonNullable<typeof protocol>,
    data: Buffer,
  ) =>
    callCheatcode("surfnet_setAccount", [
      key,
      {
        lamports: info.lamports,
        owner: info.owner.toBase58(),
        executable: false,
        data: data.toString("hex"),
      },
    ]);
  const halted = Buffer.from(protocol.data);
  halted[104] = 3;
  await write(protocolConfigPda().toBase58(), protocol, halted);
  for (const x of changes) {
    const current = await c.getAccountInfo(new PublicKey(x.key));
    if (!current?.data.equals(x.before.data))
      throw Error("Account changed; protocol remains halted for review");
    await write(x.key, x.before, x.after);
    if (!(await c.getAccountInfo(new PublicKey(x.key)))?.data.equals(x.after))
      throw Error("Verification failed; protocol remains halted");
  }
  await write(protocolConfigPda().toBase58(), protocol, protocol.data);
  console.log(
    "Verified migration. Balances and debts unchanged; fork not reset.",
  );
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
