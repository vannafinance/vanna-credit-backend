import { fetchWithTimeout } from "../async";
import { Buffer } from "buffer";
import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  depositInstruction,
  withdrawInstruction,
  fetchVault,
  vaultProgram,
  depositSwapAmount,
  jupiterRoute,
  getVaultState,
  withdrawSwapEstimate,
  type PhoenixKeys,
} from "@vanna/phoenix-vault-client";
import { getConnection } from "./connection";
import { getActiveSigner, type TxSigner } from "./wallet-bridge";
import { marginExecuteIx, appApiBase } from "./exec";
import { loadContext, depositIx } from "./margin";
import { getToken, type TokenInfo } from "./tokens";
import { marginVault } from "./pdas";
import { getProgram } from "./program";
import { toRaw, fromRaw } from "./math";
import { ensureFreshPrices } from "./price-refresh";
import { readPhoenixExchange } from "./phoenix";
import {
  PERENA,
  PERENA_SHARES,
  perenaCallAccounts,
  perenaCallData,
} from "./perena";
import { VAULTS, type VaultDefinition } from "./vault-catalogue";
import { sendInstructions, prepareTransactionTables } from "./tx";
import { healStaleDexPools } from "./fork-heal";
import { VAULT_SHARED_LOOKUP_TABLE } from "./vault-deployment";

export interface PreparedVaultAction {
  owner: string;
  definition: VaultDefinition;
  call: "deposit" | "withdraw";
  walletDeposit: boolean;
  instructions: TransactionInstruction[];
  tables: AddressLookupTableAccount[];
  shareChange: bigint;
  usdcChange: bigint;
  healthFactor: number | null;
  createdAt: number;
  receiptBefore: bigint;
  minimumOut: bigint;
}
const rawAmount = (info: { data: Buffer } | null) =>
  info && info.data.length >= 165 ? info.data.readBigUInt64LE(64) : 0n;

