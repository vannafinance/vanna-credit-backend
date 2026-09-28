"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useState } from "react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/contexts/theme-context";
import { runFaucet, type FaucetResult } from "@/lib/faucet-utils";
import { TOKENS } from "@/lib/solana/tokens";
import { refreshWalletBalancesOnChain } from "@/hooks/use-wallet";
import toast from "react-hot-toast";

interface FaucetPopupProps {
  isOpen: boolean;
  onClose: () => void;
  walletAddress: string | null;
}

type Status = "idle" | "loading" | "success" | "error";

interface RowState {
  status: Status;
  message?: string;
}

/**
 * One row per registry token — the faucet never hardcodes its token list. Top-ups are unlimited
 * (fork cheatcodes), so there is no one-time / cooldown state to remember, and nothing is kept in
 * localStorage: balances shown after a mint come straight from the chain.
 */
const initialRows = (): Record<string, RowState> =>
  Object.fromEntries(TOKENS.map((t) => [t.symbol, { status: "idle" as Status }]));

const fmt = (value?: string) => {
  const n = Number(value ?? "0");
  return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 4 }) : value ?? "0";
};

export const FaucetPopup = ({ isOpen, onClose, walletAddress }: FaucetPopupProps) => {
  const { isDark } = useTheme();
  const [rows, setRows] = useState<Record<string, RowState>>(initialRows);
  const [isMintingAll, setIsMintingAll] = useState(false);

  // Reset row feedback when the connected wallet changes (adjusting state during render is
  // React's recommended alternative to a reset effect).
  const [rowsWallet, setRowsWallet] = useState(walletAddress);
  if (rowsWallet !== walletAddress) {
    setRowsWallet(walletAddress);
    setRows(initialRows());
  }

  const updateRow = (symbol: string, patch: Partial<RowState>) => {
    setRows((prev) => ({ ...prev, [symbol]: { ...prev[symbol], ...patch } }));
  };

  const applyResult = (symbol: string, result: FaucetResult) => {
    if (result.ok) updateRow(symbol, { status: "success", message: `+${fmt(result.added)} · balance ${fmt(result.balance)}` });
    else updateRow(symbol, { status: "error", message: result.error || "Failed" });
  };

  const mintOne = async (symbol: string) => {
    if (!walletAddress) {
      toast.error("Connect your wallet first");
      return;
    }
    updateRow(symbol, { status: "loading", message: undefined });
    const result = await runFaucet(symbol, walletAddress);
    applyResult(symbol, result);
    if (!result.ok) toast.error(`${symbol}: ${result.error}`);
    else toast.success(`+${fmt(result.added)} ${symbol}`);
    await refreshWalletBalancesOnChain(walletAddress).catch(() => {});
  };

  const mintAll = async () => {
    if (!walletAddress) {
      toast.error("Connect your wallet first");
      return;
    }
    setIsMintingAll(true);
    // Sequential: each cheatcode reads-then-sets one account, and SOL first keeps the wallet
    // rent-funded before its token accounts are written.
    const results: FaucetResult[] = [];
    for (const t of TOKENS) {
      updateRow(t.symbol, { status: "loading", message: undefined });
      const r = await runFaucet(t.symbol, walletAddress);
      applyResult(t.symbol, r);
      results.push(r);
    }
    setIsMintingAll(false);
    await refreshWalletBalancesOnChain(walletAddress).catch(() => {});
    const failed = results.filter((r) => !r.ok);
    if (failed.length === 0) toast.success("Wallet topped up");
    else toast.error(`${failed.length} faucet(s) failed — see panel for details`);
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-[2000] bg-black/60 backdrop-blur-sm"
            onClick={onClose}
          />
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.97 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            className={`fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[2001] w-[92vw] max-w-[440px] rounded-[16px] overflow-hidden ${
              isDark
                ? "bg-[#161616] border border-[#2A2A2A]"
                : "bg-white border border-[#E8E8E8]"
            }`}
            style={{
              boxShadow: isDark
                ? "0 24px 64px rgba(0,0,0,0.6), 0 0 0 0.5px rgba(255,255,255,0.04)"
                : "0 24px 64px rgba(0,0,0,0.18), 0 0 0 0.5px rgba(0,0,0,0.04)",
            }}
            role="dialog"
            aria-modal="true"
            aria-label="Fork token faucet"
          >
            {/* Header */}
            <div
              className={`px-5 py-4 border-b flex items-start justify-between gap-3 ${
                isDark ? "border-[#222]" : "border-[#F0F0F0]"
              }`}
            >
              <div>
                <h2
                  className={`text-[16px] font-semibold ${
                    isDark ? "text-white" : "text-[#111]"
                  }`}
                >
                  Faucet
                </h2>
                <p
                  className={`text-[12px] mt-0.5 ${
                    isDark ? "text-[#888]" : "text-[#666]"
                  }`}
                >
                  Top up 1,000 of each token on the Solana mainnet fork
                </p>
              </div>
              <button
                onClick={onClose}
                aria-label="Close faucet"
                className={`p-1.5 rounded-md transition-colors ${
                  isDark
                    ? "text-[#999] hover:text-white hover:bg-[#222]"
                    : "text-[#666] hover:text-[#111] hover:bg-[#F2F2F2]"
                }`}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path
                    d="M3 3l8 8M11 3l-8 8"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>

            {/* Token rows */}
            <div className="p-2.5 flex flex-col gap-1.5">
              {TOKENS.map((token) => (
                <FaucetRow
                  key={token.symbol}
                  label={token.symbol}
                  icon={token.icon}
                  description={`+${token.faucetAmount.toLocaleString("en-US")} ${token.name}`}
                  state={rows[token.symbol] ?? { status: "idle" }}
                  isDark={isDark}
                  disabled={!walletAddress || isMintingAll}
                  onMint={() => mintOne(token.symbol)}
                />
              ))}
            </div>

            {/* Action footer */}
            <div
              className={`px-5 py-3 border-t flex items-center justify-between gap-3 ${
                isDark ? "border-[#222]" : "border-[#F0F0F0]"
              }`}
            >
              <p
                className={`text-[11px] ${
                  isDark ? "text-[#888]" : "text-[#666]"
                }`}
              >
                {walletAddress
                  ? "Funded instantly via fork cheatcodes — no wallet approval needed."
                  : "Connect wallet to use the faucet."}
              </p>
              <div className="shrink-0">
                <Button
                  size="small"
                  type="gradient"
                  text={isMintingAll ? "Funding..." : "Fund All"}
                  disabled={!walletAddress || isMintingAll}
                  onClick={mintAll}
                />
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
};

interface FaucetRowProps {
  label: string;
  icon: string;
  description: string;
  state: RowState;
  isDark: boolean;
  disabled: boolean;
  onMint: () => void;
}

const FaucetRow = ({ label, icon, description, state, isDark, disabled, onMint }: FaucetRowProps) => {
  const { status, message } = state;

  // Subtitle: prefer error / status feedback, fall back to the top-up description.
  let subtitle: string = description;
  if (status === "loading") subtitle = "Funding...";
  else if (status === "success") subtitle = message ?? "Funded";
  else if (status === "error") subtitle = `Error: ${message}`;

  let buttonText: string = "Fund";
  if (status === "loading") buttonText = "...";
  else if (status === "error") buttonText = "Retry";

  return (
    <div
      className={`flex items-center gap-3 rounded-[12px] px-3 py-2.5 ${
        isDark ? "bg-[#1C1C1C]" : "bg-[#F7F7F7]"
      }`}
    >
      <div className="w-9 h-9 rounded-full overflow-hidden shrink-0 bg-white/5 flex items-center justify-center">
        <Image src={icon} alt={label} width={28} height={28} />
      </div>
      <div className="flex-1 min-w-0">
        <p
          className={`text-[13px] font-semibold leading-tight ${
            isDark ? "text-white" : "text-[#111]"
          }`}
        >
          {label}
        </p>
        <p
          className={`text-[11px] mt-0.5 truncate ${
            isDark ? "text-[#888]" : "text-[#666]"
          }`}
          title={status === "error" ? message : description}
        >
          {subtitle}
        </p>
      </div>
      <button
        onClick={onMint}
        disabled={disabled || status === "loading"}
        className={`shrink-0 text-[12px] font-semibold rounded-md px-3 py-1.5 transition-colors ${
          disabled || status === "loading"
            ? isDark
              ? "bg-[#222] text-[#555] cursor-not-allowed"
              : "bg-[#EEE] text-[#999] cursor-not-allowed"
            : status === "success"
            ? "bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/25 cursor-pointer"
            : status === "error"
            ? "bg-[#FC5457]/15 text-[#FC5457] hover:bg-[#FC5457]/25 cursor-pointer"
            : isDark
            ? "bg-[#2A2A2A] text-white hover:bg-[#333] cursor-pointer"
            : "bg-[#111] text-white hover:bg-[#000] cursor-pointer"
        }`}
      >
        {buttonText}
      </button>
    </div>
  );
};
