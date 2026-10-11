"use client";

/**
 * Predict trade panel (design predict.js `panel` / `prevBuy` / `prevSell` / `slipPanel`, V4):
 * Buy / Sell, "One outcome" / "Bet slip (n)" for events with more than one tradable outcome, the
 * market picker, Yes / No, the amount box with the pay token (CASH, World's dollar) and % buttons, then
 * the buy preview (details, "Earns while you wait", same-bet twin), the sell preview ("How this
 * sell works": wallet shares first, then the pool redeem) or the bet slip (legs, totals, "If this
 * happens / Pays / Profit", Buy all with ONE wallet approval).
 *
 * Every action is a real trade on the fork through `usePredictTrade` (server-built, maker-signed
 * batch; the wallet signs all transactions once; progress in the shared tx-progress modal; the
 * Predict queries refresh afterwards). Prices are World's latest trades: a buy fills at the ask,
 * a sell at the bid. A market with no price cannot be traded.
 */
import { forwardRef, useEffect, useRef, type RefObject } from "react";
import { IC, Icon } from "@/components/v3/icons";
import { Info } from "@/components/v3/ui";
import { nf, pct, sUsd, usd } from "@/components/v3/format";
import { useWallet } from "@/hooks/use-wallet";
import { usePredictFaucet, usePredictTrade } from "@/hooks/use-predict";
import { showTxError, showTxSuccess } from "@/lib/tx-progress";
import {
  MAX_TRADE_CASH, MAX_TRADE_LEGS, MIN_TRADE_CASH, ask, bid, buyFx, byChance, canTrade, isDraw, lab, mainOuts, outOf, poolSide, pooled, quoteBuy,
  quoteSell, scenarios, twinOf,
} from "@/lib/predict/view";
import type { PositionsResponse, PredictEvent, PredictOutcome as Outcome, PredictPosition, Side } from "@/lib/predict/types";
import { EvLogo, INFO, Kv, Meter, PIC, SideTag, TeamLogo, cf, cleanAmt, cpair, p2, parseAmt, pc, pp, shf } from "./ui";

/** Predict pays in CASH only (World's collateral). */
export type Pay = "CASH";
export interface SlipLegState {
  k: string;
  s: Side;
  amt: string;
}
export interface PanelState {
  side: Side;
  mode: "buy" | "sell";
  amt: string;
  pay: Pay;
  /** Bet slip on (buy only, events with more than one tradable outcome). */
  slip: SlipLegState[] | null;
  /** Open popover: market picker, "add an outcome" picker, pay token. */
  pop: "out" | "add" | "pay" | null;
}

/** The connected wallet's holding of one market side (wallet tokens + pool value). */
export function heldOf(data: PositionsResponse | undefined, o: Outcome, s: Side): { total: number; wallet: number; pool: number; p: PredictPosition | null } {
  const p = data?.positions.find((x) => x.marketId === o.k && x.side === s) ?? null;
  return { total: p?.shares ?? 0, wallet: p?.walletShares ?? 0, pool: p?.poolValueShares ?? 0, p };
}

/** A small popover that closes on an outside click / Escape. */
function usePopClose(open: boolean, close: () => void, ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const h = (ev: Event) => {
      if (ev.type === "keydown" && (ev as KeyboardEvent).key !== "Escape") return;
      if (ev.type === "mousedown" && ref.current?.contains(ev.target as Node)) return;
      close();
    };
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", h);
    return () => {
      document.removeEventListener("mousedown", h);
      document.removeEventListener("keydown", h);
    };
  }, [open, close, ref]);
}

const GRP_LABEL: Partial<Record<PredictEvent["type"], string>> = { match: "Market", strike: "Target", date: "Date", multi: "Outcome" };

