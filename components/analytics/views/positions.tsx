"use client";

/** Positions: wallet lookup plus how accounts are distributed by health, leverage and what they hold. */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAnalyticsSummary, lookupWallet } from "@/hooks/use-analytics";
import { num, pct, usd, usdC } from "@/lib/analytics/format";
import { accountHref } from "@/lib/analytics/links";
import { ColumnChart, HBars, SERIES, TONE_VAR } from "../charts";
import { AssetCell, Empty, Icon, Notice, Panel } from "../ui";
import { ViewHead } from "../shell";

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function Lookup() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [state, setState] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });
  const valid = BASE58.test(text.trim());
  async function run() {
    setState({ loading: true, error: null });
    try { const row = await lookupWallet(text.trim()); router.push(accountHref(row.address, "positions")); }
    catch (e) { setState({ loading: false, error: e instanceof Error ? e.message : "Lookup failed" }); }
  }
  return (
    <Panel title="Look up a wallet" sub="Paste a wallet or margin account address to open its account page - read-only, nothing is sent to the chain"
      actions={<><label className="an-input-wrap"><Icon name="search" /><input className="an-input" style={{ width: 340 }} placeholder="Wallet or margin account address" aria-label="Wallet or margin account address" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && valid) void run(); }} /></label>
        <button className="an-btn an-primary" disabled={!valid || state.loading} onClick={run}>{state.loading ? "Looking…" : "Look up"}</button></>}>
      {state.error && <Notice tone="warn">{state.error}</Notice>}
      {!state.error && <p className="an-muted">Enter an address and press Look up: the account opens on its own page.</p>}
    </Panel>
  );
}

export function PositionsView() {
  const { data } = useAnalyticsSummary();
  const s = data?.summary ?? null;
  const ok = !!s && s.borrowers > 0;
  return (
    <>
      <ViewHead title="Positions" blurb="Look up any wallet, and see how accounts are spread across health, leverage and collateral." />
      <Lookup />
      <div className="an-grid-2">
        <Panel title="Accounts by health" sub="How many accounts sit at each health level" tip="hfDistribution">
          {!ok ? <Empty title="No account has debt" text="Appears once an account that can be valued borrows." /> : (
            <HBars rows={s!.healthBands.map((b) => ({ key: b.key, name: <span>{b.label}</span>, segments: [{ value: b.count, color: TONE_VAR[b.tone], tip: `Health ${b.label}\n${b.count} account${b.count === 1 ? "" : "s"} · ${usd(b.debtUsd)} of debt` }], valueText: `${b.count}` }))} />
          )}
        </Panel>
        <Panel title="Debt by leverage" sub="How leveraged the accounts that owe money are" tip="leverageDistribution">
          {!ok ? <Empty title="No account has debt" text="Appears once an account that can be valued borrows." /> : (
            <ColumnChart ariaLabel="Debt by leverage" yFmt={usdC} items={s!.leverageBins.map((b) => ({ label: b.label, value: b.debtUsd, color: SERIES[0], tip: `Leverage ${b.label}\nDebt ${usd(b.debtUsd)} · ${b.count} account${b.count === 1 ? "" : "s"}` }))} />
          )}
        </Panel>
      </div>
      <div className="an-grid-2">
        <Panel title="Collateral by asset" sub="What accounts hold">
          {s && s.collateralBy.length ? <HBars rows={s.collateralBy.slice(0, 7).map((r, i) => ({ key: r.symbol, name: <AssetCell symbol={r.symbol} sub="" size="sm" />, segments: [{ value: r.usd, color: SERIES[i % SERIES.length], tip: `${r.symbol}: ${usd(r.usd)} across ${r.accounts} account${r.accounts === 1 ? "" : "s"}` }], valueText: r.usd > 0 ? usdC(r.usd) : `${num(r.amountAll, 2)} ${r.symbol}` }))} /> : <Empty title="No collateral found" text="No valued collateral yet." />}
        </Panel>
        <Panel title="Debt by asset" sub="What accounts owe">
          {s && s.debtBy.length ? <HBars rows={s.debtBy.slice(0, 7).map((r, i) => ({ key: r.symbol, name: <AssetCell symbol={r.symbol} sub="" size="sm" />, segments: [{ value: r.usd, color: SERIES[(i + 1) % SERIES.length], tip: `${r.symbol}: ${usd(r.usd)} across ${r.accounts} account${r.accounts === 1 ? "" : "s"}` }], valueText: r.usd > 0 ? `${usdC(r.usd)} · ${pct(s.debtUsd > 0 ? r.usd / s.debtUsd : null, 0)}` : `${num(r.amountAll, 2)} ${r.symbol}` }))} /> : <Empty title="No debt found" text="No valued debt yet." />}
        </Panel>
      </div>
    </>
  );
}
