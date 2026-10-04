/**
 * `margin_execute` — the margin account calling a whitelisted outside program (Jupiter swaps,
 * Kamino Lend supply / redeem, GMTrade perps). The integration's VALIDATOR reviews the call (which
 * call account is the margin, which margin vaults are spent / received) before Vanna signs it, and
 * the account is health-checked after it (Frontend Integration Guide, "External calls").
 *
 * Accounts: authority, protocol_config, margin_account, integration ["integration", target],
 * target_program, validator, venue_asset + venue_account (GMTrade only, else null).
 * Args: data (the outside instruction's data), call_account_count, new_assets.
 * remaining_accounts, in order:
 *   1. the outside instruction's accounts (none a signer: Vanna signs as the margin / venue account);
 *   2. EVERY position group, in slot order;
 *   3. one `[asset_config, margin vault]` group per token received for the first time (new_assets);
 *   4. the oracle segment (price accounts of every holding and every new token);
 *   5. the validator segment, only when it needs accounts: GMTrade `[vanna_validator, market_book]`.
 * The receiving margin vault is created (idempotent ATA) before the call; Vanna doesn't create it.
 * Vanna sets no minimum output: slippage protection is the outside program's (Jupiter's min out).
 */
import { Buffer } from "buffer";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { PublicKey, type AccountMeta, type AddressLookupTableAccount, type TransactionInstruction } from "@solana/web3.js";
import { JUPITER_V6_PROGRAM_ID, VALIDATOR_PROGRAM_ID } from "./config";
import { getConnection } from "./connection";
import { getProgram } from "./program";
import { integrationPda, marginVault, protocolConfigPda } from "./pdas";
import type { AssetConfigState } from "./protocol-state";
import {
  appendBorrows,
  appendDeposits,
  assetFor,
  buildHealthRemainingAccounts,
  loadContext,
  type AmountItem,
  type BatchContext,
  type MarginServiceOptions,
  type MarginTxResult,
} from "./margin";
import { getToken } from "./tokens";
import { fromRaw, toRaw } from "./math";
import { sendInstructions } from "./tx";
import { getActiveSigner } from "./wallet-bridge";
import { ensureFreshPrices } from "./price-refresh";
import { fetchJupiterQuote, type JupiterQuote } from "./swap";
import {
  CTOKEN_DECIMALS,
  KLEND_PROGRAM_ID,
  kaminoCallAccounts,
  kaminoCallData,
  readReserveRate,
  receiptForUnderlying,
  receiptsForUnderlying,
  underlyingForReceipts,
  type KaminoReceipt,
} from "./kamino";
import { venueAccountOf } from "./perps-accounts";

/** Kamino / Jupiter use 1,000,000 in the guide, GMTrade orders 1,400,000; one budget for all. */
export const EXEC_COMPUTE_UNITS = 1_400_000;

function findAssetByMint(ctx: BatchContext, mint: PublicKey): AssetConfigState {
  for (const a of ctx.assetMap.values()) if (a.mint.equals(mint)) return a;
  throw new Error(`${mint.toBase58()} is not registered with the protocol`);
}

const readonly = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });

export interface ExecCall {
  target: PublicKey;
  data: Buffer;
  cpiAccounts: AccountMeta[];
  /** The validator segment's accounts after the program (GMTrade: `[market_book]`). */
  validatorAccounts?: PublicKey[];
  /** A token call: what it spends / receives (new-asset group, model replay). */
  token?: { spent: AssetConfigState; received: AssetConfigState; expectedSpent: bigint; expectedReceived: bigint };
  /** A GMTrade call: the venue asset, the market leg it targets, whether it opens it, the USDC vault. */
  venue?: { asset: AssetConfigState; leg: number | null; opensLeg: boolean; settleAsset: AssetConfigState };
}

/**
 * Builds one `margin_execute` against the batch context's CURRENT index model (so it composes after
 * deposits / borrows in the same transaction) and replays its effect on the model. The receiving
 * vault's idempotent ATA create is pushed onto `ctx.instructions`.
 */
