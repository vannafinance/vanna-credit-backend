"use client";

import { useTheme } from "@/contexts/theme-context";
import { useMarginHistory } from "@/hooks/use-margin";
import { useUserStore } from "@/store/user";
import { explorerUrl } from "@/lib/solana/config";
import { findToken } from "@/lib/solana/tokens";

const fmt = (v: string) => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 6 }) : v;
};

const time = (unix: number) =>
  unix ? new Date(unix * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

const Coin = ({ symbol }: { symbol: string }) => {
  const icon = findToken(symbol)?.icon;
  // eslint-disable-next-line @next/next/no-img-element
  return icon ? <img src={icon} alt={symbol} className="w-5 h-5 rounded-full" /> : <span className="w-5 h-5 rounded-full bg-[#444444]" />;
};

/** Aggregator logos for the "Swap via" column. */
const VIA_LOGO: Record<string, string> = { Jupiter: "/protocols/jupiter.png", Titan: "/protocols/titan.png" };

/**
 * The wallet's swaps, newest first — every margin-account Jupiter / Titan swap, decoded from the program's
 * own `MarginExecuted` events (spent / received per vault), so it is on-chain truth, not a cache.
 */
export const SwapHistory = () => {
  const { isDark } = useTheme();
  const address = useUserStore((s) => s.address);
  const { rows, isLoading } = useMarginHistory();
  if (!address) return null;
  const swaps = rows.filter((r) => r.type === "swap");
  const muted = isDark ? "text-[#A7A7A7]" : "text-[#777777]";
  const strong = isDark ? "text-white" : "text-[#111111]";

  return (
    <div className={`w-full rounded-2xl border p-5 flex flex-col gap-3 ${isDark ? "bg-[#1A1A1A] border-[#2A2A2A]" : "bg-white border-[#E2E2E2]"}`}>
      <div className="flex items-center justify-between">
        <span className={`text-[16px] font-semibold ${strong}`}>Swap history</span>
        <span className={`text-[11px] font-medium ${muted}`}>Margin account · via Jupiter / Titan</span>
      </div>
      {swaps.length === 0 ? (
        <div className={`py-8 text-center text-[13px] ${muted}`}>{isLoading ? "Loading swaps…" : "No swaps yet"}</div>
      ) : (
        <div className="flex flex-col">
          <div className={`hidden sm:grid grid-cols-[1.1fr_1.5fr_1.5fr_0.9fr_0.8fr_0.7fr] gap-3 px-2 pb-2 text-[11px] font-medium ${muted}`}>
            <span>Time</span>
            <span>Paid</span>
            <span>Received</span>
            <span>Swap via</span>
            <span>Health after</span>
            <span className="text-right">Tx</span>
          </div>
          {swaps.map((r) => (
            <div
              key={r.signature}
              className={`grid grid-cols-2 sm:grid-cols-[1.1fr_1.5fr_1.5fr_0.9fr_0.8fr_0.7fr] gap-3 items-center px-2 py-3 border-t text-[13px] ${
                isDark ? "border-[#2A2A2A]" : "border-[#EEEEEE]"
              } ${strong}`}
            >
              <span className={muted}>{time(r.timestamp)}</span>
              <span className="flex items-center gap-2">
                <Coin symbol={r.symbol} />
                <span className="text-[#FC5457]">−{fmt(r.amount)}</span> {r.symbol}
              </span>
              <span className="flex items-center gap-2">
                <Coin symbol={r.toSymbol ?? ""} />
                <span className="text-[#24A0A9]">+{fmt(r.toAmount ?? "0")}</span> {r.toSymbol}
              </span>
              <span className="flex items-center gap-1.5">
                {r.via && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={VIA_LOGO[r.via]} alt="" className="w-4 h-4 rounded-full" />
                )}
                {r.via ?? "—"}
              </span>
              <span className={muted}>{r.healthFactor === undefined ? "∞" : r.healthFactor.toFixed(3)}</span>
              <a href={explorerUrl("tx", r.signature)} target="_blank" rel="noopener noreferrer" className="text-right text-[#703AE6] underline">
                {r.signature.slice(0, 6)}…
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
