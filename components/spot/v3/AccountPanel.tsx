"use client";

/**
 * Spot's "Margin account" card (design spot.js acctPanel): status chip, health factor with the
 * 1.10 liquidation meter, account leverage, borrowed, swappable <token>, <token> liquidation price
 * and room before liquidation — each "now → after this swap" while the card has a quote.
 * Every number comes from `useV3Account()` (program-exact model) and the margin snapshot; the
 * "after" side re-runs the same model on the account with the swap applied (./swap-model).
 */
import Link from "next/link";
import { useMemo } from "react";
import { useMarginAccountInfoStore } from "@/store/margin-account-info-store";
import { useV3Account } from "@/hooks/use-v3-account";
import { LIQ_HF, hfPos, hfZone, isStable } from "@/lib/account-model";
import { FlashRepayButton } from "@/components/v3/flash-repay";
import { Info } from "@/components/v3/ui";
import { IC } from "@/components/v3/icons";
import { hfFmt, hfLabel, levFmt, nf, price, roomSub, roomText, roomZone, tokFmt, usd } from "@/components/v3/format";
import { viewOf, withSwap, type SwapPreview } from "./swap-model";
import { VannaLoader } from "@/components/v3/vanna-loader";

const TIPS = {
  hf: "Everything the margin account holds ÷ everything it owes, at on-chain prices. At 1.10 or below the account can be liquidated.",
  lev: "Market exposure (volatile tokens + perp notional) ÷ equity.",
  borrowed: "Everything the margin account owes Vanna's lending pools, with interest accrued, at on-chain prices.",
  liq: "The price of this token at which the whole account reaches health factor 1.10, every other price held.",
  room: "The smallest single price move that would make the account liquidatable, and the move of all prices together.",
};

/** One "label · value (→ after)" row. */
function Row({ k, tip, now, after, sub }: { k: string; tip?: string; now: React.ReactNode; after?: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="sp-ar">
      <span>
        {k} {tip && <Info text={tip} />}
      </span>
      <span className="num">
        {after !== undefined ? (
          <span className="ba">
            <span className="o">{now}</span>
            {IC.arrow}
            <span>{after}</span>
          </span>
        ) : (
          now
        )}
        {sub && <small>{sub}</small>}
      </span>
    </div>
  );
}

/** The Spot page's margin-account block. `preview` = what the swap card is about to do. */
export function AccountPanel({ preview }: { preview: SwapPreview | null }) {
  const acct = useV3Account();
  const balances = useMarginAccountInfoStore((s) => s.collateralBalances);
  const { state, now, room, priceOf } = acct;
  const from = preview?.from ?? "SOL";
  const to = preview?.to ?? "USDC";
  // The volatile token of the pair, for the liquidation-price row.
  const vol = !isStable(to) ? to : !isStable(from) ? from : null;
  const debtSyms = useMemo(() => new Set(state?.debts.map((d) => d.symbol) ?? []), [state]);
  const holds = (s: string) => (state?.collateral ?? []).some((c) => c.symbol === s);
  const sideOf = (s: string): "long" | "short" => (debtSyms.has(s) && !holds(s) ? "short" : "long");

  const after = useMemo(() => {
    if (!state || !preview?.quoted || !(preview.inUsd > 0)) return null;
    return viewOf(withSwap(state, preview.from, preview.inUsd, preview.to, preview.outUsd));
  }, [state, preview]);

  if (!acct.hasMargin || !state || !now || !room) {
    return (
      <aside className="sp-acct" aria-label="Margin account">
        <div className="sp-ah">
          <span>Margin account</span>
        </div>
        {acct.loading ? (
          <VannaLoader caption="Loading your margin account" />
        ) : (
          <p className="mut" style={{ fontSize: 13 }}>
            Swaps run inside a Vanna margin account. Create one and deposit collateral to start.
          </p>
        )}
        {!acct.loading && (
          <div className="sp-afoot">
            <Link className="btn-s" href="/margin">
              Open margin account
            </Link>
          </div>
        )}
      </aside>
    );
  }

  const hf0 = now.hf;
  const hf1 = after?.numbers.hf;
  const fromAmt = parseFloat(balances[from]?.amount ?? "0") || 0;
  const fromPx = priceOf(from);
  const fromAfter = after && fromPx > 0 ? Math.max(0, fromAmt - preview!.inUsd / fromPx) : undefined;
  const volPx = vol ? priceOf(vol) : 0;
  const lp0 = vol ? acct.liqPriceOf(vol, sideOf(vol)) : null;
  const lp1 = vol && after ? after.liqPrice(vol, volPx, sideOf(vol)) : undefined;
  const lpF = (x: number | null) => (x === null ? "None" : `$${price(x)}`);
  const hb = (h: number, cls = "") => <i className={cls} style={{ left: `${hfPos(Math.min(h, 2.5))}%` }} />;
  const roomEl = (r: typeof room) => <span className={roomZone(r)}>{roomText(r)}</span>;

  return (
    <aside className="sp-acct" aria-label="Margin account">
      <div className="sp-ah">
        <span>Margin account</span>
        <span className={`sp-zone ${hfZone(hf0)}`}>{Number.isFinite(hf0) && hf0 < 100 ? hfLabel(hf0) : "No debt"}</span>
      </div>
      <div className="sp-hfv">
        <span className="lbl">
          Health factor <Info text={TIPS.hf} />
        </span>
        <div className="sp-hfn num">
          {hf1 !== undefined ? (
            <>
              <span className={`o ${hfZone(hf0)}`}>{hfFmt(hf0)}</span>
              {IC.arrow}
              <b className={hfZone(hf1)}>{hfFmt(hf1)}</b>
            </>
          ) : (
            <b className={hfZone(hf0)}>{hfFmt(hf0)}</b>
          )}
        </div>
        <div className="sp-barw">
          <div className="hfbar sp-bar">
            {hf1 !== undefined ? (
              <>
                {hb(hf0, "o")}
                {hb(hf1)}
              </>
            ) : (
              hb(hf0)
            )}
          </div>
          <div className="sp-barl">
            <span style={{ left: `${hfPos(LIQ_HF)}%` }}>{nf(LIQ_HF, 2)} liquidation</span>
            <span className="r">2.50+</span>
          </div>
        </div>
      </div>
      <div className="sp-arows">
        <Row k="Account leverage" tip={TIPS.lev} now={levFmt(now.leverage)} after={after ? levFmt(after.numbers.leverage) : undefined} />
        <Row k="Borrowed" tip={TIPS.borrowed} now={usd(now.debt, 2)} />
        <Row
          k={`Swappable ${from}`}
          tip={`${from} in your margin account. Every token there is collateral and swappable at once; the health check runs after each swap.`}
          now={tokFmt(fromAmt, from)}
          after={fromAfter !== undefined ? tokFmt(fromAfter, from) : undefined}
        />
        {vol && <Row k={`${vol} liq. price`} tip={TIPS.liq} now={lpF(lp0)} after={lp1 !== undefined ? lpF(lp1) : undefined} />}
        <Row
          k="Room before liquidation"
          tip={TIPS.room}
          now={roomEl(room)}
          after={after ? roomEl(after.room) : undefined}
          sub={roomSub(after ? after.room : room)}
        />
      </div>
      <div className="sp-afoot">
        <Link className="btn-s" href="/margin">
          Borrow more
        </Link>
        <FlashRepayButton className="btn-s" disabled={!(now.debt > 0)} />
      </div>
    </aside>
  );
}
