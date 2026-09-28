"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useState, useEffect, useMemo, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Collaterals, BorrowInfo } from "@/lib/types";
import { DropdownOptions } from "@/lib/constants";
import { BALANCE_TYPE_OPTIONS } from "@/lib/constants/margin";
import { Button } from "@/components/ui/button";
import { Collateral } from "./collateral-box";
import { DualBorrow, type DualBorrowState } from "./dual-borrow";
import { Dialogue } from "@/components/ui/dialogue";
import {
  useMarginAccountInfoStore,
  type BorrowedBalance,
  refreshMarginAccount,
  createMarginAccount,
  checkUserMarginAccount,
} from "@/store/margin-account-info-store";
import { useUserStore } from "@/store/user";
import { useTheme } from "@/contexts/theme-context";
import { useWallet } from "@/hooks/use-wallet";
import toast from "react-hot-toast";
import { useTokenPrices } from "@/hooks/use-token-prices";
import { useAccountSnapshot, ACCOUNT_SNAPSHOT_KEY } from "@/hooks/use-account-snapshot";
import { useDepositAndBorrow } from "@/hooks/use-margin";
import { MarginActionPreview, type PreviewRow } from "@/components/margin/margin-action-preview";
import {
  HF_INFINITY,
  borrowUsdForLeverage,
  liquidationBufferUsd,
  maxBorrowUsdAfterDeposit,
  maxLeverageForInput,
  projectedHealthFactor,
  spendableWalletAmount,
  toTokenAmountString,
  type AccountTotals,
} from "@/lib/margin/amounts";
import { maxBorrowUsd, SAFE_HEALTH_FACTOR } from "@/lib/solana/margin";

const formatHF = (hf: number): string =>
  !Number.isFinite(hf) || hf >= HF_INFINITY ? "∞" : hf.toFixed(2);
const formatUsd = (n: number): string =>
  `$${(n < 0 ? 0 : n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Tolerance for comparing typed amounts against balances (float noise). */
const AMOUNT_EPSILON = 1e-9;
/** Balances below this USD value are treated as empty dust in MB mode. */
const USD_DUST_EPSILON = 0.000001;

// Helper to generate unique ID for collateral
const generateCollateralId = () => `collateral-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;


// Helper to ensure collateral has ID
const ensureCollateralId = (collateral: Collaterals): Collaterals => {
  if (!collateral.id) {
    return { ...collateral, id: generateCollateralId() };
  }
  return collateral;
};

/**
 * Primary deposit + borrow surface of the margin panel. Lets the user assemble
 * collateral rows from wallet balances (WB mode) or pick existing margin-account
 * collateral (MB mode), set a leverage multiplier, and open a leveraged
 * position. The submit handler branches by mode and account state:
 *
 *  - No margin account → opens the create-account / sign-agreement dialog flow
 *    (`user_create_margin` via the store's `createMarginAccount`).
 *  - MB mode → borrow-only against already-deposited collateral.
 *  - WB mode → deposit + borrow. Every deposit row and every borrow (single,
 *    dual, or cross-asset) goes out in ONE transaction via
 *    `depositAndBorrow({ deposits, borrows })` — the service batches
 *    user_deposit_collateral + user_open_debt_position + user_borrow.
 *
 * The leverage slider's max, the borrow ceiling and the pre-submit check all come
 * from the account-wide HF rule at SAFE_HEALTH_FACTOR (lib/margin/amounts.ts):
 * borrowed tokens land in the margin vault and count as collateral, so
 * HF_after = (C + E + B) / (D + B). SOL deposits keep the 0.05 SOL fee reserve.
 * Deposit/borrow preview is delegated to {@link LeveragePreviewSection}.
 */
