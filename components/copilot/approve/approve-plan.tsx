"use client";

/**
 * The approve page for a plan an AI client drew through the public Vanna MCP connector (Claude, Cursor, Codex …).
 *
 * The plan lives on the MCP; this page shows it and asks the user's wallet, through the site's own wallet
 * connection, to approve and sign. It never composes a transaction or an amount. The MCP checks every step again:
 * the approval must be the plan wallet's signature over the plan's digest, preparing/submitting needs the run token
 * that approval returned to this browser, and a signed transaction must match the MCP's own build byte for byte.
 *
 * One main button whose job follows the plan: Connect wallet → Approve and sign (the approval signature, then each
 * step's transaction) → Continue / Try again for an approved plan with steps left. Cancel is a quiet link.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Loader2 } from "lucide-react";
import { signUnsignedTx, signUnsignedTxs, WalletRejectedError } from "@/lib/copilot/client/sign";
import { bytesToBase64, isWalletRejection } from "@/lib/copilot/client/siws";
import { PlanApiError, planApi, type McpPlanView, type McpStepState } from "@/lib/copilot/approve/plan-api";

const FINAL = new Set(["completed", "failed", "cancelled", "expired"]);
const STATUS_TEXT: Record<string, string> = {
  awaiting_approval: "Waiting for approval", approved: "Approved", running: "In progress", paused: "Paused",
  completed: "Done", failed: "Stopped", cancelled: "Cancelled", expired: "Expired",
};
const STEP_TEXT: Partial<Record<McpStepState, string>> = {
  built: "Ready to sign", submitting: "Sending", submitted: "Confirming", confirmed: "Done", failed: "Failed",
  uncertain: "Outcome unclear", skipped: "Skipped", expired: "Did not land",
};

type Notice = { text: string; tone: "info" | "ok" | "bad" } | null;

function short(s: string): string {
  return s.length > 16 ? `${s.slice(0, 6)}…${s.slice(-6)}` : s;
}

function fmtHf(x: number | null | undefined): string {
  return x == null ? "No debt" : Number(x).toFixed(2);
}

function mmss(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function finalNotice(status: string): Notice {
  if (status === "completed") return { text: "All done. Every step is confirmed on-chain.", tone: "ok" };
  if (status === "failed") return { text: "The plan stopped: a step failed or its outcome is unclear, so nothing further will run.", tone: "bad" };
  if (status === "expired") return { text: "This plan expired before it was approved. Ask your assistant to draw it again.", tone: "bad" };
  if (status === "cancelled") return { text: "This plan was cancelled. Steps already done stay done.", tone: "bad" };
  return null;
}

export function ApprovePlan({ planId }: { planId: string }) {
  const wallet = useWallet();
  const { setVisible } = useWalletModal();
  const [view, setView] = useState<McpPlanView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [running, setRunning] = useState(false);
  const [lastFailed, setLastFailed] = useState(false);
  const [current, setCurrent] = useState<{ step: number; label: string; reasons: string[] } | null>(null);
  const [deadline, setDeadline] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const api = useRef(planApi(planId));
  const viewRef = useRef<McpPlanView | null>(null);
  const runningRef = useRef(false);

  const show = useCallback((v: McpPlanView) => {
    viewRef.current = v;
    setView(v);
    setDeadline(v.status === "awaiting_approval" ? Date.now() + (v.approve_within_seconds || 0) * 1000 : 0);
    const fin = finalNotice(v.status);
    if (fin) setNotice(fin);
  }, []);

  const refresh = useCallback(async () => {
    try {
      show(await api.current.view());
    } catch (e) {
      if (!viewRef.current) setLoadError(e instanceof Error ? e.message : "This plan could not be loaded.");
    }
  }, [show]);

  useEffect(() => {
    void refresh();
    const poll = window.setInterval(() => {
      const v = viewRef.current;
      if (!runningRef.current && v && !FINAL.has(v.status)) void refresh();
    }, 5000);
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { window.clearInterval(poll); window.clearInterval(clock); };
  }, [refresh]);

  const address = wallet.publicKey?.toBase58() ?? null;
  const wrongWallet = !!(view && address && address !== view.wallet);

  async function signText(text: string): Promise<string> {
    if (!wallet.signMessage) throw new Error("This wallet cannot sign messages. Use Phantom, Backpack or Solflare.");
    try {
      return bytesToBase64(await wallet.signMessage(new TextEncoder().encode(text)));
    } catch (e) {
      if (isWalletRejection(e)) throw new Error("You declined the signature in your wallet. Nothing was approved.");
      throw e;
    }
  }

  async function waitConfirmed(step: number): Promise<string> {
    for (let i = 0; i < 90; i++) {
      const v = await api.current.view();
      show(v);
      const s = v.steps[step]?.state;
      if (s === "confirmed" || s === "failed" || s === "expired" || s === "uncertain") return s;
      await sleep(2000);
    }
    return "submitted";
  }

  async function runSteps() {
    const v0 = viewRef.current;
    // An approved plan opened in another browser (or after the token was lost): the wallet re-confirms it here.
    if (v0?.resume_message && !api.current.hasToken()) {
      const sig = await signText(v0.resume_message);
      show(await api.current.approve(address!, sig));
    }
    for (;;) {
      const r = await api.current.next();
      if (r.plan) show(r.plan);
      if (r.done) return;
      if (r.skipped) continue;
      if (r.waiting) { await sleep(2000); continue; }
      if (r.ok === false) {
        setLastFailed(true);
        setNotice({ text: `${r.reason || "This step could not be prepared."} Nothing was sent. Press Try again.`, tone: "bad" });
        return;
      }
      if (!r.transactions?.length || r.step == null) return;
      setCurrent({ step: r.step, label: r.label ?? "", reasons: r.risk?.reasons ?? [] });
      const unsigned = r.transactions.map((t) => t.unsignedTransaction);
      const signed = r.batch
        ? await signUnsignedTxs(unsigned, wallet.signAllTransactions)
        : [];
      for (let i = 0; i < r.transactions.length; i++) {
        const tx = r.transactions[i];
        const sig = r.batch ? signed[i] : await signUnsignedTx(tx.unsignedTransaction);
        const sub = await api.current.submit(tx.id, sig);
        if (sub.plan) show(sub.plan);
      }
      setCurrent(null);
      const outcome = await waitConfirmed(r.step);
      if (outcome !== "confirmed") {
        setLastFailed(true);
        setNotice({ text: outcome === "expired" ? "The transaction did not land in time. Press Try again to rebuild it." : "The step did not confirm.", tone: "bad" });
        return;
      }
    }
  }

  async function primary() {
    const v = viewRef.current;
    if (runningRef.current || !v) return;
    if (!wallet.connected || !address) { setVisible(true); return; }
    if (address !== v.wallet) {
      setNotice({ text: `This plan is for ${short(v.wallet)}, but your wallet is on ${short(address)}. Switch accounts in your wallet and try again.`, tone: "bad" });
      return;
    }
    runningRef.current = true; setRunning(true); setLastFailed(false); setNotice(null);
    try {
      if (v.status === "awaiting_approval") {
        if (!v.approval_message) throw new Error("This plan can no longer be approved.");
        const sig = await signText(v.approval_message);
        show(await api.current.approve(address, sig));
      }
      await runSteps();
    } catch (e) {
      const message = e instanceof WalletRejectedError || e instanceof PlanApiError || e instanceof Error ? e.message : "Something went wrong. Nothing was sent.";
      setLastFailed(viewRef.current?.status !== "awaiting_approval");
      setNotice({ text: message, tone: "bad" });
    }
    setCurrent(null);
    runningRef.current = false; setRunning(false);
    await refresh();
  }

  async function cancel() {
    if (!window.confirm("Cancel this plan? Steps already confirmed stay done; nothing else will run.")) return;
    try { setLastFailed(false); show(await api.current.cancel()); } catch (e) { setNotice({ text: e instanceof Error ? e.message : "Could not cancel.", tone: "bad" }); }
  }

  if (loadError && !view) {
    return (
      <Shell>
        <Card><p className="m-0" style={{ color: "var(--pc-danger-fg)" }}>{loadError}</p></Card>
      </Shell>
    );
  }
  if (!view) {
    return (
      <Shell>
        <Card><p className="m-0 flex items-center gap-2" style={{ color: "var(--pc-muted)" }}><Loader2 className="h-4 w-4 animate-spin" /> Loading the plan…</p></Card>
      </Shell>
    );
  }

  const open = !FINAL.has(view.status);
  const awaiting = view.status === "awaiting_approval";
  const left = deadline - now;
  let label: string | null = null;
  if (open) label = !wallet.connected ? "Connect wallet" : awaiting ? "Approve and sign" : lastFailed ? "Try again" : "Continue";
  const pill = pillTone(view.status);

  return (
    <Shell>
      <Card>
        <div className="flex items-center justify-between gap-4">
          <span className="rounded-full px-2.5 py-0.5 text-xs font-semibold" style={{ background: pill.bg, color: pill.fg, border: `1px solid ${pill.bd}` }}>
            {STATUS_TEXT[view.status] ?? view.status}
          </span>
          {awaiting && deadline > 0 && (
            <span className="text-xs tabular-nums" style={{ color: left > 0 && left < 60_000 ? "var(--pc-danger-fg)" : "var(--pc-muted)" }}>
              {left > 0 ? `${mmss(left)} left to approve` : "Approval window closed"}
            </span>
          )}
        </div>

        <h1 className="m-0 mt-3 font-semibold" style={{ fontSize: 19, lineHeight: "28px", color: "var(--pc-heading)", textWrap: "pretty" }}>
          {view.summary}
        </h1>

        {view.simulation && (
          <div className="mt-4 flex items-center gap-5 rounded-xl px-4 py-3" style={{ background: "var(--pc-inset)", border: "1px solid var(--pc-line-soft)" }}>
            <HfFigure caption="Health factor now" value={fmtHf(view.simulation.hf_before)} />
            <span style={{ color: "var(--pc-muted)", fontSize: 18 }}>→</span>
            <HfFigure caption="After (worst case)" value={fmtHf(view.simulation.hf_after)} />
          </div>
        )}

        <ol className="m-0 mt-4 list-none p-0">
          {view.steps.map((s, i) => (
            <li key={s.index} className="flex gap-3 py-2.5" style={{ borderTop: i ? "1px solid var(--pc-line-soft)" : "none" }}>
              <StepDot state={s.state} n={s.index + 1} />
              <div className="min-w-0">
                <div style={{ color: s.state === "confirmed" ? "var(--pc-muted)" : "var(--pc-body)", fontSize: 14.5, lineHeight: "21px" }}>{s.label}</div>
                {(STEP_TEXT[s.state] || s.signature) && (
                  <div className="text-xs" style={{ color: "var(--pc-muted)" }}>
                    {[STEP_TEXT[s.state], s.signature ? `tx ${short(s.signature)}` : null].filter(Boolean).join(" · ")}
                  </div>
                )}
                {s.error && (s.state === "failed" || s.state === "uncertain") && (
                  <div className="text-xs" style={{ color: "var(--pc-danger-fg)" }}>{s.error}</div>
                )}
              </div>
            </li>
          ))}
        </ol>

        {view.warnings.length > 0 && (
          <details className="mt-3 pt-2.5" style={{ borderTop: "1px solid var(--pc-line-soft)" }}>
            <summary className="cursor-pointer text-xs font-semibold" style={{ color: "var(--pc-muted)" }}>Details and risks</summary>
            <ul className="m-0 mt-2 pl-4 text-xs" style={{ color: "var(--pc-body)" }}>
              {view.warnings.map((w) => <li key={w} className="mt-1">{w}</li>)}
            </ul>
            <p className="m-0 mt-2 text-xs" style={{ color: "var(--pc-muted)" }}>Wallet <span className="font-mono break-all">{view.wallet}</span></p>
          </details>
        )}
      </Card>

      {notice && (
        <div className="mb-3 rounded-xl px-4 py-3 text-sm" role="status" style={noticeStyle(notice.tone)}>{notice.text}</div>
      )}
      {wrongWallet && open && !notice && (
        <div className="mb-3 rounded-xl px-4 py-3 text-sm" style={noticeStyle("bad")}>
          This plan is for {short(view.wallet)}. Your wallet is on {short(address!)}: switch accounts in your wallet.
        </div>
      )}

      {current && (
        <Card focus>
          <div className="text-xs" style={{ color: "var(--pc-muted)" }}>Step {current.step + 1} of {view.steps.length}</div>
          <h2 className="m-0 mt-1 font-semibold" style={{ fontSize: 16, color: "var(--pc-heading)" }}>{current.label}</h2>
          {current.reasons.map((r) => (
            <div key={r} className="mt-2 rounded-lg px-3 py-2 text-sm" style={{ background: "var(--pc-warn-bg)", color: "var(--pc-warn-fg)", border: "1px solid var(--pc-warn-bd)" }}>{r}</div>
          ))}
          <p className="m-0 mt-2 text-sm" style={{ color: "var(--pc-muted)" }}>Check it in your wallet and approve there.</p>
        </Card>
      )}

      <div className="plan-card flex flex-col items-stretch gap-1">
        {running ? (
          <button type="button" disabled className="pc-btn-1 flex items-center justify-center gap-2" style={buttonStyle(true)}>
            <Loader2 className="h-4 w-4 animate-spin" /> Waiting for your wallet…
          </button>
        ) : label ? (
          <button type="button" onClick={() => void primary()} className="pc-btn-1" style={buttonStyle(false)}>{label}</button>
        ) : null}
        {open && !running && (
          <button type="button" onClick={() => void cancel()} className="pc-btn-3 cursor-pointer bg-transparent text-sm underline" style={{ padding: "8px 12px", borderRadius: 10 }}>
            Cancel plan
          </button>
        )}
      </div>

      <p className="mt-4 text-center text-xs" style={{ color: "var(--pc-muted)" }}>
        Vanna never holds your keys. Your wallet shows every transaction before you sign it.
      </p>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="plan-card mx-auto w-full max-w-[560px] px-4 pb-16 pt-10" style={{ background: "transparent" }}>
      <p className="m-0 mb-3 text-xs font-semibold uppercase tracking-[.18em]" style={{ color: "var(--pc-muted)" }}>Review and sign</p>
      {children}
    </main>
  );
}

function Card({ children, focus = false }: { children: React.ReactNode; focus?: boolean }) {
  return (
    <section
      className="mb-3"
      style={{
        border: `1px solid ${focus ? "var(--pc-accent)" : "var(--pc-line)"}`,
        boxShadow: focus ? "0 0 0 3px var(--pc-accent-soft)" : "none",
        borderRadius: 14,
        background: "var(--pc-surface)",
        padding: "18px 20px",
      }}
    >
      {children}
    </section>
  );
}

function HfFigure({ caption, value }: { caption: string; value: string }) {
  return (
    <div>
      <div className="text-xs" style={{ color: "var(--pc-muted)" }}>{caption}</div>
      <div className="font-bold tabular-nums" style={{ fontSize: 20, lineHeight: "28px", color: "var(--pc-heading)" }}>{value}</div>
    </div>
  );
}

function StepDot({ state, n }: { state: McpStepState; n: number }) {
  const done = state === "confirmed";
  const bad = state === "failed" || state === "uncertain";
  const active = state === "built" || state === "submitting" || state === "submitted";
  return (
    <span
      className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-[11px] font-bold"
      style={{
        border: `2px solid ${done ? "var(--pc-earn-fg)" : bad ? "var(--pc-danger-fg)" : active ? "var(--pc-accent)" : "var(--pc-line)"}`,
        background: done ? "var(--pc-earn-bg)" : bad ? "var(--pc-danger-bg)" : "transparent",
        color: done ? "var(--pc-earn-fg)" : bad ? "var(--pc-danger-fg)" : active ? "var(--pc-accent)" : "var(--pc-muted)",
      }}
    >
      {done ? "✓" : n}
    </span>
  );
}

function pillTone(status: string) {
  if (status === "completed") return { fg: "var(--pc-earn-fg)", bg: "var(--pc-earn-bg)", bd: "var(--pc-earn-bd)" };
  if (status === "awaiting_approval" || status === "paused") return { fg: "var(--pc-warn-fg)", bg: "var(--pc-warn-bg)", bd: "var(--pc-warn-bd)" };
  if (status === "failed" || status === "expired" || status === "cancelled") return { fg: "var(--pc-danger-fg)", bg: "var(--pc-danger-bg)", bd: "var(--pc-danger-bd)" };
  return { fg: "var(--pc-accent)", bg: "var(--pc-accent-soft)", bd: "var(--pc-line)" };
}

function noticeStyle(tone: "info" | "ok" | "bad"): React.CSSProperties {
  if (tone === "ok") return { background: "var(--pc-earn-bg)", color: "var(--pc-earn-fg)", border: "1px solid var(--pc-earn-bd)" };
  if (tone === "bad") return { background: "var(--pc-danger-bg)", color: "var(--pc-danger-fg)", border: "1px solid var(--pc-danger-bd)" };
  return { background: "var(--pc-accent-soft)", color: "var(--pc-body)", border: "1px solid var(--pc-line)" };
}

function buttonStyle(busy: boolean): React.CSSProperties {
  return {
    border: "1px solid transparent",
    borderRadius: 10,
    padding: "14px 22px",
    fontFamily: "inherit",
    fontSize: 15,
    fontWeight: 700,
    cursor: busy ? "progress" : "pointer",
    background: "var(--pc-btn-fill)",
    color: "var(--pc-btn-fg)",
  };
}
