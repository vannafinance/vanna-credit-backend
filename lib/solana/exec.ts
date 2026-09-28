/**
 * `margin_execute` — the margin account calling a whitelisted external program (Jupiter swaps,
 * Kamino Lend supply / redeem), health-checked by the program after the CPI.
 *
 * Account list (`instructions/account_manager/exec.rs::MarginExecute`):
 *   authority, protocol_config, margin_account, integration ["integration", target], target_program,
 *   spent_asset, spent_mint, spent_vault, spent_price_update,
 *   received_asset, received_mint, received_vault (init_if_needed), received_price_update,
 *   spent_token_program, received_token_program, associated_token_program, system_program
 * remaining_accounts = the external instruction's accounts (`cpi_account_count` of them, in that
 * program's order, none a signer — the program signs as the margin PDA) followed by the health
 * scan, which EXCLUDES both the spent and the received collateral (the handler values those two
 * itself from the named vaults).
 *
 * Program-side rules the UI must respect: the spent asset must already be ACTIVE collateral, the
 * received asset must be collateral-enabled, and the account must stay above HF 1.10.
 */
import { BN } from "@coral-xyz/anchor";
import { ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, SystemProgram, type AccountMeta, type AddressLookupTableAccount, type TransactionInstruction } from "@solana/web3.js";
import { JUPITER_V6_PROGRAM_ID } from "./config";
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

/** Jupiter route + health scan + Vanna checks run well past the 600k batch budget. */
const EXEC_COMPUTE_UNITS = 1_400_000;

function findAssetByMint(ctx: BatchContext, mint: PublicKey): AssetConfigState {
  for (const a of ctx.assetMap.values()) if (a.mint.equals(mint)) return a;
  throw new Error(`${mint.toBase58()} is not registered with the protocol`);
}

/**
 * Builds one `margin_execute` against the batch context's CURRENT index model (so it composes
 * after deposits / borrows in the same transaction) and replays its effect on the model.
 */
export async function marginExecuteIx(
  ctx: BatchContext,
  p: {
    target: PublicKey;
    spent: AssetConfigState;
    received: AssetConfigState;
    data: Buffer;
    cpiAccounts: AccountMeta[];
    minReceived: bigint;
    /** Expected spend / receive, only used to replay the active-asset lists. */
    expectedSpent: bigint;
    expectedReceived: bigint;
  },
): Promise<TransactionInstruction> {
  if (!ctx.model.collateral.includes(p.spent.assetIndex)) {
    throw new Error("The asset to spend is not active collateral in your margin account");
  }
  const health = buildHealthRemainingAccounts(ctx.margin, ctx.model, ctx.assetMap, {
    collateral: [p.spent.assetIndex, p.received.assetIndex],
  });
  const cpi = p.cpiAccounts.map((a) => ({ ...a, isSigner: false }));
  const ix = await getProgram()
    .methods.marginExecute(p.data, cpi.length, new BN(p.minReceived.toString()))
    .accountsStrict({
      authority: ctx.owner,
      protocolConfig: protocolConfigPda(),
      marginAccount: ctx.margin,
      integration: integrationPda(p.target),
      targetProgram: p.target,
      spentAsset: p.spent.address,
      spentMint: p.spent.mint,
      spentVault: marginVault(ctx.margin, p.spent.mint, p.spent.tokenProgram),
      spentPriceUpdate: p.spent.priceUpdate,
      receivedAsset: p.received.address,
      receivedMint: p.received.mint,
      receivedVault: marginVault(ctx.margin, p.received.mint, p.received.tokenProgram),
      receivedPriceUpdate: p.received.priceUpdate,
      spentTokenProgram: p.spent.tokenProgram,
      receivedTokenProgram: p.received.tokenProgram,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as any)
    .remainingAccounts([...cpi, ...health])
    .instruction();
  ctx.model.execute(p.spent.assetIndex, p.expectedSpent, p.received.assetIndex, p.expectedReceived);
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

export interface MarginSwapRequest {
  fromSymbol: string;
  toSymbol: string;
  /** UI amount of `fromSymbol` spent from the margin vault. */
  amount: string | number;
  slippageBps: number;
}

/** Exact-input quote for a margin swap (same routing as wallet swaps). */
export function quoteMarginSwap(req: MarginSwapRequest): Promise<JupiterQuote> {
  const from = getToken(req.fromSymbol);
  const to = getToken(req.toSymbol);
  return fetchJupiterQuote({
    inputMint: from.mint.toBase58(),
    outputMint: to.mint.toBase58(),
    amount: toRaw(req.amount, from.decimals),
    slippageBps: req.slippageBps,
  });
}

/**
 * Swaps collateral inside the margin account through Jupiter. The route is built with the margin
 * PDA as `userPublicKey` (no SOL wrap, shared accounts → no intermediate user accounts), only the
 * swap instruction is wrapped, and `min_received` is Jupiter's own slippage floor.
 */
export async function executeMarginSwap(req: MarginSwapRequest, quote: JupiterQuote, opts: MarginServiceOptions = {}): Promise<MarginTxResult> {
  const signer = opts.signer ?? getActiveSigner();
  const from = getToken(req.fromSymbol);
  const to = getToken(req.toSymbol);
  if (from.symbol === to.symbol) throw new Error("Pick two different tokens");
  opts.onStatus?.("Refreshing oracle prices");
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

  const ix = await marginExecuteIx(ctx, {
    target: JUPITER_V6_PROGRAM_ID,
    spent,
    received,
    data,
    cpiAccounts: swapIx.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: false, isWritable: a.isWritable })),
    minReceived: BigInt(quote.otherAmountThreshold ?? quote.outAmount),
    expectedSpent: amount,
    expectedReceived: BigInt(quote.outAmount),
  });
  const signature = await sendInstructions([ix], {
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

/** Slippage allowance on the cTokens minted (the reserve accrues between quote and landing). */
const RECEIPT_SLIPPAGE_BPS = 50n;

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
 * ONE transaction: [deposit from wallet] → [open debt + borrow] → `margin_execute` Kamino
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

  opts.onStatus?.("Refreshing oracle prices");
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
  const minReceived = (expectedReceipts * (10_000n - RECEIPT_SLIPPAGE_BPS)) / 10_000n;
  const cpiAccounts = kaminoCallAccounts(
    "deposit",
    r,
    ctx.margin,
    marginVault(ctx.margin, underlying.mint, underlying.tokenProgram),
    marginVault(ctx.margin, receiptAsset.mint, receiptAsset.tokenProgram),
  );
  const ix = await marginExecuteIx(ctx, {
    target: KLEND_PROGRAM_ID,
    spent: underlying,
    received: receiptAsset,
    data: kaminoCallData("deposit", total),
    cpiAccounts,
    minReceived,
    expectedSpent: total,
    expectedReceived: expectedReceipts,
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
  opts.onStatus?.("Refreshing oracle prices");
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
    spent: receiptAsset,
    received: underlying,
    data: kaminoCallData("redeem", amount),
    cpiAccounts,
    minReceived: (expected * (10_000n - RECEIPT_SLIPPAGE_BPS)) / 10_000n,
    expectedSpent: amount,
    expectedReceived: expected,
  });
  const signature = await sendInstructions([ix], {
    signer,
    label: `Withdraw ${token.symbol} from Kamino`,
    computeUnits: EXEC_COMPUTE_UNITS,
    onStatus: opts.onStatus as never,
  });
  return { signature, underlying: fromRaw(expected, token.decimals) };
}