/** Market picker (or the bet slip's "Add an outcome"). */
function OutSel({ e, o, add, st, set, choose, addLeg, data }: { e: PredictEvent; o: Outcome; add?: boolean; st: PanelState; set: (p: Partial<PanelState>) => void; choose: (k: string) => void; addLeg: (k: string) => void; data?: PositionsResponse }) {
  const key = add ? "add" : "out";
  const open = st.pop === key;
  const ref = useRef<HTMLDivElement>(null);
  usePopClose(open, () => set({ pop: null }), ref);
  const list = (e.type === "match" ? mainOuts(e) : e.outs.slice().sort(byChance)).filter((x) => !add || canTrade(x));
  const lines = e.type === "match" ? e.outs.filter((x) => x.grp && (!add || canTrade(x))) : [];
  const legOn = (k: string) => Boolean(st.slip?.some((l) => l.k === k));
  const opt = (x: Outcome) => (
    <button
      key={x.k}
      type="button"
      role="option"
      aria-selected={x.k === o.k}
      className={`mi ${(!add && x.k === o.k) || (add && legOn(x.k)) ? "on" : ""}`}
      onClick={() => {
        set({ pop: null });
        if (add) addLeg(x.k);
        else choose(x.k);
      }}
    >
      {e.type === "match" ? <TeamLogo e={e} o={x} cls="xs" /> : null}
      <span className="nm">
        {x.name}
        {/* The wallet's shares in this outcome (wallet + pool), so it's clear what can be sold. */}
        {(() => {
          const y = heldOf(data, x, "yes").total;
          const n = heldOf(data, x, "no").total;
          if (y < 0.01 && n < 0.01) return null;
          return (
            <small className="pd-oheld num">
              {y >= 0.01 && <span className="y">{shf(y)} Yes</span>}
              {n >= 0.01 && <span className="n">{shf(n)} No</span>}
            </small>
          );
        })()}
      </span>
      <span className="num">{pc(x.y)}</span>
    </button>
  );
  return (
    <div className="pd-osel" ref={ref}>
      {add ? (
        <button type="button" className="pd-osel-b add" aria-haspopup="listbox" aria-expanded={open} onClick={() => set({ pop: open ? null : key })}>
          {PIC.plus}
          <span className="v">Add an outcome</span>
          {IC.chev}
        </button>
      ) : (
        <button type="button" className="pd-osel-b" aria-haspopup="listbox" aria-expanded={open} onClick={() => set({ pop: open ? null : key })}>
          <span className="k">{GRP_LABEL[e.type] ?? "Market"}</span>
          {e.type === "match" ? <TeamLogo e={e} o={o} cls="xs" /> : null}
          <span className="v">{o.name}</span>
          <span className="p num">{pc(o.y)}</span>
          {IC.chev}
        </button>
      )}
      {open && (
        <div className="pop pd-olist" role="listbox">
          {lines.length > 0 && <div className="pd-og">Winner</div>}
          {list.map(opt)}
          {lines.length > 0 && <div className="pd-og">More on this game</div>}
          {lines.map(opt)}
        </div>
      )}
    </div>
  );
}

/**
 * Pay-with chip: CASH only. This is a fork of World, and World's markets settle in CASH (World's
 * dollar), so buying with USDC is not offered here (the server still accepts `pay: "USDC"`).
 */
function PayChip({ st, wallet }: { st: PanelState; wallet: PositionsResponse["wallet"] | null }) {
  return (
    <span className="pd-tokw">
      <span className="pd-tok" title={wallet ? `${nf(wallet.cash, 2)} CASH in your wallet` : undefined}>
        <Icon sym={st.pay} />
        {st.pay}
      </span>
    </span>
  );
}

/** Fork-only: a small "Get test CASH" when the wallet has no CASH. */
function Faucet({ address }: { address: string; pay: Pay }) {
  const faucet = usePredictFaucet();
  return (
    <div className="pd-fct">
      <span>No CASH in this wallet yet. This is a test network.</span>
      <button
        type="button"
        className="btn-s"
        disabled={faucet.isPending}
        onClick={() =>
          faucet.mutate(
            { address, amount: 100 },
            { onSuccess: () => showTxSuccess("Added 100 test CASH"), onError: (err) => showTxError(err instanceof Error ? err.message : String(err)) },
          )
        }
      >
        {faucet.isPending ? "Adding…" : "Get test CASH"}
      </button>
    </div>
  );
}

