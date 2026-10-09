/** One reusable table for static Vanna/oracle accounts; never stores wallet keys. */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());
async function main() {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const { homedir } = await import("node:os");
  const { Keypair, PublicKey, AddressLookupTableProgram, SystemProgram } =
    await import("@solana/web3.js");
  const { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } =
    await import("@solana/spl-token");
  const { getConnection } = await import("../lib/solana/connection");
  const { fetchAllAssetConfigs } = await import("../lib/solana/protocol-state");
  const { sendInstructions, keypairSigner } = await import("../lib/solana/tx");
  const p = await import("../lib/solana/pdas");
  const config = await import("../lib/solana/config");
  const { BASIS_PROGRAM, PERENA_PROGRAM } =
    await import("../lib/solana/vault-catalogue");
  const c = getConnection();
  if (new URL(c.rpcEndpoint).hostname !== "rpc-devnet.solana.vanna.finance")
    throw Error("Hosted fork only");
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf8")),
    ),
  );
  const assets = await fetchAllAssetConfigs();
  const keys = [
    config.VANNA_PROGRAM_ID,
    config.ORACLE_PROGRAM_ID,
    config.VALIDATOR_PROGRAM_ID,
    p.protocolConfigPda(),
    p.priceBookPda(),
    PublicKey.findProgramAddressSync(
      [Buffer.from("__event_authority")],
      config.VANNA_PROGRAM_ID,
    )[0],
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    SystemProgram.programId,
    ...[BASIS_PROGRAM, PERENA_PROGRAM].flatMap((k) => [
      new PublicKey(k),
      p.integrationPda(new PublicKey(k)),
    ]),
  ];
  for (const a of assets.values())
    keys.push(
      a.address,
      a.mint,
      a.tokenProgram,
      p.reservePda(a.mint),
      ...a.oracleAccounts,
    );
  const { PERENA_SHARES, perenaCallAccounts } =
    await import("../lib/solana/perena");
  for (const share of Object.values(PERENA_SHARES))
    for (const call of ["deposit", "withdraw"] as const)
      keys.push(
        ...perenaCallAccounts(share, call, PublicKey.default).map(
          (a) => a.pubkey,
        ),
      );
  const addresses = [...new Map(keys.map((k) => [k.toBase58(), k])).values()];
  if (addresses.length > 256) throw Error("Shared table exceeds 256 addresses");
  const { VAULT_SHARED_LOOKUP_TABLE } =
    await import("../lib/solana/vault-deployment");
  const existing = VAULT_SHARED_LOOKUP_TABLE
    ? (await c.getAddressLookupTable(new PublicKey(VAULT_SHARED_LOOKUP_TABLE)))
        .value
    : null;
  const [create, newTable] = AddressLookupTableProgram.createLookupTable({
    authority: wallet.publicKey,
    payer: wallet.publicKey,
    recentSlot: (await c.getSlot()) - 1,
  });
  const table = existing?.key ?? newTable;
  const opts = { signer: keypairSigner(wallet), label: "Vault lookup table" };
  if (!existing) await sendInstructions([create], opts);
  const missing = addresses.filter(
    (k) => !existing?.state.addresses.some((a) => a.equals(k)),
  );
  for (let i = 0; i < missing.length; i += 20)
    await sendInstructions(
      [
        AddressLookupTableProgram.extendLookupTable({
          lookupTable: table,
          authority: wallet.publicKey,
          payer: wallet.publicKey,
          addresses: missing.slice(i, i + 20),
        }),
      ],
      opts,
    );
  const check = await c.getAddressLookupTable(table);
  if (
    !check.value ||
    addresses.some(
      (k) => !check.value!.state.addresses.some((a) => a.equals(k)),
    )
  )
    throw Error("Lookup table verification failed");
  writeFileSync(
    "lib/solana/vault-deployment.ts",
    `/** Shared static Vanna/oracle accounts on the hosted Surfpool fork. */\nexport const VAULT_SHARED_LOOKUP_TABLE: string = "${table.toBase58()}";\n`,
  );
  console.log(
    "Verified shared vault lookup table",
    table.toBase58(),
    addresses.length,
    "addresses",
  );
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
