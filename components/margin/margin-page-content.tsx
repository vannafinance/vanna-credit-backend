"use client";

import "./margin-v3.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Banner } from "@/components/v3/ui";
import { FlashRepayButton } from "@/components/v3/flash-repay";
import { hfFmt, levFmt, usdC } from "@/components/v3/format";
import { LIQ_HF, hfZone } from "@/lib/account-model";
import { useWallet } from "@/hooks/use-wallet";
import { useFarmPositions } from "@/lib/farm/use-farm";
import { applyMarginSnapshot, checkUserMarginAccount } from "@/store/margin-account-info-store";
import { useAccountSnapshot } from "@/hooks/use-account-snapshot";
import { useMarginScreen } from "./use-margin-screen";
import { liqBuffer, noDebt } from "./mg-sim";
import { LblTip, MI, SIC, TIPS } from "./mg-ui";
import { LeverageTab } from "./mg-leverage";
import { RepayTab } from "./mg-repay";
import { TransferTab } from "./mg-transfer";
import { RightColumn } from "./mg-right";
import { Positions } from "./mg-positions";

interface MarginPageContentProps {
  /** Path this page lives at — the ?repay=<asset> hand-off is stripped back to it. */
  basePath: string;
}

type Tab = "lev" | "repay" | "transfer";
const TABS: [Tab, string, string][] = [
  ["lev", "Leverage your Assets", "Leverage"],
  ["repay", "Repay Loan", "Repay"],
  ["transfer", "Transfer Collateral", "Transfer"],
];

/**
 * The margin page (rendered at both `/` and `/margin` — same UX), V3 design: liquidation-risk
 * banner, promo carousel, account stats strip, the Leverage / Repay / Transfer panel, Margin Account
 * Info + Liquidation + Oracles, and the positions section.
 *
 * Health factor, leverage, room before liquidation, liquidation prices and every before → after
 * preview come from the program-exact account model (`useV3Account`, lib/account-model.ts:
 * HF = Σ collateral / Σ debt, unweighted, liquidatable at ≤ 1.10). Per-token balances, debts and
 * borrow rates come from the on-chain margin snapshot (GET /api/account/:wallet via
 * `useAccountSnapshot`, fed into the margin store with `applyMarginSnapshot`). Nothing is persisted.
 *
 * useSearchParams() opts the page out of static prerendering, so callers wrap this in a Suspense
 * boundary.
 */
