import type { WalletContextState } from "@solana/wallet-adapter-react";
import type { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";

/**
 * The signing surface every service function uses. In the browser it wraps the connected
 * Wallet Standard wallet (Phantom / Backpack / Solflare); in scripts it wraps a Keypair
 * (see `keypairSigner` in tx.ts). Services only ever SIGN — broadcasting always goes through
 * the app's own fork connection, so a wallet set to mainnet/devnet can never send the
 * transaction to the wrong cluster ("Blockhash not found").
 */
export interface TxSigner {
  publicKey: PublicKey;
  signTransaction: <T extends Transaction | VersionedTransaction>(tx: T) => Promise<T>;
  signAllTransactions: <T extends Transaction | VersionedTransaction>(txs: T[]) => Promise<T[]>;
}

let externalWallet: WalletContextState | null = null;

/** Called by the SolanaProvider bridge whenever wallet-adapter state changes. */
export function setActiveSolanaWallet(wallet: WalletContextState | null) {
  externalWallet = wallet;
}

const USER_REJECTED = /user rejected|rejected the request|user denied|denied by the user|user cancel|4001/i;
/**
 * What a LOCKED extension throws when asked to sign while the dapp still holds a live
 * connection: Backpack's injected provider fails with an internal
 * "Invariant Violation: UserKeyring not found" instead of opening its unlock window.
 */
const WALLET_LOCKED = /userkeyring not found|keyring|wallet is locked|locked/i;
const UNLOCK_TIMEOUT_MS = 120_000;
const UNLOCK_POLL_MS = 1_500;

/**
 * UI hook for the unlock wait (kept as a listener so this lib module doesn't import the
 * progress modal). Called with the instruction to show while the extension is waiting for
 * its password, then with `null` once it's unlocked or the attempt ends.
 */
let unlockPromptListener: ((prompt: string | null) => void) | null = null;
export function onWalletUnlockPrompt(listener: ((prompt: string | null) => void) | null) {
  unlockPromptListener = listener;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isLockedError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return !USER_REJECTED.test(text) && WALLET_LOCKED.test(text);
}

/**
 * Runs a signing request; if the extension reports it is LOCKED, keeps the connection, tells
 * the user to unlock it (see `onWalletUnlockPrompt`), and retries every `UNLOCK_POLL_MS` until
 * it stops failing as locked. A user rejection or any other failure is rethrown untouched.
 */
async function withUnlockRetry<T>(wallet: WalletContextState, run: (w: WalletContextState) => Promise<T>): Promise<T> {
  try {
    return await run(wallet);
  } catch (error) {
    if (!isLockedError(error)) throw error;
    const name = wallet.wallet?.adapter.name ?? "Your wallet";
    unlockPromptListener?.(`${name} is locked: click the ${name} icon in your browser toolbar and enter your password to continue`);
    try {
      const deadline = Date.now() + UNLOCK_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await sleep(UNLOCK_POLL_MS);
        try {
          return await run(externalWallet ?? wallet);
        } catch (retryError) {
          if (!isLockedError(retryError)) throw retryError;
        }
      }
      throw new Error(`${name} is still locked. Unlock it from the ${name} extension icon, then retry.`);
    } finally {
      unlockPromptListener?.(null);
    }
  }
}

/** The connected browser wallet as a {@link TxSigner}. Throws when nothing is connected. */
export function getActiveSigner(): TxSigner {
  const wallet = externalWallet;
  if (!wallet?.publicKey || !wallet.connected) throw new Error("Please connect a Solana wallet first");
  if (!wallet.signTransaction || !wallet.signAllTransactions) throw new Error("The connected wallet cannot sign transactions");
  return {
    publicKey: wallet.publicKey,
    signTransaction: (tx) => withUnlockRetry(wallet, (w) => w.signTransaction!(tx)),
    signAllTransactions: (txs) => withUnlockRetry(wallet, (w) => w.signAllTransactions!(txs)),
  };
}