export const LeverageAssetsTab = () => {
  const { isDark } = useTheme();
  const { refreshBalances, connectWallet } = useWallet();
  // Component state
  const hasMarginAccount = useMarginAccountInfoStore((state) => state.hasMarginAccount);
  const isCreatingAccount = useMarginAccountInfoStore((state) => state.isCreatingAccount);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [, setBorrowItems] = useState<BorrowInfo[]>([]);
  // Validated dual-borrow output (items + Total/Max + red-text error). Gates
  // the submit button; null until the user touches the borrow inputs.
  const [borrowState, setBorrowState] = useState<DualBorrowState | null>(null);
  const [leverage, setLeverage] = useState(2);

  const userAddress = useUserStore((state) => state.address);
  const tokenBalances = useUserStore((state) => state.tokenBalances);

  useEffect(() => {
    if (!userAddress) return;
    refreshBalances(userAddress).catch((err) => {
      console.warn("Failed to refresh wallet balances on margin page:", err);
    });
  }, [userAddress, refreshBalances]);

  // Dialogue state
  type DialogueState = "none" | "create-margin" | "sign-agreement";
  const [activeDialogue, setActiveDialogue] = useState<DialogueState>("none");

  // If a previous flow left isCreatingAccount=true (e.g. an interrupted attempt),
  // the Sign Agreement button gets stuck on "Creating Account...". Reset on dialog
  // open — the effect only fires on the transition into "sign-agreement", so it
  // won't clobber the real loading state once the user clicks Sign Agreement
  // (handleSignAgreement re-sets the flag itself).
  useEffect(() => {
    if (activeDialogue === "sign-agreement") {
      useMarginAccountInfoStore.getState().set({ isCreatingAccount: false });
    }
  }, [activeDialogue]);

  // Map-based state for O(1) operations
  const [collaterals, setCollaterals] = useState<Map<string, Collaterals>>(
    new Map()
  );
  const [, setSelectedBalanceType] = useState<string>(
    BALANCE_TYPE_OPTIONS[0]
  );

  // Real collateral balances from the margin account (on-chain vault balances —
  // borrowed tokens included, they count as collateral).
  const collateralBalances = useMarginAccountInfoStore((state) => state.collateralBalances);
  // Account-level totals (Σ collateral USD / Σ debt USD) — the inputs to every
  // max-borrow / max-leverage figure on this tab.
  const grossCollateralValue = useMarginAccountInfoStore((state) => state.grossCollateralValue);
  const totalBorrowedValue = useMarginAccountInfoStore((state) => state.totalBorrowedValue);

  // Convert Map to stable array for rendering
  const collateralList = useMemo(() => {
    return Array.from(collaterals.values());
  }, [collaterals]);

  // Single source of truth for MB mode
  const isMBMode = collateralList.length === 1 && collateralList[0]?.balanceType.toLowerCase() === "mb";

  // Live on-chain (fork Pyth) prices for every registry token; 0 while unknown.
  const tokenPrices = useTokenPrices();

  // Same per-account /api/account snapshot the page HEADER reads (React Query
  // dedupes by key, so mounted consumers share the same in-memory response).
  const { snapshot } = useAccountSnapshot(userAddress);

  // Effective collateral = store when it has balances (live), else the snapshot
  // baseline. So the grid is never empty while the account holds value.
  const effectiveCollateral = useMemo<Record<string, BorrowedBalance>>(() => {
    const storeHas = Object.values(collateralBalances).some((b) => parseFloat(b.amount) > 0);
    if (storeHas) return collateralBalances;
    return (snapshot?.collateralBalances as Record<string, BorrowedBalance>) ?? collateralBalances;
  }, [collateralBalances, snapshot]);

  // Account totals from whichever source has them (store first, snapshot fallback).
  const account: AccountTotals = useMemo(() => {
    const storeHas = grossCollateralValue > 0 || totalBorrowedValue > 0;
    return {
      collateralUsd: storeHas ? grossCollateralValue : snapshot?.grossCollateralValue ?? 0,
      debtUsd: storeHas ? totalBorrowedValue : snapshot?.totalBorrowedValue ?? 0,
    };
  }, [grossCollateralValue, totalBorrowedValue, snapshot]);

  // Live margin-vault balance for a given collateral asset. Backs MB mode's
  // manual amount entry (the "Balance: X {asset}" line + %-of-balance quick
  // chips inside the shared Collateral row editor), looked up live by whichever
  // asset the user has picked in the dropdown.
  const getMarginBalanceForAsset = useCallback(
    (asset: string): number => {
      const bal = effectiveCollateral[asset];
      if (!bal || parseFloat(bal.usdValue) <= USD_DUST_EPSILON) return 0;
      return parseFloat(bal.amount) || 0;
    },
    [effectiveCollateral]
  );

  // Entering MB with no collateral loaded yet → pull the margin-account balances
  // so the row's live Balance/% math fills in instead of flashing zero.
  // refreshMarginAccount shares one in-flight read per owner, so this is safe.
  useEffect(() => {
    if (isMBMode && userAddress && account.collateralUsd <= 0.01) {
      refreshMarginAccount(userAddress).catch(() => {});
    }
  }, [isMBMode, userAddress, account.collateralUsd]);

  // Initialize with one empty collateral if none exist
  useEffect(() => {
    if (collaterals.size === 0) {
      const newId = generateCollateralId();
      const newCollateral: Collaterals = {
        id: newId,
        amount: 0,
        amountInUsd: 0,
        asset: DropdownOptions[0],
        balanceType: "wb",
        unifiedBalance: 0,
      };
      setCollaterals(new Map([[newId, newCollateral]]));
      setEditingId(newId);
    }
  }, [collaterals.size]);

  // Total deposit value at live prices (never the stored, rounded amountInUsd) so
  // the borrow preview stays consistent with DualBorrow (same price query).
  const totalDepositValue = useMemo(() => {
    return collateralList.reduce((sum, collateral) => {
      const price = tokenPrices[collateral.asset] ?? 0;
      return sum + (collateral.amount || 0) * price;
    }, 0);
  }, [collateralList, tokenPrices]);

  // Derived values (no state needed). In MB mode `collateralList` holds the single
  // margin-account row the user is sizing against, so `depositAmount` reflects the
  // (possibly partial) amount entered for it — same leverage formula as WB.
  const depositAmount = totalDepositValue;
  const effectiveTotalForBorrow = depositAmount;
  const projectedBorrowUsd = borrowUsdForLeverage(effectiveTotalForBorrow, leverage);

  // Account-wide limits at SAFE_HEALTH_FACTOR. WB: the fresh deposit raises C; MB:
  // nothing new is deposited, so the ceiling is maxBorrowUsd(C, D).
  const sliderMaxLeverage = maxLeverageForInput(effectiveTotalForBorrow, account, isMBMode ? "MB" : "WB");
  const accountMaxBorrowUsd = isMBMode
    ? maxBorrowUsd(account.collateralUsd, account.debtUsd, SAFE_HEALTH_FACTOR, true)
    : maxBorrowUsdAfterDeposit(effectiveTotalForBorrow, account);

  // Keep the selected leverage inside the (input-dependent) safe max.
  useEffect(() => {
    if (leverage > sliderMaxLeverage) setLeverage(sliderMaxLeverage);
  }, [leverage, sliderMaxLeverage]);

  // Capture the validated dual-borrow output: feed the assembled items into the
  // borrow flow and keep the full state for submit-gating + red text.
  const handleBorrowChange = useCallback((s: DualBorrowState) => {
    setBorrowState(s);
    setBorrowItems(s.items);
  }, []);

  // Memoized callbacks
  const handleAddCollateral = useCallback(() => {
    if (editingId !== null) return;

    const newId = generateCollateralId();
    const newCollateral: Collaterals = {
      id: newId,
      amount: 0,
      amountInUsd: 0,
      asset: DropdownOptions[0],
      balanceType: "wb",
      unifiedBalance: 0,
    };
    setCollaterals((prev) => {
      const next = new Map(prev);
      next.set(newId, newCollateral);
      return next;
    });
    setEditingId(newId);
  }, [editingId]);

  const handleEditCollateral = (id: string) => {
    if (editingId !== null && editingId !== id) return;
    setEditingId(id);
  };

  const handleSaveCollateral = useCallback((id: string, updated: Collaterals) => {
    // Use the original id, don't generate a new one
    const collateralWithId: Collaterals = {
      ...updated,
      id: id, // Always use the original id to update existing collateral
    };
    
    setCollaterals((prev) => {
      const next = new Map(prev);
      
      if (collateralWithId.balanceType.toLowerCase() === "mb") {
        // MB mode: clear all, keep only this one
        next.clear();
        next.set(id, collateralWithId);
      } else {
        // Remove all MB collaterals, then update this one
        for (const [key, val] of next) {
          if (val.balanceType.toLowerCase() === "mb") {
            next.delete(key);
          }
        }
        // Update existing collateral with same id
        next.set(id, collateralWithId);
      }
      
      return next;
    });
    
    setEditingId(null);
  }, []);

  const handleCancelEdit = useCallback(() => {
    if (editingId !== null) {
      const collateral = collaterals.get(editingId);
      // Remove empty collateral if it's not the first one
      if (collateral && collateral.amount === 0 && collateral.amountInUsd === 0) {
        const collateralArray = Array.from(collaterals.entries());
        const isLast = collateralArray.length > 1 && 
          collateralArray[collateralArray.length - 1][0] === editingId;
        
        if (isLast) {
          setCollaterals((prev) => {
            const next = new Map(prev);
            next.delete(editingId);
            return next;
          });
        }
      }
    }
    setEditingId(null);
  }, [editingId, collaterals]);

  const handleDeleteCollateral = useCallback((id: string) => {
    if (editingId !== null) return;
    
    setCollaterals((prev) => {
      // Prevent deleting if it's the first collateral
      const collateralArray = Array.from(prev.entries());
      if (collateralArray.length > 0 && collateralArray[0][0] === id) {
        return prev; // Return unchanged
      }
      
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, [editingId]); // Remove collaterals from deps - use functional update

  const handleBalanceTypeChange = useCallback((id: string, balanceType: string) => {
    const normalized = balanceType.toLowerCase();

    setCollaterals((prev) => {
      const currentCollateral = prev.get(id) || {
        id: id,
        amount: 0,
        amountInUsd: 0,
        asset: DropdownOptions[0],
        balanceType: "wb",
        unifiedBalance: 0,
      };

      const updatedCollateral: Collaterals = {
        ...currentCollateral,
        id: id,
        balanceType: normalized,
      };

      const next = new Map(prev);

      if (normalized === "mb") {
        // MB mode: clear all, keep only this one
        next.clear();
        next.set(id, updatedCollateral);
      } else {
        // Normal mode: remove any MB collaterals, then update this one
        for (const [key, val] of next) {
          if (val.balanceType.toLowerCase() === "mb") {
            next.delete(key);
          }
        }
        next.set(id, updatedCollateral);
      }

      return next;
    });

    setSelectedBalanceType(balanceType.toUpperCase());
    // Both WB and MB are manual-entry flows now — drop the form straight back
    // into edit mode on either switch so the user can type a fresh amount
    // instead of having to click the pencil icon on a 0-amount saved card.
    setEditingId(id);
  }, []); // No dependencies - uses functional updates

  // Reset the entire Leverage Assets form back to its initial state.
  // Called after a successful Deposit & Borrow / Borrow so the next position
  // doesn't inherit stale collateral, leverage, or selected MB items.
  const resetForm = useCallback(() => {
    const newId = generateCollateralId();
    const fresh: Collaterals = {
      id: newId,
      amount: 0,
      amountInUsd: 0,
      asset: DropdownOptions[0],
      balanceType: "wb",
      unifiedBalance: 0,
    };
    setCollaterals(new Map([[newId, fresh]]));
    setEditingId(newId);
    setSelectedBalanceType(BALANCE_TYPE_OPTIONS[0]);
    setLeverage(2);
    setBorrowItems([]);
  }, []);


  const qc = useQueryClient();
  const depositAndBorrowMutation = useDepositAndBorrow();
  const isProcessing = depositAndBorrowMutation.isPending;

  /**
   * Borrow items to send, from the validated DualBorrow state (1 item = single borrow,
   * 2 = dual borrow; an asset different from the deposit = cross-asset). Amounts are
   * already floored to each token's decimals by `splitBorrowUsd` / the input.
   */
  const borrowRequest = useMemo(() => {
    if (leverage <= 1 || !borrowState) return [];
    return borrowState.items
      .map((b) => ({ symbol: b.assetData.asset, amount: toTokenAmountString(parseFloat(b.assetData.amount) || 0, b.assetData.asset) }))
      .filter((b) => Number(b.amount) > 0);
  }, [borrowState, leverage]);

  const borrowRequestUsd = useMemo(
    () => borrowRequest.reduce((sum, b) => sum + Number(b.amount) * (tokenPrices[b.symbol] ?? 0), 0),
    [borrowRequest, tokenPrices],
  );

  const handleButtonClick = async () => {
    if (!userAddress) {
      void connectWallet();
      return;
    }

    // Block the action while a collateral row is mid-edit — but only for an
    // existing margin account, where Deposit & Borrow must submit a settled
    // amount. Creating the account itself (`user_create_margin`) takes no
    // amount at all, so a brand-new user shouldn't be blocked by the
    // auto-inserted empty collateral row before they've even decided to deposit.
    if (editingId !== null && hasMarginAccount) {
      toast.error("Please save or cancel your collateral edit before proceeding.");
      return;
    }

    if (!hasMarginAccount) {
      // User doesn't have margin account - show create account dialog
      setActiveDialogue("create-margin");
      return;
    }

    // Pre-validate the borrow against the account-wide rule at the safety buffer.
    // The program enforces HF > 1.10 itself; this catches it before signing.
    if (borrowRequest.length > 0) {
      if (accountMaxBorrowUsd <= 0) {
        toast.error("You've reached the safe borrow limit for your current collateral. Add more collateral or repay part of your loan to borrow more.");
        return;
      }
      if (borrowRequestUsd > accountMaxBorrowUsd + 0.01) {
        toast.error(`Borrow ${formatUsd(borrowRequestUsd)} is above your safe limit of ${formatUsd(accountMaxBorrowUsd)}. Lower the leverage to ${sliderMaxLeverage.toFixed(2)}x or less.`);
        return;
      }
    }

    // ── MB mode: borrow-only (collateral already in margin account) ──────────
    if (isMBMode) {
      const mbRow = collateralList[0];
      if (!mbRow || depositAmount <= 0) {
        toast.error("Enter how much of your margin-account collateral to borrow against.");
        return;
      }
      // The row's amount is a sizing input, not a real transfer — but it
      // shouldn't claim more collateral than the account actually holds.
      const realBalance = getMarginBalanceForAsset(mbRow.asset);
      if (mbRow.amount > realBalance + AMOUNT_EPSILON) {
        toast.error(`You only have ${realBalance.toFixed(4)} ${mbRow.asset} in your margin account. Reduce the amount or use the 100% chip.`);
        return;
      }
      if (leverage <= 1 || borrowRequest.length === 0) {
        toast.error("Please set leverage greater than 1x to borrow.");
        return;
      }
      try {
        await depositAndBorrowMutation.mutateAsync({ borrows: borrowRequest });
        resetForm();
      } catch {
        // Progress modal already shows the decoded error (useDepositAndBorrow).
      }
      return;
    }

    // ── WB mode: deposit (+ borrow) in ONE transaction ───────────────────────
    const wbDeposits = collateralList
      .filter((item) => (item.balanceType || "").toLowerCase() === "wb")
      .map((item) => ({ symbol: item.asset, amount: toTokenAmountString(Number(item.amount || 0), item.asset) }))
      .filter((item) => Number(item.amount) > 0);

    if (wbDeposits.length === 0) {
      toast.error("Please enter a deposit amount greater than 0");
      return;
    }

    // Wallet balance check per asset (SOL keeps the 0.05 SOL fee reserve). Rows of the
    // same asset are summed so two SOL rows can't jointly overspend.
    const perAsset = new Map<string, number>();
    for (const d of wbDeposits) perAsset.set(d.symbol, (perAsset.get(d.symbol) ?? 0) + Number(d.amount));
    for (const [symbol, amount] of perAsset) {
      const wallet = parseFloat(tokenBalances[symbol] || "0") || 0;
      const available = spendableWalletAmount(symbol, wallet);
      if (amount > available + AMOUNT_EPSILON) {
        toast.error(
          available <= AMOUNT_EPSILON
            ? `You have no spendable ${symbol} in your wallet. Use the Faucet to get ${symbol} first, then retry.`
            : `Insufficient ${symbol} wallet balance. Available: ${available.toFixed(4)} ${symbol}${symbol === "SOL" ? " (0.05 SOL is kept for fees)" : ""}.`,
        );
        return;
      }
    }

    try {
      await depositAndBorrowMutation.mutateAsync({ deposits: wbDeposits, borrows: borrowRequest });
      resetForm();
    } catch {
      // Progress modal already shows the decoded error (useDepositAndBorrow).
    }
  };

  const handleSignAgreement = async () => {
    if (!userAddress || isCreatingAccount) {
      return;
    }

    try {
      // createMarginAccount (store) already drives the progress modal and
      // the final success/error toast — don't fire a second one here.
      const created = await createMarginAccount(userAddress);

      if (created) {
        await checkUserMarginAccount(userAddress);
        // The /api/account/[addr] snapshot for this wallet was last fetched
        // BEFORE the account existed (hasMarginAccount: false) — refetch it so
        // the page doesn't keep rendering the pre-creation state.
        qc.invalidateQueries({ queryKey: [...ACCOUNT_SNAPSHOT_KEY, userAddress] });
        setActiveDialogue("none");
      }
    } catch (error) {
      console.error("Failed to create margin account:", error);
    }
  };

  return (
    <>
      <motion.section
        className="w-full min-w-0 flex flex-col gap-2 pt-0"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.4, delay: 0.1 }}
      >
        {/* Deposit section */}
        <motion.section
          className="w-full min-w-0 flex flex-col gap-1.5"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.4, ease: "easeOut" }}
        >
          <motion.h2
            className={`w-full text-[16px] font-medium ${isDark ? "text-white" : ""}`}
            initial={{ opacity: 0, x: -10 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.3 }}
          >
            Deposit
          </motion.h2>
          <section className="flex flex-col gap-[12px]">
            {/* Both WB (deposit from wallet) and MB (borrow against existing
                margin-account collateral) share this same row editor — MB just
                sources its "Balance" and %-chip math from the live margin-account
                balance (via getMarginBalanceForAsset) instead of the wallet. */}
            <section
              className={`${collateralList.length>2?"max-h-[364px] overflow-y-auto overflow-x-visible pr-[4px]":""}  thin-scrollbar `}
            >
              <AnimatePresence mode="popLayout">
                {collateralList.length > 0 ? (
                  <ul className="flex flex-col gap-[12px]" role="list">
                    {collateralList.map((collateral, index) => {
                      const id = collateral.id!;
                      return (
                        <motion.div
                          key={id}
                          initial={{ opacity: 0, y: 20, scale: 0.95 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, y: -20, scale: 0.95 }}
                          transition={{
                            duration: 0.3,
                            ease: "easeOut",
                            delay: index * 0.05,
                          }}
                          layout
                        >
                          <li>
                            <Collateral
                              id={id}
                              collaterals={collateral}
                              isEditing={editingId === id}
                              isAnyOtherEditing={editingId !== null && editingId !== id}
                              onEdit={handleEditCollateral}
                              onSave={handleSaveCollateral}
                              onCancel={handleCancelEdit}
                              onDelete={handleDeleteCollateral}
                              onBalanceTypeChange={handleBalanceTypeChange}
                              marginBalanceFor={getMarginBalanceForAsset}
                              index={index}
                            />
                          </li>
                        </motion.div>
                      );
                    })}
                  </ul>
                ) : (
                  <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -20 }}
                    transition={{ duration: 0.3 }}
                  >
                    <Collateral
                      id={generateCollateralId()}
                      collaterals={null}
                      isEditing={true}
                      isAnyOtherEditing={false}
                      onEdit={handleEditCollateral}
                      onSave={(id, data) => {
                        const collateralWithId = ensureCollateralId(data);
                        setCollaterals(new Map([[collateralWithId.id!, collateralWithId]]));
                        setEditingId(null);
                      }}
                      onCancel={handleCancelEdit}
                      onBalanceTypeChange={handleBalanceTypeChange}
                      marginBalanceFor={getMarginBalanceForAsset}
                      index={0}
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </section>
          </section>

          {/* Add Collateral button */}
          <motion.button
            type="button"
            onClick={handleAddCollateral}
            disabled={editingId !== null || isMBMode}
            className={`w-fit py-[11px] px-[10px] rounded-[8px] flex gap-[4px] text-[14px] font-medium text-[#703AE6] items-center ${
              editingId !== null || isMBMode
                ? "opacity-50 cursor-not-allowed"
                : "hover:cursor-pointer hover:bg-[#F1EBFD]"
            }`}
            whileHover={editingId === null && !isMBMode ? { x: 5 } : {}}
            transition={{ duration: 0.2 }}
            aria-label="Add new collateral"
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 11 11"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <path
                d="M5.33332 0.666748V10.0001M0.666656 5.33341H9.99999"
                stroke="#703AE6"
                strokeWidth="1.33333"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Add Collateral
          </motion.button>
        </motion.section>

        {/* Borrow section */}
        <motion.section
          className="w-full min-w-0 flex flex-col gap-1"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.4, delay: 0.1, ease: "easeOut" }}
        >
          <DualBorrow
            depositUsd={effectiveTotalForBorrow}
            leverage={leverage}
            setLeverage={setLeverage}
            maxLeverage={sliderMaxLeverage}
            accountMaxBorrowUsd={accountMaxBorrowUsd}
            onChange={handleBorrowChange}
          />
        </motion.section>

        {/* Combined transaction details: static rows + before→after preview */}
        <LeveragePreviewSection
          depositAmount={depositAmount}
          projectedBorrowUsd={projectedBorrowUsd}
          isMBMode={isMBMode}
          leverage={leverage}
          account={account}
        />

        {/* Create Margin Account button */}
        <motion.section
          className="mt-4"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.4, delay: 0.3, ease: "easeOut" }}
        >
          <Button
            disabled={isProcessing || (editingId !== null && hasMarginAccount) || (hasMarginAccount && leverage > 1 && !!borrowState?.error)}
            size="large"
            text={
              isProcessing ? "Processing..." :
              editingId !== null && hasMarginAccount ? "Save Collateral to Continue" :
              !userAddress ? "Login" :
              hasMarginAccount  && !isMBMode
                ? leverage <= 1 ? "Deposit" : "Deposit & Borrow"
                : hasMarginAccount && isMBMode
                ? "Borrow"
                :  "Create your Margin Account"
            }
            type="gradient"
            onClick={handleButtonClick}
          />
        </motion.section>
      </motion.section>

      {/* First dialogue: Create Margin Account */}
      <AnimatePresence>
        {activeDialogue === "create-margin" && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center bg-[#45454566] p-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            onClick={() => setActiveDialogue("none")}
          >
            <motion.div
              className="w-full max-w-[380px]"
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              transition={{ duration: 0.3 }}
              onClick={(e) => e.stopPropagation()}
            >
              <Dialogue
                buttonOnClick={() => setActiveDialogue("sign-agreement")}
                buttonText="Create Your Account"
                content={[
                  { line: "Connect your wallet to get started." },
                  {
                    line: "Confirm your Margin Account we will generate a unique address for you.",
                  },
                  { line: "Make a deposit to activate borrowing." },
                ]}
                heading="Create Margin Account"
                onClose={() => setActiveDialogue("none")}
              />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Second dialogue: Review and Sign Agreement */}
      <AnimatePresence>
        {activeDialogue === "sign-agreement" && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center bg-[#45454566] p-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            onClick={() => setActiveDialogue("none")}
          >
            <motion.div
              className="w-full max-w-[480px]"
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              transition={{ duration: 0.3 }}
              onClick={(e) => e.stopPropagation()}
            >
              <Dialogue
                description="Before you proceed, please review and accept the terms of borrowing on VANNA. This agreement ensures you understand the risks, responsibilities, and conditions associated with using the platform."
                buttonOnClick={() => {
                  void handleSignAgreement();
                }}
                buttonText={isCreatingAccount ? "Creating Account..." : "Sign Agreement"}
                content={[
                  {
                    line: "Collateral Requirement",
                    points: [
                      "All borrowed positions must remain fully collateralized.",
                      "If collateral value falls below the liquidation threshold, your position may be liquidated.",
                    ],
                  },
                  {
                    line: "Borrow Limits & Leverage",
                    points: [
                      "You may only borrow assets up to the maximum Loan-to-Value (LTV) allowed.",
                      "Leverage is enabled only when collateral value supports it.",
                    ],
                  },
                  {
                    line: "Interest & Fees",
                    points: [
                      "Interest rates are variable and accrue in real time.",
                      "Additional protocol fees may apply for borrowing or liquidation events.",
                    ],
                  },
                  {
                    line: "Liquidation Risk",
                    points: [
                      "Market volatility can reduce collateral value.",
                      "If your position health factor drops below safe limits, collateral may be partially or fully liquidated without prior notice.",
                    ],
                  },
                  {
                    line: "User Responsibility",
                    points: [
                      "You are responsible for monitoring your positions, balances, and risks.",
                      "VANNA is a non-custodial protocol; all actions are initiated by your wallet.",
                    ],
                  },
                  {
                    line: "No Guarantee of Returns",
                    points: [
                      "Using borrowed assets in trading, farming, or external protocols involves risk.",
                      "VANNA does not guarantee profits or protection against losses.",
                    ],
                  },
                ]}
                heading="Review and Sign Agreement"
                checkboxContent="I have read and agree to the VANNA Borrow Agreement."
                onClose={() => setActiveDialogue("none")}
              />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};


interface LeveragePreviewSectionProps {
  /** Pure collateral USD being deposited. */
  depositAmount: number;
  /** USD to be borrowed at the selected leverage. */
  projectedBorrowUsd: number;
  /** True in MB mode, where collateral is already on-account (no fresh deposit). */
  isMBMode: boolean;
  leverage: number;
  /** Account totals before the action (Σ collateral USD, Σ debt USD). */
  account: AccountTotals;
}

/**
 * Renders the before → after transaction preview for the Leverage Assets action
 * (leverage, deposit, collateral, debt, health factor, liquidation buffer). The
 * "before" state is the margin snapshot; the "after" state applies the account-wide
 * rule — the deposit AND the borrowed tokens both land in the margin vault, so
 * HF_after = (C + E + B) / (D + B). Returns null until there is something to preview.
 */
const LeveragePreviewSection = ({
  depositAmount,
  projectedBorrowUsd,
  isMBMode,
  leverage,
  account,
}: LeveragePreviewSectionProps) => {
  const effectiveDeposit = isMBMode ? 0 : depositAmount;
  if (effectiveDeposit <= 0 && projectedBorrowUsd <= 0) return null;

  const { collateralUsd, debtUsd } = account;
  const hfBefore = projectedHealthFactor(account, {});
  const bufferBefore = liquidationBufferUsd(collateralUsd, debtUsd);

  // Collateral after = C + E + B (borrowed tokens sit in the vault and count as collateral).
  const collateralAfter = collateralUsd + effectiveDeposit + projectedBorrowUsd;
  const debtAfter = debtUsd + projectedBorrowUsd;
  const hfAfter = projectedHealthFactor(account, { addCollateralUsd: effectiveDeposit, addBorrowUsd: projectedBorrowUsd });
  const bufferAfter = liquidationBufferUsd(collateralAfter, debtAfter);

  const rows: PreviewRow[] = [
    { label: "Leverage", before: "1.0x", after: `${leverage.toFixed(2)}x` },
    ...(effectiveDeposit > 0 ? [{ label: "You're depositing", before: formatUsd(0), after: formatUsd(depositAmount) }] : []),
    ...(projectedBorrowUsd > 0 ? [{ label: "You're borrowing", before: formatUsd(0), after: formatUsd(projectedBorrowUsd) }] : []),
    { label: "Margin Collateral", before: formatUsd(collateralUsd), after: formatUsd(collateralAfter), tone: "positive" as const },
    ...(projectedBorrowUsd > 0
      ? [{ label: "Outstanding Debt", before: formatUsd(debtUsd), after: formatUsd(debtAfter), tone: "negative" as const }]
      : []),
    {
      label: "Health Factor",
      before: formatHF(hfBefore),
      after: formatHF(hfAfter),
      tone: hfAfter >= hfBefore ? "positive" as const : "negative" as const,
    },
    {
      label: "Liquidation Buffer",
      before: formatUsd(bufferBefore),
      after: formatUsd(bufferAfter),
      tone: bufferAfter >= bufferBefore ? "positive" as const : "negative" as const,
    },
  ];

  return <MarginActionPreview rows={rows} className="mt-4" />;
};