export interface PanelProps {
  e: PredictEvent;
  o: Outcome;
  st: PanelState;
  set: (p: Partial<PanelState>) => void;
  choose: (k: string) => void;
  addLeg: (k: string, s?: Side) => void;
  data: PositionsResponse | undefined;
  address: string | null;
  rate: number;
}

/** The trade panel. */
export const TradePanel = forwardRef<HTMLElement, PanelProps>(function TradePanel({ e, o, st, set, choose, addLeg, data, address, rate }, ref) {
  const { connectWallet } = useWallet();
  const trade = usePredictTrade();
  const connected = Boolean(address);
  const wallet = data?.wallet ?? null;
  const bal = wallet ? wallet.cash : 0;
  const buy = st.mode === "buy";
  const s = st.side;
  const L = lab(o, s);
  const tradableOuts = e.outs.filter(canTrade);
  const multi = e.outs.length > 1;
  const slipOn = buy && multi && tradableOuts.length > 1 && st.slip !== null;
  const busy = trade.isPending;
  const held = heldOf(data, o, s);
  const a = parseAmt(st.amt);
  const sellN = buy ? 0 : held.total - Math.min(a, held.total) < 0.01 && a > 0 ? held.total : Math.min(a, held.total);

  const walletLbl = !connected ? "Connect wallet" : buy || slipOn ? `Balance ${nf(bal, 2)} ${st.pay}` : `You hold ${shf(held.total)} ${L}`;
  const needFaucet = connected && wallet !== null && buy && bal <= 0;
  const cta = (label: string, onClick: (() => void) | null, disabled = false) =>
    !connected ? (
      <button type="button" className="pd-cta" onClick={() => connectWallet()}>
        {IC.wallet}Connect wallet
      </button>
    ) : (
      <button type="button" className="pd-cta" disabled={disabled || busy || !onClick} onClick={onClick ?? undefined}>
        {busy ? "Confirm in your wallet…" : label}
      </button>
    );

  // Previews are render helpers (called, not mounted), so typing in an input never remounts it.
  // ---- single buy -------------------------------------------------------------------------------
  function renderBuy() {
    const fx = buyFx(o, s, a, rate, held.pool);
    const q = fx.q;
    const tw = twinOf(e, o, s);
    const inPool = pooled(o);
    const other = s === "yes" ? "no" : "yes";
    const od = poolSide(o, other, rate);
    const mo = (a * fx.after.share * rate) / 100 / 12;
    let lbl = `Buy ${L}`;
    let dis = false;
    if (!canTrade(o)) [lbl, dis] = ["No price yet: no World trades on this market", true];
    else if (!a) [lbl, dis] = ["Enter amount", true];
    else if (a < MIN_TRADE_CASH || a > MAX_TRADE_CASH) [lbl, dis] = [`Buy between ${MIN_TRADE_CASH} and ${nf(MAX_TRADE_CASH)} ${st.pay}`, true];
    else if (a > bal) [lbl, dis] = [`Not enough ${st.pay}`, true];
    const exec = () =>
      trade.mutate(
        { legs: [{ marketId: o.k, outcome: s, side: "buy", amount: a }], pay: st.pay, successMessage: `Bought ${shf(q.sh)} ${L}${multi ? `, ${o.name}` : ""}${inPool ? ". They are joining Vanna's pool" : ""}` },
        { onSuccess: () => set({ amt: "100" }) },
      );
    return (
      <>
        <details className="pd-det" open>
          <summary>More details {IC.chev}</summary>
          <div className="rows num">
            <Kv k="Avg price" v={cf(ask(o, s))} />
            <Kv k="Shares" v={shf(q.sh)} />
            <Kv k={<>Pays if right <Info text={INFO.pays} /></>} v={usd(q.sh)} cls="g" />
            <Kv k="Profit if right" v={a && q.sh ? `${sUsd(q.sh - a)} (${pct(((q.sh - a) / a) * 100, 0)})` : `${usd(0)} (${pct(0, 0)})`} cls="g" />
          </div>
        </details>
        {inPool ? (
          <div className="pd-eb">
            <div className="pd-eb-h">
              <span>{IC.coins}Earns while you wait</span>
              <b className="num">{p2(fx.after.apy)} APY</b>
            </div>
            <div className="pd-eb-r num">
              <span>
                Paired <Info text={INFO.paired} />
              </span>
              <b>{pp(fx.after.share)} of these shares</b>
            </div>
            <Meter v={fx.after.share} />
            <div className="pd-eb-r num">
              <span>Your paired {L}</span>
              <b className="pd-ba">
                {shf(fx.pairedNow)}
                {IC.arrow}
                {shf(fx.pairedAfter)} shares
              </b>
            </div>
            {held.pool > 0 && (
              <div className="pd-eb-r num">
                <span>Your whole position</span>
                <b className={`pd-ba ${fx.after.apy < fx.before.apy - 0.005 ? "pd-dn" : ""}`}>
                  earns {p2(fx.before.apy)}
                  {IC.arrow}
                  {p2(fx.after.apy)}
                </b>
              </div>
            )}
            <div className="pd-eb-r num">
              <span>
                Est. yield <Info text={INFO.estYield} />
              </span>
              <b>+{usd(mo)} a month</b>
            </div>
            <p className="pd-eb-p">
              Yield comes as extra {L} shares, so it pays only if {L} wins.
            </p>
            {!fx.after.full && od.full && od.mine > 0 && (
              <p className="pd-eb-tip">
                {lab(o, other)} is fully paired here and earns {p2(od.apy)}.
              </p>
            )}
          </div>
        ) : (
          <div className="pd-eb sell">
            <div className="pd-eb-h">
              <span>{IC.coins}Not in Vanna&apos;s pool yet</span>
              <b className="num">{p2(0)} APY</b>
            </div>
            <p className="pd-eb-p">{INFO.notPooled} Each winning share still pays $1.</p>
          </div>
        )}
        {tw && (
          <p className="pd-twin">
            <TeamLogo e={e} o={tw.o} cls="xs" />
            <span>
              Same bet as{" "}
              <b>
                {tw.o.name} {lab(tw.o, tw.s)}
              </b>{" "}
              at {cf(ask(tw.o, tw.s))}
              {tw.tie ? ", except in a tie" : ""}. It earns {p2(poolSide(tw.o, tw.s, rate).apy)}.
            </span>
            <button type="button" className="lnk" onClick={() => (choose(tw.o.k), set({ side: tw.s }))}>
              Switch
            </button>
          </p>
        )}
        {cta(lbl, dis ? null : exec, dis)}
        <p className="pd-fine">{inPool ? "Your shares go straight into Vanna's pool in the same approval. Each winning share pays $1." : "Shares go to your wallet. Each winning share pays $1."}</p>
      </>
    );
  }

  // ---- sell -------------------------------------------------------------------------------------
  function renderSell() {
    const n = sellN;
    const q = quoteSell(o, s, n);
    const p = held.p;
    const fromWallet = Math.min(n, held.wallet);
    const fromPool = Math.max(0, n - fromWallet);
    const dangling = s === "yes" ? o.poolDetail.yesDangling : o.poolDetail.noDangling;
    const unpaired = Math.min(fromPool, dangling);
    const needUsd = Math.max(0, fromPool - unpaired);
    const ySh = p && p.shares ? (n * Math.max(0, p.yieldShares)) / p.shares : 0;
    const cost = p ? n * p.avg : 0;
    const how: React.ReactNode[] = [];
    if (fromWallet > 0) how.push(`${shf(fromWallet)} ${L} from your wallet sell first`);
    if (unpaired > 0) how.push(`${shf(unpaired)} unpaired ${L} come out of this market's pool, no USDC needed`);
    if (needUsd >= 0.005) how.push(`For your paired shares Vanna takes ${usd(needUsd)} USDC out of the pool and turns it back into ${L}`);
    how.push(`${n ? shf(n) : "The"} ${L} sell at ${cf(bid(o, s))} each`);
    let lbl = `Sell ${L}`;
    let dis = false;
    if (bid(o, s) === null) [lbl, dis] = ["No price yet: no World trades on this market", true];
    else if (!held.total) [lbl, dis] = [`You hold no ${L} shares here`, true];
    else if (!a) [lbl, dis] = ["Enter shares", true];
    else if (a > held.total + 1e-9) [lbl, dis] = ["Not enough shares", true];
    const exec = () =>
      trade.mutate(
        { legs: [{ marketId: o.k, outcome: s, side: "sell", amount: Math.floor(n * 1e6) / 1e6 }], successMessage: `Sold ${shf(n)} ${L} for about ${usd(q.usd)}` },
        { onSuccess: () => set({ amt: "" }) },
      );
    return (
      <>
        <details className="pd-det" open>
          <summary>More details {IC.chev}</summary>
          <div className="rows num">
            <Kv k="Avg price" v={cf(bid(o, s))} />
            <Kv k="You receive" v={`${usd(q.usd)} CASH`} cls="g" />
            <Kv k={<>Includes yield <Info text={INFO.earned} /></>} v={`${sUsd((ySh * (bid(o, s) ?? 0)) / 100)} (${shf(ySh)} shares)`} cls="e" />
            <Kv k="P&L on these shares" v={<span className={q.usd - cost >= 0 ? "pos" : "neg"}>{sUsd(q.usd - cost)}</span>} />
          </div>
        </details>
        <div className="pd-eb sell">
          <div className="pd-eb-h">
            <span>{IC.bolt}How this sell works</span>
            <b className="num">{usd(q.usd)}</b>
          </div>
          <ol className="pd-steps2">
            {how.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ol>
        </div>
        {cta(lbl, dis ? null : exec, dis)}
      </>
    );
  }

  // ---- bet slip ---------------------------------------------------------------------------------
  function renderSlip() {
    const legs = (st.slip ?? []).map((l) => {
      const lo = outOf(e, l.k)!;
      const la = parseAmt(l.amt);
      return { ...l, o: lo, a: la, q: quoteBuy(lo, l.s, la) };
    });
    const tot = legs.reduce((t, l) => t + l.a, 0);
    const sh = legs.reduce((t, l) => t + l.q.sh, 0);
    const paired = legs.reduce((t, l) => t + (pooled(l.o) ? l.q.sh * poolSide(l.o, l.s, rate, l.q.sh).share : 0), 0);
    const sc = scenarios(e, legs.filter((l) => l.a > 0).map((l) => ({ k: l.k, s: l.s, sh: l.q.sh })));
    const upd = (i: number, patch: Partial<SlipLegState>) => set({ slip: (st.slip ?? []).map((x, j) => (j === i ? { ...x, ...patch } : x)) });
    let lbl = `Buy all (${legs.length})`;
    let dis = false;
    if (legs.length < 1) [lbl, dis] = ["Add outcomes", true];
    else if (legs.some((l) => !(l.a > 0))) [lbl, dis] = ["Enter an amount for each", true];
    else if (legs.some((l) => l.a < MIN_TRADE_CASH || l.a > MAX_TRADE_CASH)) [lbl, dis] = [`Each between ${MIN_TRADE_CASH} and ${nf(MAX_TRADE_CASH)} ${st.pay}`, true];
    else if (tot > bal) [lbl, dis] = [`Not enough ${st.pay}`, true];
    const exec = () =>
      trade.mutate(
        { legs: legs.map((l) => ({ marketId: l.k, outcome: l.s, side: "buy" as const, amount: l.a })), pay: st.pay, successMessage: `Bought ${legs.length} outcomes for ${usd(tot)}` },
        { onSuccess: () => set({ slip: null, amt: "100" }) },
      );
    return (
      <>
        <OutSel e={e} o={o} add st={st} set={set} choose={choose} addLeg={(k) => addLeg(k)} data={data} />
        <div className="pd-bls">
          {legs.length ? (
            legs.map((l, i) => (
              <div key={l.k} className="pd-bl">
                <div className="pd-bl-h">
                  {e.type === "match" ? <TeamLogo e={e} o={l.o} cls="xs" /> : null}
                  <b>{isDraw(l.o) ? "Draw" : l.o.name}</b>
                  <button type="button" className="pd-x" aria-label={`Remove ${l.o.name}`} onClick={() => set({ slip: (st.slip ?? []).filter((_, j) => j !== i) })}>
                    {PIC.x}
                  </button>
                </div>
                <div className="pd-bl-b">
                  <span className="pd-bl-s">
                    {(["yes", "no"] as const).map((x, j) => (
                      <button key={x} type="button" className={`${x === "yes" ? "pd-y" : "pd-n"} ${l.s === x ? "on" : ""}`} onClick={() => upd(i, { s: x })}>
                        {lab(l.o, x)} {cpair(l.o.y, l.o.n)[j]}
                      </button>
                    ))}
                  </span>
                  <label className="pd-bl-a">
                    <Icon sym={st.pay} className="pd-i14" />
                    <input inputMode="decimal" autoComplete="off" value={l.amt} aria-label={`Amount for ${l.o.name}`} onChange={(ev) => upd(i, { amt: cleanAmt(ev.target.value) })} />
                  </label>
                </div>
                <small className="num">{l.a ? `${shf(l.q.sh)} shares at ${cf(l.q.avg)}, pays ${usd(l.q.sh)} if right${pooled(l.o) ? "" : ". Not in Vanna's pool yet"}` : "Enter an amount"}</small>
              </div>
            ))
          ) : (
            <div className="pd-empty sm">Tap Buy Yes or Buy No on any outcome, or add one above.</div>
          )}
        </div>
        <div className="pd-slip-sum">
          <div className="pd-det">
            <div className="rows num">
              <Kv k="Total cost" v={<><Icon sym={st.pay} className="pd-i14" />{usd(tot)}</>} />
              <Kv k="Shares" v={shf(sh)} />
              <Kv k={<>Earning on <Info text={INFO.paired} /></>} v={`${pp(sh ? paired / sh : 0)} of these shares`} cls="e" />
            </div>
          </div>
          {sc.length > 0 && (
            <div className="pd-sc">
              <div className="pd-sc-h">
                <span>
                  If this happens <Info text={INFO.slip} />
                </span>
                <span>Pays</span>
                <span>Profit</span>
              </div>
              {sc.map((r, i) =>
                r.pay === null ? (
                  <div key={i} className="pd-sc-r num">
                    <span>{r.label}</span>
                    <b>
                      {usd(r.lo!)} to {usd(r.hi!)}
                    </b>
                    <b />
                  </div>
                ) : (
                  <div key={i} className="pd-sc-r num">
                    <span>{r.label}</span>
                    <b>{usd(r.pay)}</b>
                    <b className={r.pay - tot >= 0 ? "pos" : "neg"}>{sUsd(r.pay - tot)}</b>
                  </div>
                ),
              )}
            </div>
          )}
          {cta(`${lbl}${!dis && legs.length ? ` for ${usd(tot)}` : ""}`, dis ? null : exec, dis)}
          <p className="pd-fine">One wallet approval for every outcome. Outcomes in Vanna&apos;s pool start earning like a single buy.</p>
        </div>
      </>
    );
  }

  const px = buy ? cpair(ask(o, "yes"), ask(o, "no")) : cpair(bid(o, "yes"), bid(o, "no"));
  return (
    <section className="pd-panel" aria-label="Trade" ref={ref}>
      <div className="pd-ph">
        <div className="pd-ph-t">
          <EvLogo e={e} cls="xs" />
          <b>{e.title}</b>
        </div>
        <div className="pd-bs" role="group" aria-label="Buy or sell">
          <button type="button" className={buy ? "on" : ""} aria-pressed={buy} onClick={() => !buy && set({ mode: "buy", amt: "100", pop: null })}>
            Buy
          </button>
          <button
            type="button"
            className={!buy ? "on" : ""}
            aria-pressed={!buy}
            onClick={() => buy && set({ mode: "sell", slip: null, pop: null, amt: held.total ? String(Math.floor(held.total * 100) / 100) : "" })}
          >
            Sell
          </button>
        </div>
      </div>
      {buy && multi && tradableOuts.length > 1 && (
        <div className="pd-seg" role="group" aria-label="Single outcome or bet slip">
          <button type="button" className={!slipOn ? "on" : ""} onClick={() => set({ slip: null, pop: null })}>
            One outcome
          </button>
          <button type="button" className={slipOn ? "on" : ""} onClick={() => set({ slip: st.slip ?? [], pop: null })}>
            Bet slip{st.slip && st.slip.length ? ` (${st.slip.length})` : ""}
          </button>
        </div>
      )}
      {slipOn ? (
        <>
          <div className="pd-slipbar">
            <PayChip st={st} wallet={wallet} />
            <span className="pd-bal num">{walletLbl}</span>
          </div>
          {needFaucet && <Faucet address={address!} pay={st.pay} />}
          {(st.slip?.length ?? 0) >= MAX_TRADE_LEGS && <p className="pd-fine">A slip holds up to {MAX_TRADE_LEGS} outcomes.</p>}
          {renderSlip()}
        </>
      ) : (
        <>
          {multi && <OutSel e={e} o={o} st={st} set={set} choose={choose} addLeg={(k) => addLeg(k)} data={data} />}
          <div className="pd-yn num">
            {(["yes", "no"] as const).map((x, i) => (
              <button
                key={x}
                type="button"
                className={`${x === "yes" ? "pd-y" : "pd-n"} ${s === x ? "on" : ""}`}
                aria-pressed={s === x}
                onClick={() => set(buy ? { side: x } : { side: x, amt: (() => { const h = heldOf(data, o, x).total; return h ? String(Math.floor(h * 100) / 100) : ""; })() })}
              >
                <span>{lab(o, x).toUpperCase()}</span>
                <span className="pd-op">{px[i]}</span>
              </button>
            ))}
          </div>
          <div className="pd-amt">
            <div className="pd-amt-t">
              {buy ? (
                <PayChip st={st} wallet={wallet} />
              ) : (
                <span className="pd-tok sh">
                  <SideTag s={s} L={L} />
                  shares
                </span>
              )}
              <input inputMode="decimal" autoComplete="off" placeholder="0" value={st.amt} aria-label={buy ? "Amount to spend" : "Shares to sell"} onChange={(ev) => set({ amt: cleanAmt(ev.target.value) })} />
            </div>
            <p className="pd-amt-u num">~ {usd(buy ? a : quoteSell(o, s, sellN).usd)}</p>
            <div className="pd-amt-f">
              <span className="pd-pcs">
                {[10, 25, 50, 100].map((x) => (
                  <button
                    key={x}
                    type="button"
                    disabled={!connected}
                    onClick={() => {
                      const base = buy ? Math.min(bal, MAX_TRADE_CASH) : held.total;
                      set({ amt: String(Math.floor(base * (x / 100) * 100) / 100) });
                    }}
                  >
                    {x}%
                  </button>
                ))}
              </span>
              <span className="pd-bal num">{walletLbl}</span>
            </div>
          </div>
          {needFaucet && <Faucet address={address!} pay={st.pay} />}
          <div className="pd-prev">{buy ? renderBuy() : renderSell()}</div>
        </>
      )}
    </section>
  );
});