export async function marginExecuteIx(ctx: BatchContext, call: ExecCall): Promise<TransactionInstruction> {
  const extraGroups: AccountMeta[] = [];
  const priced: AssetConfigState[] = [];
  const writable: PublicKey[] = [];
  let newAssets = 0;
  if (call.token) {
    const { spent, received } = call.token;
    if (!ctx.model.collateral.includes(spent.assetIndex)) throw new Error("The asset to spend is not active collateral in your margin account");
    if (!received.collateralEnabled) throw new Error("The asset to receive is not enabled as collateral");
    const receivedVault = marginVault(ctx.margin, received.mint, received.tokenProgram);
    ctx.instructions.push(createAssociatedTokenAccountIdempotentInstruction(ctx.owner, receivedVault, ctx.margin, received.mint, received.tokenProgram));
    priced.push(spent, received);
    if (!ctx.model.collateral.includes(received.assetIndex)) {
      extraGroups.push(readonly(received.address), readonly(receivedVault));
      newAssets = 1;
    }
  }
  let venueScan;
  if (call.venue) {
    if (!ctx.venueBook) throw new Error("GMTrade market book not loaded");
    // The margin USDC vault funds the order, so it is writable; the target market's accounts join
    // the oracle segment even before its leg is open (the guide's `venueLegs: legBit(leg)`).
    writable.push(marginVault(ctx.margin, call.venue.settleAsset.mint, call.venue.settleAsset.tokenProgram));
    priced.push(call.venue.settleAsset);
    venueScan = { book: ctx.venueBook, extraLegs: call.venue.leg === null ? 0n : 1n << BigInt(call.venue.leg), always: true };
  } else if (ctx.venueBook) {
    venueScan = { book: ctx.venueBook };
  }
  const health = buildHealthRemainingAccounts(ctx.margin, ctx.model, ctx.assetMap, {}, priced, { venue: venueScan, writable, extraGroups });
  const validatorSegment = call.validatorAccounts ? [readonly(VALIDATOR_PROGRAM_ID), ...call.validatorAccounts.map(readonly)] : [];
  const cpi = call.cpiAccounts.map((a) => ({ ...a, isSigner: false }));
  const ix = await getProgram()
    .methods.marginExecute(call.data, cpi.length, newAssets)
    .accountsStrict({
      authority: ctx.owner,
      protocolConfig: protocolConfigPda(),
      marginAccount: ctx.margin,
      integration: integrationPda(call.target),
      targetProgram: call.target,
      validator: VALIDATOR_PROGRAM_ID,
      venueAsset: call.venue ? call.venue.asset.address : null,
      venueAccount: call.venue ? venueAccountOf(ctx.margin) : null,
    } as any)
    .remainingAccounts([...cpi, ...health, ...validatorSegment])
    .instruction();
  if (call.token) {
    const t = call.token;
    ctx.model.execute(t.spent.assetIndex, t.expectedSpent, t.received.assetIndex, t.expectedReceived);
  }
  if (call.venue) ctx.model.venueCall(call.venue.asset.assetIndex, call.venue.opensLeg ? call.venue.leg : null);
  return ix;
}

async function loadLookupTables(addresses: string[]): Promise<AddressLookupTableAccount[]> {
  const connection = getConnection();
  const tables = await Promise.all(addresses.map((a) => connection.getAddressLookupTable(new PublicKey(a))));
  return tables.map((t) => t.value).filter((t): t is AddressLookupTableAccount => t !== null);
}

// ---------------------------------------------------------------------------------------------
// Jupiter — margin-account swaps
// ---------------------------------------------------------------------------------------------

/** sha256("global:route")[0..8] / sha256("global:shared_accounts_route")[0..8] — what the adapter allows. */
const JUPITER_ALLOWED_SELECTORS = new Set([
  Buffer.from([229, 23, 203, 151, 122, 227, 173, 42]).toString("hex"),
  Buffer.from([193, 32, 155, 51, 65, 214, 156, 129]).toString("hex"),
]);

let apiBase = "";
/** Scripts (e2e) set an absolute origin for the app's API routes; the browser uses "". */
export function setExecApiBase(base: string) {
  apiBase = base.replace(/\/$/, "");
}
/** The app's API origin ("" in the browser). */
export const appApiBase = () => apiBase;

export interface MarginSwapRequest {
  fromSymbol: string;
  toSymbol: string;
  /** UI amount of `fromSymbol` spent from the margin vault. */
  amount: string | number;
  slippageBps: number;
}

/**
 * Route size budget for a margin swap. `margin_execute` carries the route's accounts plus every
 * position group and the agent segments, and the core program runs out of heap ("memory allocation
 * failed") on long routes, so ask Jupiter for a shorter one (the guide's `maxAccounts` advice).
 */
const MARGIN_SWAP_MAX_ACCOUNTS = 20;

