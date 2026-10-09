/** Hosted-fork smoke test, fresh ephemeral wallet, no fork reset and no existing user funds. */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());
async function main() {
  const { Keypair } = await import("@solana/web3.js");
  const { fundOnFork } = await import("../lib/solana/server/fork-faucet");
  const { refreshForkPrices } =
    await import("../lib/solana/server/fork-prices");
  const { setPriceRefresher } = await import("../lib/solana/price-refresh");
  const { setExecApiBase } = await import("../lib/solana/exec");
  const { keypairSigner } = await import("../lib/solana/tx");
  const { createMarginAccount, depositAndBorrow, fetchMarginSnapshot, repay } =
    await import("../lib/solana/margin");
  const { prepareVaultAction, submitVaultAction } =
    await import("../lib/solana/vault-actions");
  const { fetchMarginHistory } = await import("../lib/solana/history");
  const { fromRaw } = await import("../lib/solana/math");
  const kp = Keypair.generate(),
    signer = keypairSigner(kp),
    opts = { signer, onStatus: (s: string) => console.log("transaction", s) };
  setExecApiBase("http://localhost:3100");
  setPriceRefresher(async () => {
    console.log("Refreshing prices");
    const r = await refreshForkPrices();
    console.log("Prices ready");
    return r;
  });
  console.log("Test wallet", kp.publicKey.toBase58());
  await fundOnFork("SOL", kp.publicKey.toBase58());
  await fundOnFork("USDC", kp.publicKey.toBase58());
  console.log("Create margin", (await createMarginAccount(opts)).address);
  console.log(
    "Deposit",
    (
      await depositAndBorrow(
        {
          deposits: [{ symbol: "USDC", amount: 100 }],
          borrows:
            process.env.E2E_VAULT_BORROW === "1"
              ? [{ symbol: "USDC", amount: 20 }]
              : [],
        },
        opts,
      )
    ).signature,
  );
  for (const id of process.argv.slice(2).length
    ? process.argv.slice(2)
    : ["perena-usdstar", "perena-junior", "basis-eth", "basis-sol"]) {
    try {
      const preview = await prepareVaultAction(id, "deposit", "10", signer);
      console.log(
        id,
        "preview",
        fromRaw(preview.shareChange, 6),
        "shares",
        "HF",
        preview.healthFactor,
      );
      console.log(id, "deposit", await submitVaultAction(preview, signer));
      const after = await fetchMarginSnapshot(kp.publicKey);
      const held = after.collateral.find(
        (c) => c.mint.toBase58() === preview.definition.mint,
      );
      if (!held || held.amountRaw <= 0n) throw Error("Receipt not in margin");
      const withdraw = await prepareVaultAction(
        id,
        "withdraw",
        fromRaw(held.amountRaw, 6),
        signer,
      );
      console.log(
        id,
        "withdraw",
        await submitVaultAction(withdraw, signer),
        "USDC",
        fromRaw(withdraw.usdcChange, 6),
      );
    } catch (e) {
      console.error(id, "FAILED", e instanceof Error ? e.message : e);
      process.exitCode = 1;
    }
  }
  if (process.env.E2E_VAULT_BORROW === "1") {
    console.log("Repaid test loan", (await repay({symbol:"USDC",all:true,source:"margin"},opts)).signature);
  }
  const history = await fetchMarginHistory(kp.publicKey);
  console.log(
    "Vault history",
    history.rows
      .filter((r) => r.vaultId)
      .map((r) => `${r.vaultId}:${r.type}`)
      .join(", "),
  );
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
