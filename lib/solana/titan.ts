import { fetchWithTimeout } from "../async";
/**
 * Titan (aggregator) swaps for the Spot page — from the WALLET and from the MARGIN account.
 *
 * Quotes come from the app's server route `/api/titan/quote` (it holds TITAN_API_KEY); Titan returns
 * ready-to-sign instructions with each quote.
 *
 * - Wallet: Titan's instructions are signed by the wallet as they are (fork blockhash swapped in,
 *   stale cloned pools healed and the simulation retried, as for Jupiter).
 * - Margin: Titan's `swap_route_v3` runs through `margin_execute` (port of vanna-credit-layer
 *   `scripts/src/titan.ts`). The validator allows only that instruction, config 3 (keep the input
 *   account open, keep wSOL output as wSOL), no provider fee, the margin as payer and user, and caps
 *   the spend at the routed amount; Titan's own minimum out is the slippage bound. The margin can't
 *   pay rent, so the wallet first creates any of Titan's atlas token accounts the route needs.
 */
import { Buffer } from "buffer";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AccountMeta,
  type AddressLookupTableAccount,
} from "@solana/web3.js";
import { getConnection } from "./connection";
import { broadcastSignedTransaction } from "./broadcast";
import { decodeProgramError, VannaTxError } from "./errors";
import { healStaleDexPools } from "./fork-heal";
import { appApiBase, EXEC_COMPUTE_UNITS, marginExecuteIx, type MarginSwapRequest } from "./exec";
import { assetFor, loadContext, type MarginServiceOptions, type MarginTxResult } from "./margin";
import { ensureFreshPrices } from "./price-refresh";
import { getToken } from "./tokens";
import { fromRaw, toRaw } from "./math";
import { sendInstructions } from "./tx";
import { getActiveSigner, type TxSigner } from "./wallet-bridge";
import { marginPda } from "./pdas";

export const TITAN_PROGRAM_ID = new PublicKey("T1TANpTeScyeqVzzgNViGDNrkQ6qHz9KrSBS4aNXvGT");
/** Titan's atlas: the PDA owning the intermediate token accounts its routes use. */
export const TITAN_ATLAS = PublicKey.findProgramAddressSync([Buffer.from("atlas")], TITAN_PROGRAM_ID)[0];

const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const SWAP_ROUTE_V3 = 42;
const KEEP_INPUT_ACCOUNT = 2;
/** KEEP_OUTPUT_WSOL | KEEP_INPUT_ACCOUNT — the only config the Vanna validator allows. */
const MARGIN_CONFIG = 3;
const FIXED_ACCOUNT_COUNT = 12;

export interface TitanInstruction {
  p: string;
  a: { p: string; s: boolean; w: boolean }[];
  d: string;
}

/** A Titan quote as returned by `/api/titan/quote` (with its instructions). */
export interface TitanQuote {
  provider: string;
  inAmount: string;
  outAmount: string;
  slippageBps: number;
  instructions: TitanInstruction[];
  addressLookupTables: string[];
  labels: string[];
  /** Each hop / split leg (venue, input / output mint, share of the input in %). */
  steps?: { label: string; inputMint: string; outputMint: string; percent: number }[];
}

/** Thrown when the server has no TITAN_API_KEY: callers fall back to Jupiter quietly. */
export class TitanUnavailableError extends Error {}

export async function fetchTitanQuote(params: {
  inputMint: string;
  outputMint: string;
  amount: string | number | bigint;
  userPublicKey: string;
  slippageBps?: number;
  mode: "wallet" | "margin";
}): Promise<TitanQuote> {
  const qs = new URLSearchParams({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: String(params.amount),
    userPublicKey: params.userPublicKey,
    slippageBps: String(params.slippageBps ?? 50),
    mode: params.mode,
  });
  const res = await fetchWithTimeout(`${appApiBase()}/api/titan/quote?${qs}`);
  const body = await res.json().catch(() => ({}));
  if (res.status === 503) throw new TitanUnavailableError(body?.error ?? "Titan is not configured");
  if (!res.ok || body?.error) throw new Error(body?.error ?? "Titan quote failed");
  return body as TitanQuote;
}

