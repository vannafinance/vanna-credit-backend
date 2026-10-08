"use client";

/**
 * Close a spot position (design spot.js closeModalHtml), with a real quote before anything is sent:
 * a long sells the token for USDC through a margin swap; a short buys the owed token back with margin
 * USDC and repays the loan from the margin vault (./close-position). Shows entry · mark, what is sold /
 * bought, the quote, the estimated realized P&L and the health factor / leverage after.
 */
import { useEffect, useMemo, useState } from "react";
import { useMarginAccountInfoStore } from "@/store/margin-account-info-store";
import { useUserStore } from "@/store/user";
import { useV3Account } from "@/hooks/use-v3-account";
import { useAfterMarginTx } from "@/hooks/use-margin";
import type { SpotPosition } from "@/hooks/use-spot-positions";
import { accountNumbers, hfZone, type ModelState } from "@/lib/account-model";
import type { SwapProvider } from "@/lib/solana/aggregator";
import { describeError } from "@/lib/solana/errors";
import { Modal, Seg } from "@/components/v3/ui";
import { BeforeAfter } from "@/components/v3/icons";
import { hfFmt, levFmt, price, sUsd, tokFmt } from "@/components/v3/format";
import { AUTO_SLIPPAGE_PERCENT } from "./swap-modals";
import { executeClose, planClose, type ClosePlan } from "./close-position";
import { withSwap } from "./swap-model";

const SLIPPAGE_BPS = Math.round(parseFloat(AUTO_SLIPPAGE_PERCENT) * 100);

/** The account after the close: the swap, then (short) the loan repaid from the vault. */
function afterClose(s: ModelState, plan: ClosePlan, pxOf: (sym: string) => number): ModelState {
  const inUsd = Number(plan.amountUi) * pxOf(plan.fromSymbol);
  const outUsd = plan.outUi * pxOf(plan.toSymbol);
  const swapped = withSwap(s, plan.fromSymbol, inUsd, plan.toSymbol, outUsd);
  if (plan.position.side === "long") return swapped;
  const sym = plan.position.symbol;
  const debtUsd = s.debts.find((d) => d.symbol === sym)?.usd ?? 0;
  return {
    ...swapped,
    debts: swapped.debts.filter((d) => d.symbol !== sym),
    collateral: swapped.collateral.map((c) => (c.symbol === sym ? { ...c, usd: Math.max(0, c.usd - debtUsd) } : c)).filter((c) => c.usd > 1e-9),
  };
}

export function CloseModal({ position: p, onClose }: { position: SpotPosition; onClose: () => void }) {
  const owner = useUserStore((s) => s.address);
  const snapshot = useMarginAccountInfoStore((s) => s.snapshot);
  const { state, priceOf } = useV3Account();
  const after = useAfterMarginTx();
  const [provider, setProvider] = useState<SwapProvider>("jupiter");
  const [plan, setPlan] = useState<ClosePlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);

  // Quote on open / provider change.
  useEffect(() => {
    if (!owner) return;
    let live = true;
    setPlan(null);
    setError(null);
    planClose(p, {
      owner,
      provider,
      slippageBps: SLIPPAGE_BPS,
      priceOf,
      vaultRaw: (sym) => BigInt(snapshot?.collateral.find((c) => c.symbol === sym)?.amountRaw ?? "0"),
    })
      .then((x) => live && setPlan(x))
      .catch((e) => live && setError(describeError(e, "Couldn't quote the close")));
    return () => {
      live = false;
    };
    // priceOf is re-created per render; the snapshot / provider / nonce drive re-quotes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.id, provider, owner, nonce]);

  const sim = useMemo(() => {
    if (!state || !plan) return null;
    const a0 = accountNumbers(state);
    const a1 = accountNumbers(afterClose(state, plan, priceOf));
    return { a0, a1 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, plan]);

  // Estimated realized P&L at the quote: long = USDC out − cost; short = sale proceeds − USDC spent
  // on the buy-back (which includes the small repay headroom, so it slightly understates a short's P&L).
  const realized =
    plan && p.entry !== null
      ? p.side === "long"
        ? plan.outUi - p.qty * p.entry
        : p.qty * p.entry - Number(plan.amountUi)
      : null;

  const go = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      await executeClose(plan);
      await after();
      onClose();
    } catch (e) {
      setError(describeError(e, "Close failed"));
      setNonce((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

  const long = p.side === "long";
  return (
    <Modal onClose={busy ? () => {} : onClose} noClose={busy}>
      <h2>
        Close {p.symbol} {long ? "long" : "short"}
      </h2>
      <p className="msub">
        {long
          ? `Sells ${tokFmt(p.qty, p.symbol)} for USDC in your margin account.`
          : `Buys back the ${p.symbol} you owe with margin USDC, then repays the ${p.symbol} loan from your margin account (two transactions).`}
      </p>
      <div style={{ marginTop: 14 }}>
        <Seg small value={provider} onChange={setProvider} options={[["jupiter", "via Jupiter"], ["titan", "via Titan"]]} />
      </div>
      <div className="sp-cm num">
        <div className="kv">
          <span>Entry · Mark</span>
          <span>
            {p.entry !== null ? `$${price(p.entry)}` : "—"} · ${price(p.mark)}
          </span>
        </div>
        {plan ? (
          <>
            <div className="kv">
              <span>{long ? "You sell" : "You pay"}</span>
              <span>{tokFmt(Number(plan.amountUi), plan.fromSymbol)}</span>
            </div>
            <div className="kv">
              <span>{long ? "You receive" : "You buy"}</span>
              <span>
                ~ {tokFmt(plan.outUi, plan.toSymbol)} (min {tokFmt(plan.minOutUi, plan.toSymbol)})
              </span>
            </div>
            {!long && (
              <div className="kv">
                <span>Then repays</span>
                <span>all {p.symbol} debt ({tokFmt(p.qty, p.symbol)})</span>
              </div>
            )}
            <div className="kv">
              <span>Realized P&amp;L (est.)</span>
              <span className={realized === null ? "" : realized >= 0 ? "pos" : "neg"}>{realized === null ? "— (no entry price)" : sUsd(realized)}</span>
            </div>
            {sim && (
              <>
                <div className="kv">
                  <span>Health factor</span>
                  <span>
                    <BeforeAfter a={hfFmt(sim.a0.hf)} b={hfFmt(sim.a1.hf)} za={hfZone(sim.a0.hf)} zb={hfZone(sim.a1.hf)} />
                  </span>
                </div>
                <div className="kv">
                  <span>Account leverage</span>
                  <span>
                    <BeforeAfter a={levFmt(sim.a0.leverage)} b={levFmt(sim.a1.leverage)} />
                  </span>
                </div>
              </>
            )}
          </>
        ) : (
          !error && (
            <div className="kv">
              <span>Quote</span>
              <span>Fetching…</span>
            </div>
          )
        )}
      </div>
      {error && (
        <div className="sp-warn danger" style={{ marginTop: 0, marginBottom: 12 }}>
          <span>{error}</span>
        </div>
      )}
      <button type="button" className="btn-p g" disabled={!plan || busy} onClick={go}>
        {busy ? "Closing…" : "Close position"}
      </button>
    </Modal>
  );
}
