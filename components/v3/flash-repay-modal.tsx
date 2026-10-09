"use client";

/**
 * Flash repay modal (design: index.html "Flash repay" — css 1663-1809, js 6797-7177).
 *
 * Review: the live plan from lib/solana/flash-repay.ts (positions to close, how each loan is
 * covered, costs, what is left), a slippage picker and the "also withdraw to wallet" switch.
 * Run: the plan's steps execute one after the other, each its own transaction(s) and wallet
 * approval (NOT atomic); every step shows its status and transaction links. A failure stops the
 * run and shows what completed and what didn't; "Retry" plans again from the chain and continues.
 */
import "./flash-repay.css";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { PublicKey } from "@solana/web3.js";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useFlashRepayStore } from "@/store/flash-repay-store";
import { useUserStore } from "@/store/user";
import { useWallet, refreshWalletBalancesOnChain } from "@/hooks/use-wallet";
import { useV3Account } from "@/hooks/use-v3-account";
import { refreshMarginAccount } from "@/store/margin-account-info-store";
import { explorerUrl } from "@/lib/solana/config";
import { describeError } from "@/lib/solana/errors";
import { executeFlashRepay, planFlashRepay, type FlashLoanRow, type FlashPlan, type FlashStepState } from "@/lib/solana/flash-repay";
import { Info, Modal } from "./ui";
import { Icon, IC } from "./icons";
import { hfFmt, levFmt, nf, sUsd, tokFmt, usd } from "./format";

const SLIPS = [0.1, 0.5, 1] as const;

