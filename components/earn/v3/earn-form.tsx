"use client";

/**
 * Supply / Withdraw form (V3 design `formHtml`), inline on the pool page and inside a modal
 * (mobile bottom sheet, and `EarnFormModal` for other screens).
 *
 * Same transactions and checks as before the redesign: `useSupplyLiquidity` (`lender_supply`) and
 * `useWithdrawLiquidity` (`lender_redeem`; the 100% pill redeems every share so no dust is left)
 * drive the progress modal + toasts and refresh pools / positions / wallet balances afterwards.
 * Every balance / cap / first-supply / liquidity check is done in exact base units (bigint),
 * mirroring what the program checks on-chain. Native SOL keeps SOL_FEE_RESERVE_LAMPORTS back for
 * fees and the temporary wSOL account's rent.
 */
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/v3/ui";
import { Icon } from "@/components/v3/icons";
import { usd } from "@/components/v3/format";
import { useWallet } from "@/hooks/use-wallet";
import { useUserStore } from "@/store/user";
import { usePoolData, usePoolDetails, useSupplyLiquidity, useUserPositions, useWithdrawLiquidity } from "@/hooks/use-earn";
import { useTokenPrices } from "@/hooks/use-token-prices";
import { validateAmountChange } from "@/lib/utils/sanitize-amount";
import { findToken, LENDING_TOKENS, TOKENS } from "@/lib/solana/tokens";
import { SOL_FEE_RESERVE_LAMPORTS } from "@/lib/solana/balances";
import { previewSupplyShares } from "@/lib/solana/lend";
import { fromRaw, lenderTotalAssets, MIN_INITIAL_SHARES, toRaw } from "@/lib/solana/math";
import { SV, usePop } from "./earn-ui";
import { fLoc, fP, fXr, shortAddr } from "./earn-format";

/** Parse a UI amount into raw base units; null when the text isn't a valid amount. */
const safeRaw = (value: string, decimals: number): bigint | null => {
  if (!value) return null;
  try {
    return toRaw(value, decimals);
  } catch {
    return null;
  }
};

const PCTS = [10, 25, 50, 100] as const;

export type EarnMode = "supply" | "withdraw";

/**
 * The form. `ctx` "page" switches pools by navigating to /earn/<SYM>; "modal" switches in place.
 * `withdrawOnly`: a pool the app no longer offers — only Withdraw, so a position can still exit.
 */
