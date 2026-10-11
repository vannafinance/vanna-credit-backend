/**
 * Hosted-fork smoke test, fresh ephemeral wallet, no fork reset and no existing user funds.
 * Every deposit must be paid from the MARGIN account's USDC (SOL Basis included: its single
 * transaction routes the USDC through the wallet and returns the vbSOL to the margin), so the
 * script checks the margin USDC drop, an unchanged wallet USDC balance and the receipt landing in
 * the margin, then withdraws the margin receipt back to USDC.
 */
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
  const { fetchWalletBalances } = await import("../lib/solana/balances");
  const { getConnection } = await import("../lib/solana/connection");
  const { marginVault } = await import("../lib/solana/pdas");
  const { PublicKey } = await import("@solana/web3.js");
  const { TOKEN_PROGRAM_ID } = await import("@solana/spl-token");
  const marginUsdc = async () =>
    (await fetchMarginSnapshot(kp.publicKey)).collateral.find((c) => c.symbol === "USDC")?.amountRaw ?? 0n;
  const walletUsdc = async () => (await fetchWalletBalances(kp.publicKey)).raw.USDC ?? 0n;
  const walletReceipt = async (mint: string) => {
    const a = await getConnection().getAccountInfo(marginVault(kp.publicKey, new PublicKey(mint), TOKEN_PROGRAM_ID));
    return a && a.data.length >= 165 ? a.data.readBigUInt64LE(64) : 0n;
  };
  const { fromRaw } = await import("../lib/solana/math");
  const { ROUTED_HEALTH_MESSAGE } = await import("../lib/solana/vault-actions");
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
  const ids = process.argv.slice(2).length
    ? process.argv.slice(2)
    : ["perena-usdstar", "perena-junior", "basis-eth", "basis-sol"];
  for (const id of ids) {
    try {
      // SOL Basis takes the USDC out of the margin before the vault deposit: with the test loan,
      // depositing 100 of the 120 margin USDC must be refused by the health check (simulation only).
      if (id === "basis-sol" && process.env.E2E_VAULT_BORROW === "1") {
        const refused = await prepareVaultAction(id, "deposit", "100", signer).then(
          () => "not refused",
          (e: unknown) => (e instanceof Error ? e.message : String(e)),
        );
        if (refused !== ROUTED_HEALTH_MESSAGE) throw Error(`Unhealthy deposit not refused clearly: ${refused}`);
        console.log(id, "unhealthy 100 USDC deposit refused before signing");
      }
      const [usdcBefore, walletBefore] = await Promise.all([marginUsdc(), walletUsdc()]);
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
      const [usdcAfter, walletAfter] = await Promise.all([marginUsdc(), walletUsdc()]);
      if (usdcBefore - usdcAfter !== 10_000_000n)
        throw Error(`Margin USDC changed by ${fromRaw(usdcBefore - usdcAfter, 6)}, expected 10`);
      if (walletAfter !== walletBefore) throw Error("Deposit touched wallet USDC");
      if (preview.walletRouted)
        console.log(id, "moved to margin", fromRaw(preview.movedShares, 6), "left in wallet", fromRaw(await walletReceipt(preview.definition.mint), 6));
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
  const vaultRows = history.rows.filter((r) => r.vaultId).map((r) => `${r.vaultId}:${r.type}`);
  console.log("Vault history", vaultRows.join(", "));
  for (const id of ids)
    for (const type of ["farm-deposit", "farm-withdraw"])
      if (!vaultRows.includes(`${id}:${type}`)) {
        console.error(id, "MISSING history row", type);
        process.exitCode = 1;
      }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
