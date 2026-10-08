/** Read-only latency probe. No signatures, transactions, faucet, or fork writes. */
import { loadEnvConfig } from "@next/env";

async function main() {
  loadEnvConfig(process.cwd(), true);
  const { PublicKey } = await import("@solana/web3.js");
  const { getConnection } = await import("../lib/solana/connection");
  const { fetchWalletBalances } = await import("../lib/solana/balances");
  const { fetchPoolStates } = await import("../lib/solana/protocol-state");
  const { fetchMarginSnapshot } = await import("../lib/solana/margin");
  const { readOnchainPrices } = await import("../lib/solana/prices");
  const owner = new PublicKey(process.argv[2] ?? PublicKey.default.toBase58());
  const connection = getConnection();
  console.log(`Read-only probe: RPC host ${new URL(connection.rpcEndpoint).hostname}`);
  async function measure(name: string, run: () => Promise<unknown>) {
    const started = performance.now();
    try {
      await run();
      console.log(`${name}: ok, ${Math.round(performance.now() - started)} ms`);
    } catch (error) {
      // Provider error messages can contain keyed URLs. Print only the error class.
      console.log(`${name}: failed (${error instanceof Error ? error.name : "Error"}), ${Math.round(performance.now() - started)} ms`);
      process.exitCode = 1;
    }
  }
  await Promise.all([
    measure("pools", () => fetchPoolStates(connection)),
    measure("prices", () => readOnchainPrices(connection)),
    measure("wallet", () => fetchWalletBalances(owner, connection)),
    measure("margin", () => fetchMarginSnapshot(owner)),
  ]);
}
main().catch(() => { console.error("Probe could not start. Check environment and wallet address."); process.exitCode = 1; });