export function EarnForm({
  symbol,
  ctx = "page",
  initialMode = "supply",
  withdrawOnly = false,
  onSymbol,
  onDone,
}: {
  symbol: string;
  ctx?: "page" | "modal";
  initialMode?: EarnMode;
  withdrawOnly?: boolean;
  onSymbol?: (s: string) => void;
  onDone?: () => void;
}) {
  const router = useRouter();
  const { connectWallet } = useWallet();
  const token = findToken(symbol) ?? TOKENS[0];
  const sym = token.symbol;
  const [mode, setMode] = useState<EarnMode>(withdrawOnly ? "withdraw" : initialMode);
  const [amt, setAmt] = useState("");
  const [pct, setPct] = useState(0);
  const [all, setAll] = useState(false);
  const [more, setMore] = useState(false);
  const [lastSym, setLastSym] = useState(sym);
  const pop = usePop();

  // Reset the amount when the pool changes (render-time state sync, no effect needed).
  if (lastSym !== sym) {
    setLastSym(sym);
    setAmt("");
    setPct(0);
    setAll(false);
  }

  const userAddress = useUserStore((s) => s.address);
  const balances = useUserStore((s) => s.tokenBalances);
  const supply = useSupplyLiquidity();
  const withdraw = useWithdrawLiquidity();
  const { pools } = usePoolData();
  const { details } = usePoolDetails();
  const { positions } = useUserPositions();
  const prices = useTokenPrices([sym]);
  const pool = pools[sym];
  const detail = details[sym];
  const price = prices[sym] ?? 0;
  const pending = supply.isPending || withdraw.isPending;
  const sup = mode === "supply";

  // ── balances in raw units ─────────────────────────────────────────────────────────────────
  const walletRaw = useMemo(() => {
    const raw = safeRaw(balances[sym] ?? "0", token.decimals) ?? 0n;
    if (!token.isNative) return raw;
    const spendable = raw - SOL_FEE_RESERVE_LAMPORTS;
    return spendable > 0n ? spendable : 0n;
  }, [balances, sym, token]);
  const position = positions[sym];
  const positionRaw = position?.assetsRaw ?? 0n;
  const sharesRaw = position?.sharesRaw ?? 0n;
  const amountRaw = safeRaw(amt, token.decimals);
  const a = amountRaw ? Number(fromRaw(amountRaw, token.decimals)) : 0;

  // ── supply checks ─────────────────────────────────────────────────────────────────────────
  const isFirstSupply = detail ? detail.shareSupply === 0n : pool?.shareSupply === "0";
  const minFirstSupply = fromRaw(MIN_INITIAL_SHARES, token.decimals);
  const belowFirstMin = isFirstSupply && amountRaw !== null && amountRaw > 0n && amountRaw < MIN_INITIAL_SHARES;
  const capRoomRaw = useMemo(() => {
    const r = detail?.reserve;
    if (!r || r.supplyCap === 0n || !detail?.projected) return null;
    const room = r.supplyCap - lenderTotalAssets(detail.projected);
    return room > 0n ? room : 0n;
  }, [detail]);
  const exceedsCap = capRoomRaw !== null && amountRaw !== null && amountRaw > capRoomRaw;
  const supplyAllowed = !pool || (pool.initialised && (pool.status === "Active" || pool.status === "Supply only"));

  // ── withdraw checks ───────────────────────────────────────────────────────────────────────
  const poolAvail = pool?.availableLiquidity ?? 0;
  const redeemAllowed = !pool || pool.status !== "Frozen";
  const exceedsPosition = !all && amountRaw !== null && amountRaw > positionRaw;
  const exceedsLiquidity = a > poolAvail + 1e-12;

  let btn: string;
  let ok = false;
  if (!userAddress) btn = "Connect Wallet";
  else if (sup) {
    if (supply.isPending) btn = "Supplying...";
    else if (!supplyAllowed) btn = pool?.initialised ? `Pool is ${pool.status}` : "Pool not initialised";
    else if (!amountRaw || amountRaw <= 0n) btn = "Enter Amount";
    else if (amountRaw > walletRaw) btn = "Insufficient Balance";
    else if (belowFirstMin) btn = `First supply min ${minFirstSupply} ${sym}`;
    else if (exceedsCap) btn = "Exceeds Supply Cap";
    else {
      btn = "Supply Liquidity";
      ok = true;
    }
  } else {
    if (withdraw.isPending) btn = "Withdrawing...";
    else if (!redeemAllowed) btn = "Pool is Frozen";
    else if (sharesRaw === 0n) btn = "No Position";
    else if (!all && (!amountRaw || amountRaw <= 0n)) btn = "Enter Amount";
    else if (exceedsPosition) btn = "Insufficient Balance";
    else if (exceedsLiquidity) btn = "Exceeds Pool Liquidity";
    else {
      btn = all ? "Withdraw All" : "Withdraw Liquidity";
      ok = true;
    }
  }

  const reset = () => {
    setAmt("");
    setPct(0);
    setAll(false);
  };
  const clickPct = (x: number) => {
    setPct(x);
    if (sup) {
      // Exact base-unit math, so 100% can never exceed the spendable balance.
      if (walletRaw > 0n) setAmt(fromRaw((walletRaw * BigInt(x)) / 100n, token.decimals));
      setAll(false);
    } else if (positionRaw > 0n) {
      // 100% redeems every share (no dust); partial pills use exact base-unit math.
      setAll(x === 100);
      setAmt(fromRaw(x === 100 ? positionRaw : (positionRaw * BigInt(x)) / 100n, token.decimals));
    }
  };
  const submit = async () => {
    if (!userAddress) {
      void connectWallet();
      return;
    }
    if (!ok) return;
    try {
      // The hooks show the progress modal, success toast and a readable error, and refresh
      // pools / positions / wallet balances afterwards.
      if (sup) await supply.mutateAsync({ symbol: sym, amount: amt });
      else await withdraw.mutateAsync(all ? { symbol: sym, all: true } : { symbol: sym, amount: amt });
      reset();
      onDone?.();
    } catch {
      // Error already surfaced by the mutation hook.
    }
  };

  // ── preview ("More Details") ──────────────────────────────────────────────────────────────
  const xr = pool?.exchangeRate ?? 1;
  const apy = (pool?.supplyApr ?? 0) * 100;
  const tok = (n: number, d = 6) => `${fLoc(n, d)} ${sym}`;
  const sharesOut = detail && amountRaw ? fromRaw(previewSupplyShares(detail, amountRaw), token.decimals) : xr > 0 ? (a / xr).toFixed(token.decimals) : "0";
  const sharesIn = all ? (position?.shares ?? 0) : xr > 0 ? a / xr : 0;
  const rows: [string, string][] = sup
    ? [
        [`You Get (v${sym})`, `${sharesOut} v${sym}`],
        [`${sym} per v${sym}`, fXr(xr)],
        ["Current Supply APY", fP(apy)],
        ["Est. Monthly Earnings (at current APY)", tok((a * apy) / 100 / 12)],
        ["Est. Yearly Earnings (at current APY)", tok((a * apy) / 100)],
        ["Remaining Supply Cap", capRoomRaw === null ? "Uncapped" : `${fromRaw(capRoomRaw, token.decimals)} ${sym}`],
      ]
    : [
        [`You Receive (${sym})`, tok(a)],
        [`Shares Redeemed (v${sym})`, `${fLoc(sharesIn, 6)} v${sym}`],
        [`${sym} per v${sym}`, fXr(xr)],
        ["Current Supply APY", fP(apy)],
        ["Pool Available Liquidity", tok(poolAvail)],
      ];

  const walletUi = Number(fromRaw(walletRaw, token.decimals));
  const positionUi = Number(fromRaw(positionRaw, token.decimals));
  const balTxt = sup
    ? `Bal: ${userAddress ? `${fLoc(walletUi, 4)} ${sym}` : `-- ${sym}`}`
    : `Supplied: ${userAddress && positionUi > 0 ? `${fLoc(positionUi, 4)} ${sym}` : `-- ${sym}`}`;
  const popKey = `ftok-${ctx}`;
  const pctBase = sup ? walletRaw : positionRaw;

  return (
    <section className={`earn-fm${ctx === "modal" ? " in-modal" : ""}`} aria-label="Liquidity Management">
      <nav className="earn-btabs fm" aria-label="Liquidity Actions">
        {!withdrawOnly && (
          <button
            type="button"
            className={sup ? "on" : ""}
            onClick={() => {
              setMode("supply");
              reset();
            }}
          >
            Supply Liquidity
          </button>
        )}
        <button
          type="button"
          className={sup ? "" : "on"}
          onClick={() => {
            setMode("withdraw");
            reset();
          }}
        >
          Withdraw Liquidity
        </button>
      </nav>
      <div className="earn-fin">
        <div className="earn-fr1">
          <div className="earn-ftw" data-earn-pop={popKey}>
            <button type="button" className="earn-ftok" aria-haspopup="listbox" aria-expanded={pop.open === popKey} onClick={() => pop.toggle(popKey)}>
              <Icon sym={sym} className="earn-i20" />
              <span>{sym}</span>
              {SV.chev14}
            </button>
            {pop.open === popKey && (
              <div className="pop earn-pop tok" role="listbox">
                {LENDING_TOKENS.map((t) => (
                  <button
                    key={t.symbol}
                    type="button"
                    className={t.symbol === sym ? "on" : ""}
                    role="option"
                    aria-selected={t.symbol === sym}
                    onClick={() => {
                      pop.close();
                      if (t.symbol === sym) return;
                      if (onSymbol) onSymbol(t.symbol);
                      else router.push(`/earn/${t.symbol}`);
                    }}
                  >
                    <Icon sym={t.symbol} className="earn-i16" />
                    {sup ? t.symbol : `v${t.symbol}`}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="earn-famt">
            <label className="earn-sr" htmlFor={`earn-amt-${ctx}`}>
              {sup ? "Supply Amount" : "Withdraw Amount"}
            </label>
            <input
              id={`earn-amt-${ctx}`}
              type="text"
              inputMode="decimal"
              placeholder="0"
              autoComplete="off"
              value={amt}
              disabled={pending}
              onChange={(e) => {
                const v = validateAmountChange(e.target.value);
                if (v === null) return;
                setAmt(v);
                setPct(0);
                setAll(false);
              }}
            />
            <div className="earn-fusd num">~ {price > 0 ? usd(a * price) : "—"}</div>
          </div>
        </div>
        <div className="earn-fr2">
          <div className="earn-pcts">
            {PCTS.map((x) => (
              <button key={x} type="button" className={pct === x ? `on p${x}` : ""} disabled={!userAddress || pending || pctBase <= 0n} onClick={() => clickPct(x)}>
                {x}%
              </button>
            ))}
          </div>
          <span
            className="earn-fbal num"
            title={sup && userAddress && token.isNative ? `Spendable: ${fromRaw(walletRaw, 9)} SOL (${fromRaw(SOL_FEE_RESERVE_LAMPORTS, 9)} SOL kept for fees)` : undefined}
          >
            {balTxt}
          </span>
        </div>
      </div>
      <article className={`earn-more${more ? " on" : ""}`}>
        <button type="button" className="earn-moreh" aria-expanded={more} onClick={() => setMore((m) => !m)}>
          More Details {SV.chev}
        </button>
        {more && (
          <div className="earn-morel">
            {rows.map(([k, v]) => (
              <div key={k}>
                <span>{k}</span>
                <b className="num">{v}</b>
              </div>
            ))}
          </div>
        )}
      </article>
      <button type="button" className="earn-cta" disabled={userAddress ? !ok : false} onClick={submit}>
        {btn}
      </button>
      {sup && isFirstSupply && pool?.initialised && (
        <div className="earn-res">
          This pool is empty — the first supply must be at least {minFirstSupply} {sym}.
        </div>
      )}
      <div className="earn-res">Reserve: {pool?.reserve ? shortAddr(pool.reserve) : "—"}</div>
    </section>
  );
}

/**
 * The form in a modal (design `EarnAPI.open(sym, mode)`): used by the pool page's mobile sheet and
 * available to other screens (e.g. Portfolio) to supply / withdraw without leaving the page.
 */
export function EarnFormModal({ symbol, mode, onClose }: { symbol: string; mode: EarnMode; onClose: () => void }) {
  const [sym, setSym] = useState(findToken(symbol)?.symbol ?? "USDC");
  const pool = usePoolData().pools[sym];
  const withdrawOnly = !(findToken(sym)?.lendable ?? true);
  return (
    <Modal onClose={onClose} className="earn-modal">
      <div className="earn">
        <h2>
          {mode === "supply" && !withdrawOnly ? "Supply" : "Withdraw"} {sym}
        </h2>
        <p className="msub">
          {sym} vault · {fP((pool?.supplyApr ?? 0) * 100)} supply APY
        </p>
        <EarnForm symbol={sym} ctx="modal" initialMode={mode} withdrawOnly={withdrawOnly} onSymbol={setSym} onDone={onClose} />
      </div>
    </Modal>
  );
}
