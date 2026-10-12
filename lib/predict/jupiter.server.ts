/**
 * Jupiter (server only) for Predict: CASH ⇄ USDC routes restricted to Manifest, as the
 * outcome_yield_pool code requires on the fork (other CASH/USDC venues have fork state that drifts
 * from what Jupiter's mainnet-quoted route expects, "Invalid account owner" mid-swap; Manifest is
 * verified to work there). Uses the app's keyed Jupiter API when JUPITER_API_KEY is set.
 */
import { PublicKey, TransactionInstruction, type AddressLookupTableAccount, type Connection } from "@solana/web3.js";
import { jupiterBaseUrl, jupiterHeaders } from "@/lib/solana/server/jupiter-api";

interface RawIx {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
}

export interface JupiterQuote {
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  [k: string]: unknown;
}

export interface JupiterSwap {
  setup: TransactionInstruction[];
  swap: TransactionInstruction;
  /** The route instruction as raw parts (outcome_yield_pool passes data + accounts to its CPI). */
  swapData: Buffer;
  swapAccounts: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[];
  cleanup: TransactionInstruction[];
  lookupTables: AddressLookupTableAccount[];
}

const toIx = (ix: RawIx) =>
  new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(ix.data, "base64"),
  });

async function jupiter<T>(path: string, init?: RequestInit): Promise<T> {
  let last: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${jupiterBaseUrl()}${path}`, { ...init, headers: jupiterHeaders({ "content-type": "application/json", ...(init?.headers as Record<string, string>) }), signal: AbortSignal.timeout(15_000) });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (res.ok && !body.error) return body;
    last = new Error(`Jupiter ${path.split("?")[0]} failed: ${body.error ?? res.status}`);
    if (res.status !== 429 && res.status < 500) break;
    await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
  }
  throw last!;
}

/** ExactIn quote restricted to Manifest. */
export function manifestQuote(inputMint: string, outputMint: string, amountRaw: bigint, slippageBps = 50): Promise<JupiterQuote> {
  return jupiter<JupiterQuote>(`/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${slippageBps}&dexes=Manifest`);
}

/** Swap instructions for `user` (a wallet, or a pool PDA that signs the route by CPI). */
export async function swapInstructions(connection: Connection, quote: JupiterQuote, user: PublicKey, destinationTokenAccount?: PublicKey): Promise<JupiterSwap> {
  const body = await jupiter<{
    setupInstructions?: RawIx[];
    swapInstruction: RawIx;
    cleanupInstruction?: RawIx | null;
    addressLookupTableAddresses?: string[];
  }>("/swap/v1/swap-instructions", {
    method: "POST",
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: user.toBase58(),
      ...(destinationTokenAccount ? { destinationTokenAccount: destinationTokenAccount.toBase58() } : {}),
      wrapAndUnwrapSol: false,
    }),
  });
  const lookupTables: AddressLookupTableAccount[] = [];
  for (const addr of body.addressLookupTableAddresses ?? []) {
    const res = await connection.getAddressLookupTable(new PublicKey(addr));
    if (res.value) lookupTables.push(res.value);
  }
  const swap = toIx(body.swapInstruction);
  return {
    setup: (body.setupInstructions ?? []).map(toIx),
    swap,
    swapData: Buffer.from(body.swapInstruction.data, "base64"),
    swapAccounts: swap.keys.map((k) => ({ pubkey: k.pubkey, isSigner: false, isWritable: k.isWritable })),
    cleanup: body.cleanupInstruction ? [toIx(body.cleanupInstruction)] : [],
    lookupTables,
  };
}

const TOKEN_PROGRAMS = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);

/**
 * Re-clones a route's accounts fresh from mainnet (`surfnet_resetAccount`), skipping everything in
 * `protect` and every token account OWNED by a protected owner (wallets, pools, the maker). None of
 * those exist on mainnet, so a reset would wipe them — a real past bug (a failed merge wiped
 * `pool_usdc`). Best effort: errors are swallowed; the caller's retry is the fallback.
 */
export async function healRouteAccounts(connection: Connection, rpcUrl: string, keys: PublicKey[], protect: Set<string>, protectOwners: Set<string>): Promise<number> {
  const candidates = [...new Set(keys.map((k) => k.toBase58()))].filter((k) => !protect.has(k) && !protectOwners.has(k));
  const infos = await connection.getMultipleAccountsInfo(candidates.map((k) => new PublicKey(k)), "confirmed").catch(() => candidates.map(() => null));
  const safe = candidates.filter((k, i) => {
    const info = infos[i];
    if (!info) return true;
    if (info.executable) return false;
    if (TOKEN_PROGRAMS.has(info.owner.toBase58()) && info.data.length >= 64) {
      const owner = new PublicKey(info.data.subarray(32, 64)).toBase58();
      if (protectOwners.has(owner)) return false;
    }
    return true;
  });
  await Promise.all(
    safe.map((k) =>
      fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "surfnet_resetAccount", params: [k] }),
      }).catch(() => null),
    ),
  );
  return safe.length;
}