export async function prepareVaultAction(
  id: string,
  call: "deposit" | "withdraw",
  amount: string,
  signer: TxSigner = getActiveSigner(),
  attempt = 0,
  noRoute = false,
): Promise<PreparedVaultAction> {
  const def = VAULTS.find((v) => v.id === id);
  if (!def) throw new Error("Unknown vault");
  const units = toRaw(amount, 6);
  if (units <= 0n) throw new Error("Enter an amount");
  await Promise.all([
    ensureFreshPrices(),
    def.kind === "basis"
      ? fetchWithTimeout(`${appApiBase()}/api/perps/phoenix-book`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ market: def.asset, vault: true }),
        }).then(async (r) => {
          if (!r.ok)
            throw new Error("Phoenix order book could not be refreshed");
        })
      : Promise.resolve(),
  ]);
  const c = getConnection(),
    ctx = await loadContext(signer.publicKey);
  if (!ctx.snapshot.exists) throw new Error("Create a margin account first");
  const usdc = getToken("USDC"),
    mint = new PublicKey(def.mint);
  const receipt = [...ctx.assetMap.values()].find((a) => a.mint.equals(mint));
  const cash = [...ctx.assetMap.values()].find((a) => a.mint.equals(usdc.mint));
  if (!receipt || !cash || !ctx.model.collateral.includes(receipt.assetIndex))
    throw new Error("This vault is not enabled on Vanna yet");
  const walletDeposit = def.id === "basis-sol" && call === "deposit";
  const holder = walletDeposit ? signer.publicKey : ctx.margin;
  const shareAccount = marginVault(holder, mint, TOKEN_PROGRAM_ID),
    cashAccount = marginVault(holder, usdc.mint, TOKEN_PROGRAM_ID);
  const before = await c.getMultipleAccountsInfo([shareAccount, cashAccount]);
  const shareBefore = rawAmount(before[0]),
    cashBefore = rawAmount(before[1]);
  if (units > (call === "deposit" ? cashBefore : shareBefore))
    throw new Error(
      `Insufficient ${walletDeposit ? "wallet" : "margin"} ${call === "deposit" ? "USDC" : def.symbol}`,
    );
  const tableKeys: PublicKey[] = [];
  let routeAccounts: PublicKey[] = [];
  if (VAULT_SHARED_LOOKUP_TABLE)
    tableKeys.push(new PublicKey(VAULT_SHARED_LOOKUP_TABLE));
  if (def.lookupTable) tableKeys.push(new PublicKey(def.lookupTable));
  let outside: (min: bigint) => Promise<TransactionInstruction>;
  const setup: TransactionInstruction[] = [];
  if (def.kind === "perena") {
    const share =
      PERENA_SHARES[def.id === "perena-junior" ? "usdstarj" : "usdstar"];
    outside = async () =>
      new (await import("@solana/web3.js")).TransactionInstruction({
        programId: PERENA,
        keys: perenaCallAccounts(share, call, ctx.margin),
        data: perenaCallData(share, call, units),
      });
  } else {
    const [vault, ex] = await Promise.all([
      fetchVault(vaultProgram(c), new PublicKey(def.assetMint!)),
      readPhoenixExchange(c),
    ]);
    if (call === "deposit" && (vault.paused || !vault.depositsOpen))
      throw new Error("Vault deposits are paused");
    if (
      call === "deposit" &&
      vault.maxDepositUsd > 0n &&
      units > vault.maxDepositUsd
    )
      throw new Error(
        `Maximum deposit is ${fromRaw(vault.maxDepositUsd, 6)} USDC`,
      );
    const phoenix: PhoenixKeys = {
      perpAssetMap: ex.perpAssetMap,
      withdrawQueue: ex.withdrawQueue,
      globalVault: ex.globalVault,
      globalTraderIndex: ex.traderIndex,
      activeTraderBuffer: ex.activeBuffer,
    };
    const state =
      call === "withdraw"
        ? await getVaultState(c, vault, signer.publicKey, phoenix)
        : null;
    const sold =
      call === "deposit"
        ? depositSwapAmount(units, vault.targetMarginBps)
        : withdrawSwapEstimate(
            vault.kind,
            units,
            state!.supply,
            state!.assetUnits,
            state!.nav,
            state!.tokenPrice,
            vault.assetDecimals,
          );
    const route =
      sold > 0n && !noRoute
        ? await jupiterRoute(
            vault,
            call === "deposit" ? "usdc" : "asset",
            sold,
            {
              apiBase: `${appApiBase()}/api/jupiter`,
              slippageBps: 100,
              maxAccounts: 30,
              dexes: [
                def.asset === "TSLA" || def.asset === "META"
                  ? "Raydium CLMM"
                  : "Whirlpool",
              ],
            },
          )
        : undefined;
    tableKeys.push(...(route?.lookupTables ?? []));
    routeAccounts = route?.metas.map((m) => m.pubkey) ?? [];
    if (vault.kind === "nativeSol" && call === "withdraw")
      setup.push(
        createAssociatedTokenAccountIdempotentInstruction(
          signer.publicKey,
          marginVault(vault.authority, NATIVE_MINT, TOKEN_PROGRAM_ID),
          vault.authority,
          NATIVE_MINT,
        ),
      );
    // A basis deposit always swaps part of the USDC into the asset; with no route (amount too small
    // to split) the program has nothing to execute, so stop with a clear message instead of a crash.
    if (call === "deposit" && !route) throw new Error("Deposit amount is too small for this vault's hedge swap — increase the amount");
    outside = async (minimum) =>
      call === "deposit"
        ? depositInstruction(vaultProgram(c), {
            vault,
            user: holder,
            usdcAmount: units,
            minShares: minimum,
            route: route!,
            phoenix,
          })
        : withdrawInstruction(vaultProgram(c), {
            vault,
            user: holder,
            shares: units,
            minUsdcOut: minimum,
            route,
            phoenix,
          });
  }
  let tables = (
    await Promise.all(
      [...new Map(tableKeys.map((k) => [k.toBase58(), k])).values()].map((k) =>
        c.getAddressLookupTable(k),
      ),
    )
  )
    .map((t) => t.value)
    .filter((t): t is AddressLookupTableAccount => t !== null);
  const build = async (min: bigint) => {
    const ix = await outside(min);
    if (walletDeposit) return [...setup, ix];
    ctx.instructions = [];
    const wrapped = await marginExecuteIx(ctx, {
      target: ix.programId,
      data: ix.data,
      cpiAccounts: ix.keys,
      token: {
        spent: call === "deposit" ? cash : receipt,
        received: call === "deposit" ? receipt : cash,
        expectedSpent: 0n,
        expectedReceived: 0n,
      },
    });
    return [...setup, ...ctx.instructions, wrapped];
  };
  const budget = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
  ];
  const previewInstructions = await build(0n);
  tables = await prepareTransactionTables([...budget, ...previewInstructions], {
    signer,
    label: "Prepare vault account",
    lookupTables: tables,
  });
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: (await c.getLatestBlockhash()).blockhash,
      instructions: [...budget, ...previewInstructions],
    }).compileToV0Message(tables),
  );
  if (tx.serialize().length > 1232)
    throw new Error(
      `Vault transaction too large: ${tx.serialize().length} bytes`,
    );
  const simulate = () =>
    c.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      innerInstructions: true,
      accounts: {
        encoding: "base64",
        addresses: [shareAccount.toBase58(), cashAccount.toBase58()],
      },
    });
  const sim = await simulate();
  if (sim.value.err && attempt < 2) {
    // 6030 = the basis program's SwapNotNeeded; Vanna's own codes overlap, so require the basis
    // program to be the one that failed before retrying without a route.
    const basisFailed = (sim.value.logs ?? []).some((l) => l.includes(`${vaultProgram(c).programId.toBase58()} failed`) && /0x178e|6030/.test(l));
    if (call === "withdraw" && basisFailed) {
      return prepareVaultAction(id, call, amount, signer, attempt + 1, true);
    }
    if ((await healStaleDexPools(c, tx, routeAccounts)) > 0) {
      // Re-quote after refreshing pool state. Replaying the old quote can use
      // tick arrays that no longer match the refreshed pool.
      return prepareVaultAction(id, call, amount, signer, attempt + 1, noRoute);
    }
  }
  if (sim.value.err)
    throw new Error(
      `Vault preview failed: ${JSON.stringify(sim.value.err)}. ${(
        sim.value.logs ?? []
      )
        .filter((l) =>
          /Error Message:|failed:|panicked|Error:|memory|borrow|Program log:/.test(
            l,
          ),
        )
        .slice(-12)
        .join(" ")}`,
    );
  const after = (sim.value.accounts ?? []).map((a) =>
    a ? rawAmount({ data: Buffer.from(a.data[0], "base64") }) : 0n,
  );
  if (after.length !== 2)
    throw new Error("RPC did not return the simulated balances");
  const shareChange = after[0] - shareBefore,
    usdcChange = after[1] - cashBefore;
  const output = call === "deposit" ? shareChange : usdcChange;
  if (output <= 0n) throw new Error("The vault cannot fill this amount now");
  let healthFactor: number | null = null;
  for (const inner of sim.value.innerInstructions ?? [])
    for (const raw of inner.instructions) {
      const ix = raw as {
        programId?: PublicKey;
        programIdIndex?: number;
        data?: string;
      };
      const program =
        ix.programId ??
        (ix.programIdIndex === undefined
          ? undefined
          : tx.message
              .getAccountKeys({ addressLookupTableAccounts: tables })
              .get(ix.programIdIndex));
      if (!program?.equals(getProgram().programId) || !ix.data) continue;
      try {
        const { utils } = await import("@coral-xyz/anchor");
        const data = Buffer.from(utils.bytes.bs58.decode(ix.data));
        const event = getProgram().coder.events.decode(
          data.subarray(8).toString("base64"),
        );
        if (event?.name === "marginExecuted") {
          const value = BigInt(String(event.data.borrowHealthFactorWad));
          healthFactor = value > 10n ** 30n ? null : Number(value) / 1e18;
        }
      } catch {
        /* Optional event preview. */
      }
    }
  const minimumOut = (output * 9950n) / 10_000n;
  return {
    owner: signer.publicKey.toBase58(),
    definition: def,
    call,
    walletDeposit,
    instructions: await build(minimumOut),
    tables,
    shareChange,
    usdcChange,
    healthFactor,
    createdAt: Date.now(),
    receiptBefore: shareBefore,
    minimumOut,
  };
}

