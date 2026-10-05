"use client";

import { useTheme } from "@/contexts/theme-context";
import type { RouteStep, Token } from "./types";

interface RouteInfoProps {
  route: RouteStep[] | null;
  isLoading?: boolean;
  dex: string | null;
}

/** One leg of the path between two consecutive tokens; a split leg has several AMMs. */
interface Leg {
  from: Token;
  to: Token;
  amms: { name: string; percent?: number }[];
}

/**
 * Collapses Jupiter's routePlan into the token path (in → … → out) with every AMM of each leg
 * (a split route sends parts of one leg through several AMMs, each with its share).
 */
function toLegs(route: RouteStep[]): Leg[] {
  const legs: Leg[] = [];
  for (const step of route) {
    const leg = legs.find((l) => l.from.symbol === step.tokenIn.symbol && l.to.symbol === step.tokenOut.symbol);
    const amm = { name: step.protocol, percent: step.percentage !== undefined && step.percentage < 100 ? step.percentage : undefined };
    if (leg) leg.amms.push(amm);
    else legs.push({ from: step.tokenIn, to: step.tokenOut, amms: [amm] });
  }
  return legs;
}

const TokenNode = ({ token, isDark }: { token: Token; isDark: boolean }) => (
  <div className="flex flex-col items-center gap-1.5 shrink-0 w-14">
    <div
      className={`w-9 h-9 rounded-full overflow-hidden flex items-center justify-center ring-2 ${
        isDark ? "ring-[#2A2A2A] bg-[#333333]" : "ring-white bg-[#E2E2E2]"
      }`}
    >
      {token.logo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={token.logo} alt={token.symbol} className="w-9 h-9 object-cover" />
      ) : (
        <span className={`text-[11px] font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>{token.symbol.slice(0, 2)}</span>
      )}
    </div>
    <span className={`text-[11px] font-semibold leading-[14px] ${isDark ? "text-white" : "text-[#111111]"}`}>{token.symbol}</span>
  </div>
);

export const RouteInfo = ({ route, isLoading, dex }: RouteInfoProps) => {
  const { isDark } = useTheme();
  if (!route && !isLoading) return null;
  const legs = route ? toLegs(route) : [];
  const amms = [...new Set(legs.flatMap((l) => l.amms.map((a) => a.name)))];
  const muted = isDark ? "text-[#A7A7A7]" : "text-[#777777]";

  return (
    <div
      className={`rounded-xl p-4 flex flex-col gap-4 transition-colors ${
        isDark ? "bg-[#1A1A1A] border border-[#2A2A2A]" : "bg-[#F7F7F7] border border-[#EEEEEE]"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`text-[12px] font-semibold leading-[18px] ${muted}`}>Route</span>
          {legs.length > 0 && (
            <span className={`text-[11px] font-medium truncate ${muted}`}>
              · {legs.length} {legs.length === 1 ? "hop" : "hops"} · {amms.join(", ")}
            </span>
          )}
        </div>
        {dex && (
          <span className="shrink-0 text-[11px] font-semibold leading-[15px] px-2.5 py-0.5 rounded-full text-white bg-linear-to-r from-[#FC5457] to-[#703AE6]">
            via {dex}
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center gap-3">
          <div className={`w-9 h-9 rounded-full animate-pulse ${isDark ? "bg-[#333333]" : "bg-[#E2E2E2]"}`} />
          <div className={`flex-1 h-1 rounded animate-pulse ${isDark ? "bg-[#333333]" : "bg-[#E2E2E2]"}`} />
          <div className={`w-9 h-9 rounded-full animate-pulse ${isDark ? "bg-[#333333]" : "bg-[#E2E2E2]"}`} />
        </div>
      ) : legs.length > 0 ? (
        <div className="flex items-center w-full">
          {legs.map((leg, index) => (
            <div key={`${leg.from.symbol}-${leg.to.symbol}-${index}`} className="flex items-center flex-1 min-w-0">
              {index === 0 && <TokenNode token={leg.from} isDark={isDark} />}
              {/* Connector: AMM badges over a gradient line with an arrow head */}
              <div className="flex-1 min-w-0 flex flex-col items-center gap-1.5 px-1 -mt-5">
                <div className="flex flex-wrap justify-center gap-1">
                  {leg.amms.map((amm, k) => (
                    <span
                      key={`${amm.name}-${k}`}
                      className={`px-2 py-0.5 rounded-md text-[10px] font-semibold leading-[14px] whitespace-nowrap border ${
                        isDark ? "bg-[#222222] border-[#333333] text-[#E5E5E5]" : "bg-white border-[#E2E2E2] text-[#333333]"
                      }`}
                    >
                      {amm.name}
                      {amm.percent !== undefined && <span className="text-[#703AE6]"> · {amm.percent}%</span>}
                    </span>
                  ))}
                </div>
                <div className="relative w-full flex items-center">
                  <div className="flex-1 h-[2px] rounded-full bg-linear-to-r from-[#FC5457] to-[#703AE6] opacity-80" />
                  <svg width="8" height="10" viewBox="0 0 8 10" fill="none" className="-ml-px shrink-0">
                    <path d="M1 1L6.5 5L1 9" stroke="#703AE6" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
              </div>
              <TokenNode token={leg.to} isDark={isDark} />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
};