const toInstruction = (ix: TitanInstruction): TransactionInstruction =>
  new TransactionInstruction({
    programId: new PublicKey(ix.p),
    keys: ix.a.map((a) => ({ pubkey: new PublicKey(a.p), isSigner: a.s, isWritable: a.w })),
    data: Buffer.from(ix.d, "base64"),
  });

async function loadLookupTables(addresses: string[]): Promise<AddressLookupTableAccount[]> {
  const connection = getConnection();
  const tables = await Promise.all(addresses.map((a) => connection.getAddressLookupTable(new PublicKey(a))));
  return tables.map((t) => t.value).filter((t): t is AddressLookupTableAccount => t !== null);
}

/** Execute a Titan swap from the user's WALLET. */
export async function executeWalletTitanSwap(quote: TitanQuote, opts: { signer?: TxSigner; onStatus?: (status: string) => void } = {}): Promise<string> {
  const signer = opts.signer ?? getActiveSigner();
  const connection = getConnection();
  const tables = await loadLookupTables(quote.addressLookupTables);
  let latest = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({ payerKey: signer.publicKey, recentBlockhash: latest.blockhash, instructions: quote.instructions.map(toInstruction) }).compileToV0Message(tables);
  const tx = new VersionedTransaction(message);
  opts.onStatus?.("simulating");
  const simulate = () => connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
  let simulation = await simulate();
  if (simulation.value.err) {
    const healed = await healStaleDexPools(connection, tx);
    if (healed > 0) simulation = await simulate();
  }
  if (simulation.value.err) {
    const logs = simulation.value.logs ?? [];
    const raw = `Titan swap simulation failed: ${JSON.stringify(simulation.value.err)}\n${logs.join("\n")}`;
    const decoded = decodeProgramError(raw);
    throw new VannaTxError(decoded?.message ?? raw.split("\n")[0], { logs, raw, code: decoded?.name });
  }
  latest = await connection.getLatestBlockhash("confirmed");
  tx.message.recentBlockhash = latest.blockhash;
  opts.onStatus?.("signing");
  const signed = await signer.signTransaction(tx);
  opts.onStatus?.("sending");
  return broadcastSignedTransaction(connection, signed, latest.lastValidBlockHeight,
    { skipPreflight: true, maxRetries: 3 }, () => opts.onStatus?.("confirming"));
}

/** Exact-input Titan quote for a margin swap (built for the margin PDA, Titan's router only). */
export function quoteMarginTitanSwap(req: MarginSwapRequest, owner: PublicKey): Promise<TitanQuote> {
  const from = getToken(req.fromSymbol);
  const to = getToken(req.toSymbol);
  return fetchTitanQuote({
    inputMint: from.mint.toBase58(),
    outputMint: to.mint.toBase58(),
    amount: toRaw(req.amount, from.decimals),
    userPublicKey: marginPda(owner).toBase58(),
    slippageBps: req.slippageBps,
    mode: "margin",
  });
}

/** The route's one Titan swap, checked against what the Vanna validator allows. */
function marginSwapCall(quote: TitanQuote, margin: PublicKey): { data: Buffer; accounts: AccountMeta[] } {
  const swaps = quote.instructions.filter((ix) => ix.p !== COMPUTE_BUDGET);
  if (swaps.length !== 1 || swaps[0].p !== TITAN_PROGRAM_ID.toBase58()) {
    throw new Error("Titan returned a route a margin account can't run (one Titan swap instruction only) — try Jupiter or another amount");
  }
  const data = Buffer.from(swaps[0].d, "base64");
  if (data[0] !== SWAP_ROUTE_V3) throw new Error("Titan returned a route type the margin adapter doesn't allow");
  // The config byte is two flags (KEEP_OUTPUT_WSOL = 1, KEEP_INPUT_ACCOUNT = 2) that only decide
  // whether wSOL accounts get closed; Titan picks them per pair (config 1 for a SOL input, 2 for a
  // SOL output) regardless of the request. The margin's vaults must never be closed, so any flag
  // combination is forced to both flags — the one config the Vanna validator allows.
  if ((data[1] & ~MARGIN_CONFIG) !== 0) throw new Error(`Titan route config ${data[1]} isn't allowed for a margin account`);
  data[1] = MARGIN_CONFIG;
  const accounts = swaps[0].a.map((a) => ({ pubkey: new PublicKey(a.p), isSigner: false, isWritable: a.w }));
  if (accounts.length < FIXED_ACCOUNT_COUNT || !accounts[0].pubkey.equals(margin) || !accounts[1].pubkey.equals(margin)) {
    throw new Error("Titan route is not built for the margin account as payer and user");
  }
  return { data, accounts };
}