export async function moveWalletSharesToMargin(
  def: VaultDefinition,
  signer: TxSigner = getActiveSigner(),
  amount?: bigint,
  onStatus?: (s: string) => void,
): Promise<string> {
  const source = marginVault(
    signer.publicKey,
    new PublicKey(def.mint),
    TOKEN_PROGRAM_ID,
  );
  const held = rawAmount(await getConnection().getAccountInfo(source));
  const units = amount ?? held;
  if (units <= 0n || units > held)
    throw new Error("No wallet shares available to deposit");
  const token = {
    symbol: def.symbol,
    mint: new PublicKey(def.mint),
    decimals: 6,
    tokenProgram: TOKEN_PROGRAM_ID,
  } as TokenInfo;
  return sendInstructions(
    [await depositIx(signer.publicKey, token, units, source)],
    {
      signer,
      label: "Move vault shares to margin",
      computeUnits: 400_000,
      onStatus,
    },
  );
}
export async function submitVaultAction(
  prepared: PreparedVaultAction,
  signer: TxSigner = getActiveSigner(),
  onStatus?: (s: string) => void,
) {
  if (prepared.owner !== signer.publicKey.toBase58())
    throw new Error("Wallet changed; preview again");
  if (Date.now() - prepared.createdAt > 30_000)
    throw new Error("Preview expired; refresh it before signing");
  const signature = await sendInstructions(prepared.instructions, {
    signer,
    label: `${prepared.call} ${prepared.definition.name}`,
    computeUnits: 1_400_000,
    lookupTables: prepared.tables,
    onStatus,
  });
  if (prepared.walletDeposit) {
    const account = await getConnection().getAccountInfo(
      marginVault(
        signer.publicKey,
        new PublicKey(prepared.definition.mint),
        TOKEN_PROGRAM_ID,
      ),
    );
    const received = rawAmount(account) - prepared.receiptBefore;
    try {
      await moveWalletSharesToMargin(
        prepared.definition,
        signer,
        received,
        onStatus,
      );
    } catch {
      throw new Error(
        `Vault deposit confirmed (${signature}). Your shares remain in your wallet; use Move shares to margin to finish.`,
      );
    }
  }
  return signature;
}
