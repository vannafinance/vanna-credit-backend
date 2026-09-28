// Server-side only: Surfpool fork faucet. SPL tokens via `surfnet_setTokenAccount`, SOL via
// `surfnet_setAccount` lamports. The cheatcodes SET balances, so top-up semantics are
// new balance = current + faucet amount.
import { Connection, PublicKey } from "@solana/web3.js";
import { SOLANA_RPC_URL } from "../config";
import { walletAta } from "../pdas";
import { tokenAccountAmount } from "../protocol-state";
import { getToken } from "../tokens";
import { fromRaw } from "../math";
import { callCheatcode } from "./cheatcodes";

export interface FaucetResult {
  symbol: string;
  recipient: string;
  added: string;
  balance: string;
}

export async function fundOnFork(symbol: string, recipient: string, rpcUrl: string = SOLANA_RPC_URL): Promise<FaucetResult> {
  const token = getToken(symbol);
  const owner = new PublicKey(recipient);
  const connection = new Connection(rpcUrl, "confirmed");
  const addRaw = BigInt(token.faucetAmount) * 10n ** BigInt(token.decimals);

  if (token.isNative) {
    const account = await connection.getAccountInfo(owner, "confirmed");
    const next = BigInt(account?.lamports ?? 0) + addRaw;
    // Keep the account's existing owner/data (a plain wallet is system-owned, empty data).
    await callCheatcode("surfnet_setAccount", [owner.toBase58(), { lamports: Number(next) }]);
    return { symbol: token.symbol, recipient, added: fromRaw(addRaw, 9), balance: fromRaw(next, 9) };
  }

  const ata = walletAta(owner, token.mint, token.tokenProgram);
  const info = await connection.getAccountInfo(ata, "confirmed");
  const current = tokenAccountAmount(info, token.tokenProgram);
  const next = current + addRaw;
  await callCheatcode("surfnet_setTokenAccount", [
    owner.toBase58(),
    token.mint.toBase58(),
    { amount: Number(next) },
    token.tokenProgram.toBase58(),
  ]);
  return { symbol: token.symbol, recipient, added: fromRaw(addRaw, token.decimals), balance: fromRaw(next, token.decimals) };
}