/** Exact-input quote for a margin swap (same routing as wallet swaps, shorter routes). */
export function quoteMarginSwap(req: MarginSwapRequest): Promise<JupiterQuote> {
  const from = getToken(req.fromSymbol);
  const to = getToken(req.toSymbol);
  return fetchJupiterQuote({
    inputMint: from.mint.toBase58(),
    outputMint: to.mint.toBase58(),
    amount: toRaw(req.amount, from.decimals),
    slippageBps: req.slippageBps,
    maxAccounts: MARGIN_SWAP_MAX_ACCOUNTS,
  });
}

/**
 * Swaps collateral inside the margin account through Jupiter. The route is built with the margin
 * PDA as `userPublicKey` (no SOL wrap, shared accounts → no intermediate user accounts), only the
 * swap instruction is wrapped; Jupiter's own minimum out is the slippage floor.
 */
export async function executeMarginSwap(req: MarginSwapRequest, quote: JupiterQuote, opts: MarginServiceOptions = {}): Promise<MarginTxResult> {
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

  const res = await fetch(`${apiBase}/api/jupiter/swap-instructions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: ctx.margin.toBase58(),
      wrapAndUnwrapSol: false,
      useSharedAccounts: true,
    }),
  });
  const body = await res.json();
  if (!res.ok || !body?.swapInstruction) throw new Error(body?.error ?? "Jupiter could not build the swap");
  const swapIx = body.swapInstruction as { programId: string; accounts: { pubkey: string; isWritable: boolean }[]; data: string };
  if (swapIx.programId !== JUPITER_V6_PROGRAM_ID.toBase58()) throw new Error(`Unexpected swap program ${swapIx.programId}`);
  const data = Buffer.from(swapIx.data, "base64");
  if (!JUPITER_ALLOWED_SELECTORS.has(data.subarray(0, 8).toString("hex"))) {
    throw new Error("Jupiter returned a route type the margin adapter doesn't allow — try a different amount");
  }

  // The route carries Jupiter's own minimum out (otherAmountThreshold); Vanna adds no second check.
  const ix = await marginExecuteIx(ctx, {
    target: JUPITER_V6_PROGRAM_ID,
    data,
    cpiAccounts: swapIx.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: false, isWritable: a.isWritable })),
    token: { spent, received, expectedSpent: amount, expectedReceived: BigInt(quote.outAmount) },
  });
  const signature = await sendInstructions([...ctx.instructions, ix], {
    signer,
    label: `Swap ${from.symbol} → ${to.symbol}`,
    computeUnits: EXEC_COMPUTE_UNITS,
    lookupTables: await loadLookupTables((body.addressLookupTableAddresses as string[]) ?? []),
    onStatus: opts.onStatus as never,
  });
  return { signature };
}

// ---------------------------------------------------------------------------------------------
// Kamino Lend — single-asset Farm vaults (supply from the margin account, optionally leveraged)
// ---------------------------------------------------------------------------------------------

async function readRate(r: KaminoReceipt) {
  const info = await getConnection().getAccountInfo(r.reserve);
  if (!info) throw new Error(`Kamino ${r.underlying} reserve not found on the fork`);
  return readReserveRate(info.data, r.collateralMint);
}

export interface FarmDepositRequest {
  /** Registry symbol of the asset to supply to Kamino. */
  symbol: string;
  /** Deposited from the wallet into the margin account first (UI units). */
  walletAmount?: string | number;
  /** Already in the margin account, supplied as-is (UI units). */
  marginAmount?: string | number;
  /** Borrowed from Vanna's pool for leverage (UI units). */
  borrowAmount?: string | number;
}

/**
 * ONE transaction: [deposit from wallet] → [borrow] → `margin_execute` Kamino
 * `deposit_reserve_liquidity` of (wallet + margin + borrowed) amount. The cTokens stay in the
 * margin account as collateral.
 */
export async function farmDeposit(req: FarmDepositRequest, opts: MarginServiceOptions = {}): Promise<MarginTxResult> {
  const signer = opts.signer ?? getActiveSigner();
  const token = getToken(req.symbol);
  const r = receiptForUnderlying(token.symbol);
  if (!r) throw new Error(`No Kamino vault for ${token.symbol}`);
  const walletRaw = toRaw(req.walletAmount ?? 0, token.decimals);
  const marginRaw = toRaw(req.marginAmount ?? 0, token.decimals);
  const borrowRaw = toRaw(req.borrowAmount ?? 0, token.decimals);
  const total = walletRaw + marginRaw + borrowRaw;
  if (total <= 0n) throw new Error("Enter an amount");

  await ensureFreshPrices();
  const ctx = await loadContext(signer.publicKey);
  if (!ctx.snapshot.exists) throw new Error("Create a margin account first");
  const underlying = assetFor(ctx.assetMap, token);
  const receiptAsset = findAssetByMint(ctx, r.collateralMint);
  if (marginRaw > 0n) {
    const held = ctx.snapshot.collateral.find((c) => c.assetIndex === underlying.assetIndex)?.amountRaw ?? 0n;
    if (marginRaw > held) throw new Error(`Your margin account holds only ${fromRaw(held, token.decimals)} ${token.symbol}`);
  }
  const deposits: AmountItem[] = walletRaw > 0n ? [{ symbol: token.symbol, amount: fromRaw(walletRaw, token.decimals) }] : [];
  const borrows: AmountItem[] = borrowRaw > 0n ? [{ symbol: token.symbol, amount: fromRaw(borrowRaw, token.decimals) }] : [];
  await appendDeposits(ctx, deposits);
  await appendBorrows(ctx, borrows);

  const rate = await readRate(r);
  const expectedReceipts = receiptsForUnderlying(rate, total);
  const cpiAccounts = kaminoCallAccounts(
    "deposit",
    r,
    ctx.margin,
    marginVault(ctx.margin, underlying.mint, underlying.tokenProgram),
    marginVault(ctx.margin, receiptAsset.mint, receiptAsset.tokenProgram),
  );
  const ix = await marginExecuteIx(ctx, {
    target: KLEND_PROGRAM_ID,
    data: kaminoCallData("deposit", total),
    cpiAccounts,
    token: { spent: underlying, received: receiptAsset, expectedSpent: total, expectedReceived: expectedReceipts },
  });
  const signature = await sendInstructions([...ctx.instructions, ix, ...ctx.suffix], {
    signer,
    label: `Farm ${token.symbol} on Kamino`,
    computeUnits: EXEC_COMPUTE_UNITS,
    onStatus: opts.onStatus as never,
  });
  return { signature };
}

export interface FarmWithdrawRequest {
  symbol: string;
  /** cTokens to redeem (UI units, 6 decimals); omit with `all` to redeem everything. */
  receipts?: string | number;
  all?: boolean;
}

/**
 * `margin_execute` Kamino `redeem_reserve_collateral`: cTokens → underlying, back into the margin
 * account (repay / withdraw from the Margin page afterwards).
 */
export async function farmWithdraw(req: FarmWithdrawRequest, opts: MarginServiceOptions = {}): Promise<MarginTxResult & { underlying: string }> {
  const signer = opts.signer ?? getActiveSigner();
  const token = getToken(req.symbol);
  const r = receiptForUnderlying(token.symbol);
  if (!r) throw new Error(`No Kamino vault for ${token.symbol}`);
  await ensureFreshPrices();
  const ctx = await loadContext(signer.publicKey);
  const underlying = assetFor(ctx.assetMap, token);
  const receiptAsset = findAssetByMint(ctx, r.collateralMint);
  const held = ctx.snapshot.collateral.find((c) => c.assetIndex === receiptAsset.assetIndex)?.amountRaw ?? 0n;
  const amount = req.all ? held : toRaw(req.receipts ?? 0, CTOKEN_DECIMALS);
  if (amount <= 0n) throw new Error("Nothing to withdraw");
  if (amount > held) throw new Error(`You hold only ${fromRaw(held, CTOKEN_DECIMALS)} ${r.symbol}`);

  const rate = await readRate(r);
  const expected = underlyingForReceipts(rate, amount);
  const cpiAccounts = kaminoCallAccounts(
    "redeem",
    r,
    ctx.margin,
    marginVault(ctx.margin, underlying.mint, underlying.tokenProgram),
    marginVault(ctx.margin, receiptAsset.mint, receiptAsset.tokenProgram),
  );
  const ix = await marginExecuteIx(ctx, {
    target: KLEND_PROGRAM_ID,
    data: kaminoCallData("redeem", amount),
    cpiAccounts,
    token: { spent: receiptAsset, received: underlying, expectedSpent: amount, expectedReceived: expected },
  });
  const signature = await sendInstructions([...ctx.instructions, ix], {
    signer,
    label: `Withdraw ${token.symbol} from Kamino`,
    computeUnits: EXEC_COMPUTE_UNITS,
    onStatus: opts.onStatus as never,
  });
  return { signature, underlying: fromRaw(expected, token.decimals) };
}