/** Titan's atlas token accounts the route uses that don't exist yet (the wallet creates them). */
async function missingAtlasAccounts(payer: PublicKey, accounts: AccountMeta[], mints: number): Promise<TransactionInstruction[]> {
  const atlasAccounts = accounts.slice(FIXED_ACCOUNT_COUNT, FIXED_ACCOUNT_COUNT + mints).map((a) => a.pubkey);
  const mintKeys = accounts.slice(FIXED_ACCOUNT_COUNT + mints, FIXED_ACCOUNT_COUNT + 2 * mints).map((a) => a.pubkey);
  if (atlasAccounts.length === 0) return [];
  const infos = await getConnection().getMultipleAccountsInfo([...atlasAccounts, ...mintKeys]);
  const created: TransactionInstruction[] = [];
  atlasAccounts.forEach((account, i) => {
    const mint = infos[mints + i];
    if (infos[i] || !mint) return;
    if (!getAssociatedTokenAddressSync(mintKeys[i], TITAN_ATLAS, true, mint.owner).equals(account)) return;
    created.push(createAssociatedTokenAccountIdempotentInstruction(payer, account, TITAN_ATLAS, mintKeys[i], mint.owner));
  });
  return created;
}

/** Swaps collateral inside the margin account through Titan. */
export async function executeMarginTitanSwap(req: MarginSwapRequest, quote: TitanQuote, opts: MarginServiceOptions = {}): Promise<MarginTxResult> {
  const signer = opts.signer ?? getActiveSigner();
  const from = getToken(req.fromSymbol);
  const to = getToken(req.toSymbol);
  if (from.symbol === to.symbol) throw new Error("Pick two different tokens");
  await ensureFreshPrices();
  const ctx = await loadContext(signer.publicKey);
  if (!ctx.snapshot.exists) throw new Error("Create a margin account first");
  const spent = assetFor(ctx.assetMap, from);
  const received = assetFor(ctx.assetMap, to);
  const amount = toRaw(req.amount, from.decimals);
  const held = ctx.snapshot.collateral.find((c) => c.assetIndex === spent.assetIndex)?.amountRaw ?? 0n;
  if (amount <= 0n) throw new Error("Enter an amount");
  if (amount > held) throw new Error(`Your margin account holds only ${fromRaw(held, from.decimals)} ${from.symbol}`);

  const call = marginSwapCall(quote, ctx.margin);
  ctx.instructions.push(...(await missingAtlasAccounts(ctx.owner, call.accounts, call.data[20])));
  const ix = await marginExecuteIx(ctx, {
    target: TITAN_PROGRAM_ID,
    data: call.data,
    cpiAccounts: call.accounts,
    token: { spent, received, expectedSpent: amount, expectedReceived: BigInt(quote.outAmount) },
  });
  const signature = await sendInstructions([...ctx.instructions, ix], {
    signer,
    label: `Swap ${from.symbol} → ${to.symbol} (Titan)`,
    computeUnits: EXEC_COMPUTE_UNITS,
    lookupTables: await loadLookupTables(quote.addressLookupTables),
    onStatus: opts.onStatus as never,
  });
  return { signature };
}