export const MarginPageContent = ({ basePath }: MarginPageContentProps) => {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { connectWallet, refreshBalances } = useWallet();
  const m = useMarginScreen();
  const { positions: farm } = useFarmPositions(m.address);
  const [tab, setTab] = useState<Tab>("lev");
  const [prefill, setPrefill] = useState<{ sym: string; n: number } | undefined>(undefined);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const topRef = useRef<HTMLHeadingElement>(null);

  const scrollToPanel = useCallback(() => {
    setTimeout(() => topRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }, []);

  /** Positions-row Repay / Portfolio hand-off: open the Repay tab on that asset. */
  const openRepay = useCallback(
    (sym?: string) => {
      setTab("repay");
      if (sym) setPrefill((p) => ({ sym, n: (p?.n ?? 0) + 1 }));
      scrollToPanel();
    },
    [scrollToPanel],
  );

  // Portfolio's per-asset Repay button hands off here via ?repay=<asset> — consume it once on
  // arrival, then strip it from the URL so a manual refresh doesn't re-trigger the tab switch.
  useEffect(() => {
    const repayAsset = searchParams.get("repay");
    if (repayAsset !== null) {
      openRepay(repayAsset || undefined);
      router.replace(basePath);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Discover the margin account whenever the wallet connects (margin state is reset on
  // disconnect and rediscovered from chain — nothing is persisted client-side).
  useEffect(() => {
    if (m.address && m.connected) {
      checkUserMarginAccount(m.address).catch(console.error);
      refreshBalances(m.address).catch(() => {});
    }
  }, [m.address, m.connected, refreshBalances]);

  // Feed each fresh snapshot into the store (shallow replace) so every consumer reads the same numbers.
  const { snapshot } = useAccountSnapshot(m.address);
  useEffect(() => {
    if (snapshot?.api?.margin) applyMarginSnapshot(snapshot.api.margin);
  }, [snapshot]);

  const n = m.now;
  const nd = noDebt(n);
  const on = m.connected && m.hasAccount;
  const perps = m.acct.view?.positions.length ?? 0;
  // Flash repay needs something to unwind; flash transfer also accepts plain collateral.
  const exposure = on && (!nd || perps > 0 || m.model.phoenixCollateral > 0.01 || farm.length > 0);
  const flashable = on && (exposure || n.holdings > 0.01);
  const danger = on && !nd && n.hf <= LIQ_HF;
  const error = m.snapshotError && m.snapshotError !== dismissedError ? m.snapshotError : null;
  const dash = m.loading;

  const stats: [React.ReactNode, string, React.ReactNode, string][] = [
    [SIC.health, "Net Health Factor", <span key="h" className={nd ? "z-ok" : hfZone(n.hf)}>{dash ? "—" : nd ? "No debt" : hfFmt(n.hf)}</span>, TIPS.hf],
    [SIC.liq, "Collateral Left Before Liquidation", dash ? "—" : nd ? <span className="z-ok">No debt</span> : usdC(liqBuffer(n)), TIPS.buffer],
    [SIC.dollar, "Net Available Collateral", dash ? "—" : usdC(n.equity), TIPS.equity],
    [SIC.retry, "Net amount Borrowed", dash ? "—" : usdC(n.debt), TIPS.borrowed],
    [SIC.bag, "Net Leverage Taken", dash ? "—" : levFmt(n.leverage), TIPS.lev],
  ];

  return (
    <main className="v3">
      <div className="page mg">
        {error && (
          <div className="mg-rd" role="alert">
            <span style={{ flex: 1 }}>{error}</span>
            <button type="button" aria-label="Dismiss" onClick={() => setDismissedError(m.snapshotError)}>
              {MI.dash}
            </button>
          </div>
        )}
        {danger && (
          <div className="mg-dg" role="alert">
            {MI.alert}
            <div>
              <b>Liquidation Risk — Health Factor {hfFmt(n.hf)} (at or below 1.10)</b>
              <p>Your account is undercollateralised and can be liquidated by anyone. Repay debt or add collateral immediately to restore your Health Factor above 1.1.</p>
            </div>
            <FlashRepayButton className="mg-fbtn" />
          </div>
        )}
        <div className="mg-bnw">
          <Banner page="margin" />
        </div>
        {m.connected && (
          <section className="mg-stats">
            {stats.map(([ic, k, v, t]) => (
              <article key={k}>
                <div className="mg-sh">
                  <span className="mg-si">{ic}</span>
                  <span className="mg-sk">
                    <LblTip k={k} tip={t} />
                  </span>
                </div>
                <div className="mg-sv num">{v}</div>
              </article>
            ))}
          </section>
        )}
        <section className="mg-main">
          <h1 className="mg-h1" ref={topRef}>
            Leverage your Collateral
          </h1>
          <div className="mg-cols">
            <div className="mg-left">
              <section className="mg-panel">
                <nav className="mg-tabs" role="tablist" aria-label="Margin actions">
                  {TABS.map(([k, l, s]) => (
                    <button key={k} type="button" role="tab" aria-selected={tab === k} className={`mg-tab ${tab === k ? "on" : ""}`} onClick={() => setTab(k)}>
                      <span className="mg-l">{l}</span>
                      <span className="mg-s">{s}</span>
                    </button>
                  ))}
                </nav>
                <section className="mg-tc">
                  {tab === "lev" ? (
                    <LeverageTab m={m} connectWallet={() => void connectWallet()} />
                  ) : tab === "repay" ? (
                    <RepayTab m={m} prefill={prefill} flashable={exposure} />
                  ) : (
                    <TransferTab m={m} flashable={flashable} />
                  )}
                </section>
              </section>
            </div>
            <aside className="mg-right">
              <RightColumn m={m} />
            </aside>
          </div>
          {m.connected && <Positions m={m} flashable={exposure} onRepay={openRepay} onOpen={() => { setTab("lev"); scrollToPanel(); }} />}
        </section>
      </div>
    </main>
  );
};