/** The design's filled bolt (BOLT in margin.js). */
const Bolt = ({ s }: { s: number }) => (
  <svg width={s} height={s} viewBox="0 0 20 21" aria-hidden="true">
    <path d="M11.67 1.5L4.17 11.5H10l-1.67 8 7.5-10H10l1.67-8z" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
  </svg>
);
const Spin = ({ s }: { s: number }) => (
  <svg width={s} height={s} viewBox="0 0 48 48" aria-hidden="true">
    <circle cx="24" cy="24" r="20" fill="none" style={{ stroke: "var(--mg-ring)" }} strokeWidth="4" />
    <circle cx="24" cy="24" r="20" fill="none" style={{ stroke: "var(--violet)" }} strokeWidth="4" strokeLinecap="round" strokeDasharray="94" strokeDashoffset="66" />
  </svg>
);
const Check = ({ s }: { s: number }) => (
  <svg width={s} height={s} viewBox="0 0 16 16" aria-hidden="true">
    <path d="M3 8.5l3.2 3L13 4.5" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const tokChips = (list: { symbol: string; amount: number }[]) =>
  list.map((x) => (
    <span key={x.symbol} className="mini">
      <Icon sym={x.symbol} />
      {tokFmt(x.amount, x.symbol)}
    </span>
  ));

export type Phase = "review" | "run" | "done" | "failed";

export default function FlashRepayModal() {
  const close = useFlashRepayStore((s) => s.close);
  const initialTransfer = useFlashRepayStore((s) => s.transfer);
  const address = useUserStore((s) => s.address);
  const { connectWallet } = useWallet();
  const acct = useV3Account();
  const qc = useQueryClient();

  const [transfer, setTransfer] = useState(initialTransfer);
  const [slip, setSlip] = useState<number>(0.5);
  const [phase, setPhase] = useState<Phase>("review");
  const [steps, setSteps] = useState<FlashStepState[]>([]);
  const [runPlan, setRunPlan] = useState<FlashPlan | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [leftAfter, setLeftAfter] = useState<{ usd: number; rows: { symbol: string; amount: number }[] } | null>(null);

  const planQ = useQuery({
    queryKey: ["flash-repay", "plan", address ?? "none", transfer, slip],
    queryFn: () => planFlashRepay(new PublicKey(address!), { transfer, slippageBps: Math.round(slip * 100) }),
    enabled: Boolean(address) && phase === "review",
    staleTime: 15_000,
    placeholderData: (prev) => prev,
  });
  const plan = planQ.data;

  // Refresh every page's data after (part of) a run.
  const refreshAll = useCallback(async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["margin"] }),
      qc.invalidateQueries({ queryKey: ["earn"] }),
      qc.invalidateQueries({ queryKey: ["perps"] }),
      qc.invalidateQueries({ queryKey: ["flash-repay"] }),
      address ? refreshMarginAccount(address) : Promise.resolve(),
      address ? refreshWalletBalancesOnChain(address).catch(() => {}) : Promise.resolve(),
    ]);
  }, [qc, address]);

  /** Plans from the chain's current state and runs every step (also used by Retry). */
  const start = useCallback(
    async (fresh: boolean) => {
      if (!address) return;
      setRunError(null);
      setPhase("run");
      let p: FlashPlan;
      try {
        p = fresh ? await planFlashRepay(new PublicKey(address), { transfer, slippageBps: Math.round(slip * 100), quote: false }) : plan!;
      } catch (error) {
        setRunError(describeError(error, "Couldn't read your account"));
        setPhase("failed");
        return;
      }
      if (!p.steps.length) {
        setPhase("done");
        await refreshAll();
        return;
      }
      if (p.shortUsd > 0.01) {
        setRunPlan(p);
        setRunError(`Closing everything leaves ${usd(p.shortUsd)} of loans unpaid. Add funds to the margin account first, then retry.`);
        setPhase("failed");
        return;
      }
      setRunPlan((prev) => prev ?? p);
      // A retry keeps the steps that already completed and appends what is still to do.
      const kept = fresh ? steps.filter((s) => s.status === "done") : [];
      setSteps([...kept, ...p.steps.map((s): FlashStepState => ({ key: s.key, title: s.title, usd: s.usd, status: "wait", txs: [] }))]);
      try {
        const res = await executeFlashRepay(p, { onProgress: (next) => setSteps([...kept, ...next]) });
        if (res.ok) {
          setPhase("done");
        } else {
          setRunError(res.error ?? "A step failed");
          setPhase("failed");
        }
      } catch (error) {
        setRunError(describeError(error));
        setPhase("failed");
      }
      await refreshAll();
    },
    [address, transfer, slip, plan, steps, refreshAll],
  );

  // After a run, read what is actually left in the margin account.
  useEffect(() => {
    if (phase !== "done" || !address) return;
    let live = true;
    planFlashRepay(new PublicKey(address), { quote: false })
      .then((p) => live && setLeftAfter({ usd: p.leftUsd, rows: p.left }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [phase, address]);

  const running = phase === "run";
  return (
    <Modal onClose={close} wide className="mg-frm" noClose={running}>
      {!address ? (
        <>
          <Head title="Flash repay" sub="Close every position and repay every loan in one go." />
          <div className="mg-fr-empty">
            <b>Connect a wallet to use Flash repay</b>It closes your positions and repays your loans step by step.
            <div style={{ marginTop: 14 }}>
              <button type="button" className="connect" onClick={() => void connectWallet()}>
                Connect Wallet
              </button>
            </div>
          </div>
        </>
      ) : phase === "run" || phase === "failed" || phase === "done" ? (
        <Progress
          phase={phase}
          steps={steps}
          plan={runPlan}
          error={runError}
          leftAfter={leftAfter}
          onRetry={() => void start(true)}
          onClose={close}
        />
      ) : !plan ? (
        <>
          <Head title="Flash repay" sub="Close every position and repay every loan in one go." />
          <div className="mg-fr-empty">
            {planQ.error ? (
              <>
                <b>Couldn&apos;t read your account</b>
                {describeError(planQ.error)}
              </>
            ) : (
              <>
                <b>Reading your account…</b>Positions, loans and live swap quotes.
              </>
            )}
          </div>
        </>
      ) : plan.empty ? (
        <>
          <Head title="Flash repay" sub="Close every position and repay every loan in one go." />
          <div className="mg-fr-empty">
            <b>Nothing to close or repay</b>
            {plan.exists ? "Your margin account is empty." : "You don't have a margin account yet."}
          </div>
        </>
      ) : plan.transferOnly ? (
        <>
          <Head title="Flash transfer" sub="No open positions or loans. Send everything in the margin account to your wallet." />
          <div className="mg-fr-s">
            <div className="mg-fr-st">Your wallet receives</div>
            <div className="mg-fr-af">
              <div className="mg-fr-w">{tokChips(plan.left)}</div>
              <div className="kv">
                <span>Total</span>
                <span className="num">{usd(plan.leftUsd)}</span>
              </div>
            </div>
          </div>
          <div className="mg-fr-cta">
            <button type="button" className="mg-btn lg" onClick={() => void start(false)}>
              <Bolt s={16} />
              Withdraw all to wallet
            </button>
            <small>
              {plural(plan.txCount, "transaction")}, one wallet approval each. Your margin account stays open.
            </small>
          </div>
        </>
      ) : (
        <Review
          plan={plan}
          transfer={transfer}
          setTransfer={setTransfer}
          slip={slip}
          setSlip={setSlip}
          leverage={acct.now?.leverage ?? null}
          refreshing={planQ.isFetching}
          onGo={() => void start(false)}
        />
      )}
    </Modal>
  );
}

function Head({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="mg-fr-h">
      <span className="mg-fr-ic">
        <Bolt s={20} />
      </span>
      <div>
        <h2>{title}</h2>
        {sub && <p>{sub}</p>}
      </div>
    </div>
  );
}

function LoanFrom({ l }: { l: FlashLoanRow }) {
  const c: ReactNode[] = [];
  if (l.fromProceeds > 1e-9) c.push(<span key="p" className="mini v">Position proceeds {tokFmt(l.fromProceeds, l.symbol)}</span>);
  if (l.fromHoldings > 1e-9) c.push(<span key="h" className="mini">Held {tokFmt(l.fromHoldings, l.symbol)}</span>);
  l.swaps.forEach((s, i) =>
    c.push(
      <span key={`s${i}`} className="mini v">
        <Icon sym={s.provider === "titan" ? "TITAN" : "JUP"} />
        Swap {tokFmt(s.inAmount, s.from)} {IC.arrow} {tokFmt(s.outAmount, s.to)}
      </span>,
    ),
  );
  if (l.shortAmount > 1e-9) c.push(<span key="x" className="mini warn">{tokFmt(l.shortAmount, l.symbol)} not covered</span>);
  return <div className="mg-fr-from">{c}</div>;
}

export function Review({
  plan,
  transfer,
  setTransfer,
  slip,
  setSlip,
  leverage,
  refreshing,
  onGo,
}: {
  plan: FlashPlan;
  transfer: boolean;
  setTransfer: (v: boolean) => void;
  slip: number;
  setSlip: (v: number) => void;
  leverage: number | null;
  refreshing: boolean;
  onGo: () => void;
}) {
  const p = plan;
  const mods = [p.perps.length ? `Perps ${p.perps.length}` : "", p.farm.length ? `Farm ${p.farm.length}` : ""].filter(Boolean).join(" · ");
  const worst = Math.max(0, p.leftUsd - (p.tradedUsd * slip) / 100);
  const blocked = p.shortUsd > 0.01;
  const perpsTotal = p.phoenixValueUsd;
  const farmTotal = p.farm.reduce((a, f) => a + f.usd, 0);
  const pnlCell = (v: number | null, tag?: string) =>
    v === null ? <span className="mg-mut">{sUsd(0)}</span> : (
      <>
        <span className={v >= 0 ? "pos" : "neg"}>{sUsd(v)}</span>
        {tag && <small className="mg-mut"> {tag}</small>}
      </>
    );
  const swapProviders = [...new Set(p.swaps.filter((s) => s.quoted).map((s) => (s.provider === "titan" ? "Titan" : "Jupiter")))];
  return (
    <>
      <Head title="Flash repay" sub="Close every position and repay every loan, one transaction per step." />
      <div className="mg-fr-k">
        <div>
          <span>Positions</span>
          <b className="num">{p.positionCount}</b>
          <small>{mods || (p.phoenixIdleUsdc > 0 ? "Idle Phoenix USDC only" : "None open")}</small>
        </div>
        <div>
          <span>
            Borrowed <Info text="Everything you owe right now, interest included." />
          </span>
          <b className="num">{usd(p.debtUsd)}</b>
          <small>
            {plural(p.loans.length, "asset")}
            {p.loans.length ? ` · ${p.loans.map((l) => l.symbol).join(", ")}` : ""}
          </small>
        </div>
        <div>
          <span>
            Est. costs <Info text="Phoenix taker fees to close the perps plus the swap cost (quoted output vs the oracle price)." />
          </span>
          <b className="num">{usd(p.costUsd)}</b>
          <small>fees and price impact</small>
        </div>
        <div>
          <span>{transfer ? "To your wallet" : "Left in margin"}</span>
          <b className="num">{usd(p.leftUsd)}</b>
          <small>{transfer ? "all assets, after repaying" : "as collateral, after repaying"}</small>
        </div>
      </div>

      {(p.perps.length > 0 || p.phoenixIdleUsdc > 0 || p.farm.length > 0) && (
        <div className="mg-fr-s">
          <div className="mg-fr-st">
            Positions closed<small>{usd(perpsTotal + farmTotal)} back to the margin account</small>
          </div>
          <div className="mg-fr-box">
            <div className="mg-fr-row hd">
              <span>Position</span>
              <span>Size</span>
              <span>P&amp;L</span>
              <span>You get</span>
            </div>
            {(p.perps.length > 0 || p.phoenixIdleUsdc > 0) && (
              <>
                <div className="mg-fr-g">
                  <span className="mg-fr-gt">
                    <Icon sym="PHX" className="ico mg-gi" />
                    Perps · Phoenix
                  </span>
                  <span className="num">{usd(perpsTotal)}</span>
                </div>
                {p.perps.map((r) => (
                  <div key={r.market} className="mg-fr-row">
                    <span className="mg-fr-n">
                      <Icon sym={r.market} />
                      <div>
                        <b>{r.name}</b>
                        <small>{r.side === "long" ? "Long" : "Short"} · Phoenix</small>
                      </div>
                    </span>
                    <span className="num">{usd(r.sizeUsd)}</span>
                    <span className="num">{pnlCell(r.pnlUsd)}</span>
                    <span className="mg-fr-get num">
                      {r.equityUsd >= 0 ? "+" : "−"}
                      {nf(Math.abs(r.equityUsd), 2)} USDC<small>after {usd(r.closeFeeUsd)} fee</small>
                    </span>
                  </div>
                ))}
                {p.phoenixIdleUsdc > 0.005 && (
                  <div className="mg-fr-row">
                    <span className="mg-fr-n">
                      <Icon sym="USDC" />
                      <div>
                        <b>Idle USDC</b>
                        <small>Phoenix trader account</small>
                      </div>
                    </span>
                    <span className="num">N/A</span>
                    <span className="num">{pnlCell(null)}</span>
                    <span className="mg-fr-get num">+{nf(p.phoenixIdleUsdc, 2)} USDC</span>
                  </div>
                )}
              </>
            )}
            {p.farm.length > 0 && (
              <>
                <div className="mg-fr-g">
                  <span className="mg-fr-gt">
                    <Icon sym="KMNO" className="ico mg-gi" />
                    Farm · Kamino
                  </span>
                  <span className="num">{usd(farmTotal)}</span>
                </div>
                {p.farm.map((f) => (
                  <div key={f.receiptSymbol} className="mg-fr-row">
                    <span className="mg-fr-n">
                      <Icon sym={f.symbol} />
                      <div>
                        <b>{f.symbol} Lending</b>
                        <small>{tokFmt(f.receipts, f.receiptSymbol)} · Kamino</small>
                      </div>
                    </span>
                    <span className="num">{tokFmt(f.underlying, f.symbol)}</span>
                    <span className="num">{pnlCell(null)}</span>
                    <span className="mg-fr-get num">+{tokFmt(f.underlying, f.symbol)}</span>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}

      {p.loans.length > 0 && (
        <div className="mg-fr-s">
          <div className="mg-fr-st">
            Loans repaid<small>interest included</small>
          </div>
          <div className="mg-fr-box">
            {p.loans.map((l) => (
              <div key={l.symbol} className="mg-fr-l">
                <span className="mg-fr-n">
                  <Icon sym={l.symbol} />
                  <div>
                    <b className="num">{tokFmt(l.amount, l.symbol)}</b>
                    <LoanFrom l={l} />
                  </div>
                </span>
                <span className="num" style={{ fontWeight: 600 }}>
                  {usd(l.usd)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mg-fr-s">
        <div className="mg-fr-st">Costs</div>
        <div className="mg-fr-c">
          {p.costs.phoenixUsd > 0 && (
            <div className="kv">
              <span>Phoenix taker fees</span>
              <span className="num">{usd(p.costs.phoenixUsd)}</span>
            </div>
          )}
          {p.swaps.length > 0 && (
            <div className="kv">
              <span>{swapProviders.length ? `${swapProviders.join(" / ")} swap cost` : "Swap cost (oracle estimate)"}</span>
              <span className="num">{usd(p.costs.swapUsd)}</span>
            </div>
          )}
          <div className="kv">
            <span>
              Transactions <Info text="Flash repay runs step by step: each transaction needs its own wallet approval. If one fails, the run stops and you can retry from there." />
            </span>
            <span className="num">~{p.txCount}</span>
          </div>
          <div className="kv">
            <span>
              Max slippage <Info text="Swaps and perp closes that would fill worse than this are not executed (a perp close retries once with a wider limit)." />
            </span>
            <span className="mg-slip" role="group" aria-label="Max slippage">
              {SLIPS.map((v) => (
                <button key={v} type="button" className={slip === v ? "on" : ""} onClick={() => setSlip(v)}>
                  {v}%
                </button>
              ))}
            </span>
          </div>
        </div>
      </div>

      {!blocked && (
        <div className="mg-fr-s">
          <div className="mg-fr-st">After</div>
          <div className="mg-fr-af">
            <div className="kv">
              <span>Health factor</span>
              <span className="ba">
                <span className="o">{hfFmt(p.healthFactor)}</span>
                {IC.arrow}
                <span className="z-ok">No debt</span>
              </span>
            </div>
            <div className="kv">
              <span>Account leverage</span>
              <span className="num">
                {levFmt(leverage ?? 0)} {IC.arrow} {levFmt(transfer ? 0 : 1)}
              </span>
            </div>
            <div className="kv">
              <span>{transfer ? "Margin account" : "Left in margin account"}</span>
              <span className="num">{transfer ? usd(0) : usd(p.leftUsd)}</span>
            </div>
            <div className="mg-fr-w">
              {transfer ? "Your wallet receives" : "Kept as collateral"} {tokChips(p.left)}
            </div>
            {p.untouched.length > 0 && (
              <div className="mg-fr-w">
                Not moved (not an app token): {tokChips(p.untouched)}
              </div>
            )}
            <button type="button" className="mg-fr-tg" role="switch" aria-checked={transfer} onClick={() => setTransfer(!transfer)}>
              <span className={`mg-tgl ${transfer ? "on" : ""}`}>
                <i />
              </span>
              <span>
                <b>Also withdraw to wallet</b>
                <small>Flash transfer: after repaying, send what is left to your wallet.</small>
              </span>
            </button>
          </div>
        </div>
      )}

      {blocked && (
        <div className="mg-rd mg-fr-warn" role="alert">
          {IC.warn}
          <span>Closing everything leaves {usd(p.shortUsd)} of loans unpaid. Add funds to the margin account first, then retry.</span>
        </div>
      )}

      <div className="mg-fr-cta">
        <button type="button" className="mg-btn lg" disabled={blocked || refreshing} onClick={onGo}>
          <Bolt s={16} />
          {p.loans.length
            ? `${transfer ? "Flash repay and withdraw" : "Flash repay"} ${usd(p.debtUsd)}`
            : transfer
              ? "Close all and withdraw"
              : `Close ${plural(p.positionCount || 1, "position")}`}
        </button>
        <small className="num">
          At {slip}% max slippage you keep at least {usd(worst)}. {plural(p.txCount, "wallet approval")}, not atomic.
        </small>
      </div>
    </>
  );
}

export function Progress({
  phase,
  steps,
  plan,
  error,
  leftAfter,
  onRetry,
  onClose,
}: {
  phase: Phase;
  steps: FlashStepState[];
  plan: FlashPlan | null;
  error: string | null;
  leftAfter: { usd: number; rows: { symbol: string; amount: number }[] } | null;
  onRetry: () => void;
  onClose: () => void;
}) {
  const n = steps.length;
  const cur = Math.max(0, steps.findIndex((s) => s.status === "run"));
  const doneN = steps.filter((s) => s.status === "done").length;
  const title = plan?.transferOnly ? "Flash transfer" : "Flash repay";
  const txList = useMemo(() => steps.flatMap((s) => s.txs), [steps]);

  if (phase === "done") {
    const tOnly = Boolean(plan?.transferOnly);
    return (
      <>
        <Head title={title} />
        <div className="mg-fr-ok">
          <span className="mg-okc">
            <Check s={30} />
          </span>
          <h3>{tOnly ? "Everything is in your wallet" : "Account closed out"}</h3>
          <p>
            {plan
              ? tOnly
                ? `${plural(plan.left.length, "asset")} sent to your wallet`
                : `${plural(plan.positionCount, "position")} closed · ${plural(plan.loans.length, "loan")} repaid`
              : "Nothing left to close or repay"}
          </p>
          <div className="mg-fr-sum">
            {plan && !tOnly && (
              <>
                <div className="kv">
                  <span>Repaid</span>
                  <span className="num">{usd(plan.debtUsd)}</span>
                </div>
                {plan.perps.length > 0 && (
                  <div className="kv">
                    <span>Realized perp P&amp;L</span>
                    <span className={`num ${plan.pnlUsd >= 0 ? "pos" : "neg"}`}>{sUsd(plan.pnlUsd)}</span>
                  </div>
                )}
              </>
            )}
            <div className="kv">
              <span>Left in margin account</span>
              <span className="num">{leftAfter ? usd(leftAfter.usd) : "…"}</span>
            </div>
            {leftAfter && leftAfter.rows.length > 0 && (
              <div className="mg-fr-w" style={{ padding: "4px 0 8px" }}>
                {tokChips(leftAfter.rows)}
              </div>
            )}
            <div className="kv">
              <span>Health factor</span>
              <span className="z-ok">No debt</span>
            </div>
            <div className="kv">
              <span>Transactions</span>
              <span className="num">{txList.length}</span>
            </div>
          </div>
          <StepList steps={steps} />
          <div className="mg-fr-btns">
            <Link className="btn-o" href="/portfolio" onClick={onClose}>
              View Portfolio
            </Link>
            <button type="button" className="mg-btn" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </>
    );
  }

  const failed = phase === "failed";
  const failedStep = steps.find((s) => s.status === "failed");
  const prog = n ? Math.min(100, ((doneN + (failed ? 0 : 0.5)) / n) * 100) : 4;
  return (
    <>
      <Head title={title} />
      <div className="mg-fr-run">
        <p className="mg-stp">{failed ? `Stopped${failedStep ? ` at step ${steps.indexOf(failedStep) + 1} of ${n}` : ""}` : n ? `Step ${cur + 1} of ${n}` : "Preparing"}</p>
        <h3>{failed ? (failedStep ? `${failedStep.title} failed` : "Couldn't start") : (steps[cur]?.title ?? "Reading your account")}</h3>
        <p>{failed ? "Completed steps stay done. Retry continues from your account's current state." : (steps[cur]?.note ?? "Approve each transaction in your wallet")}</p>
        <div className="mg-prog">
          <i style={{ width: `${prog.toFixed(1)}%` }} />
        </div>
        {failed && error && (
          <div className="mg-rd mg-fr-warn" role="alert">
            {IC.warn}
            <span>{error}</span>
          </div>
        )}
        <StepList steps={steps} />
        {failed && (
          <div className="mg-fr-btns">
            <button type="button" className="btn-o" onClick={onClose}>
              Close
            </button>
            <button type="button" className="mg-btn" onClick={onRetry}>
              Retry from here
            </button>
          </div>
        )}
      </div>
    </>
  );
}

function StepList({ steps }: { steps: FlashStepState[] }) {
  if (!steps.length) return null;
  return (
    <ol className="mg-fsl" style={{ width: "100%", textAlign: "left" }}>
      {steps.map((s, i) => {
        const st = s.status === "done" ? "done" : s.status === "run" ? "run" : s.status === "failed" ? "failed" : "wait";
        return (
          <li key={`${s.key}-${i}`} className={st === "failed" ? "run" : st}>
            <span className={`mg-fs-ic ${st === "failed" ? "" : st}`} style={st === "failed" ? { borderColor: "var(--mg-rd-bd)", color: "var(--mg-rd-fg)" } : undefined}>
              {st === "done" ? <Check s={12} /> : st === "run" ? <Spin s={22} /> : st === "failed" ? IC.x : null}
            </span>
            <span>
              <b>{s.title}</b>
              {s.txs.length > 0 && (
                <span className="mg-fr-from">
                  {s.txs.map((t) => (
                    <a key={t.signature} className="mini" href={explorerUrl("tx", t.signature)} target="_blank" rel="noreferrer">
                      {t.label} {IC.ext}
                    </a>
                  ))}
                </span>
              )}
              {st === "failed" && s.error && <small style={{ display: "block", color: "var(--mg-rd-fg)", marginTop: 4 }}>{s.error}</small>}
            </span>
            <em className="num">{st === "failed" ? "Failed" : st === "done" ? "Done" : usd(s.usd)}</em>
          </li>
        );
      })}
    </ol>
  );
}
