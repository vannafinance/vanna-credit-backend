"use client";

/**
 * Predict (BETA) — "Bring your positions" sheet (design predict.js import sheet): World outcome
 * tokens found in the wallet (one-click "Earn on them" deposit) and Polymarket positions (read-only
 * link, "Move & earn" with a 3-step quote). UI only: sample positions, the steps are simulated with
 * timers and nothing is signed or sent. Mounted by the Predict pages; Portfolio can mount it too
 * and open it with `openPredictImport()`.
 */
import "./predict-v3.css";
import { useEffect, useRef, useState } from "react";
import { IC, Icon, VMark } from "@/components/v3/icons";
import { Info, Modal } from "@/components/v3/ui";
import { nf, pct, sUsd, usd } from "@/components/v3/format";
import {
  EVM, OUT, impAll, impEarn, impLeft, impx, mvQuote, pmLink, pmLinkSet, finishMove, allPos, pmx, lab,
  closePredictImport, predictToast, usePredictSample, usePredictStore,
  type ImportItem, type MoveQuote, type Outcome, type PredictEvent,
} from "@/lib/predict-sample";
import { INFO, IcFor, Kv, PIC, PreviewNote, cpair, cf, p2, shf } from "./ui";

function ImpRow({ x, onMove }: { x: ImportItem; onMove: (x: ImportItem) => void }) {
  const m = impx(x);
  const p = x.pos ? allPos().find((q) => q.id === x.pos) : null;
  const pm = p ? pmx(p) : null;
  let act: React.ReactNode;
  if (x.done && x.src === "wallet") act = pm && pm.merging ? <span className="mini warn">Merging…</span> : <span className="mini ok">Earning {p2(pm ? pm.apy : m.apy)}</span>;
  else if (x.done) act = <span className="mini ok">Moved · {shf(x.after || 0)} {m.L}</span>;
  else if (x.src === "wallet")
    act = (
      <button type="button" className="btn-v" onClick={() => { const t = impEarn([x.id]); if (t) predictToast(t); }}>
        Earn {p2(m.apy)}
      </button>
    );
  else if (!x.ev)
    act = (
      <span className="mini pd-nl">
        Not on Vanna <Info text={INFO.unlisted} />
      </span>
    );
  else
    act = (
      <button type="button" className="btn-v" onClick={() => onMove(x)}>
        Move &amp; earn
      </button>
    );
  const [avgC, nowC] = cpair(x.avg * 100, m.price);
  return (
    <div className={`pd-irow ${x.done ? "done" : ""}`}>
      <span className="pd-i-m">
        {m.e ? <IcFor e={m.e} o={m.o} cls="sm" /> : <Icon sym="POLY" className="pd-i30" />}
        <span>
          <b>{m.event}</b>
          <small>
            {m.market ? `${m.market} · ` : ""}
            <span className="pd-src">
              {x.src === "wallet" ? <><Icon sym="WORLD" className="pd-i12" />World · Solana wallet</> : <><Icon sym="POLY" className="pd-i12" />Polymarket · Polygon</>}
            </span>
          </small>
        </span>
      </span>
      <span className={`pd-sd ${x.side}`}>{m.L.toUpperCase()}</span>
      <span className="num">
        <b>{shf(x.sh)}</b>
        <small>avg {avgC}</small>
      </span>
      <span className="num">
        <b>{usd(m.value)}</b>
        <small>at {nowC}</small>
      </span>
      <span className="num">
        <b className={m.apy ? "pos" : "mut"}>{p2(m.apy || 0)}</b>
        <small>APY</small>
      </span>
      <span className="pd-i-a">{act}</span>
    </div>
  );
}

function WalletTab({ onMove }: { onMove: (x: ImportItem) => void }) {
  const all = impAll("wallet");
  const left = all.filter((x) => !x.done);
  const tot = left.reduce((t, x) => t + impx(x).value, 0);
  const mo = left.reduce((t, x) => {
    const m = impx(x);
    return t + (m.value * m.apy) / 100 / 12;
  }, 0);
  return (
    <>
      <div className="pd-isrc">
        <Icon sym="WORLD" className="pd-i16" />
        <span>
          Found in <b>sample wallet</b> · World outcome tokens, the same tokens the vault takes
        </span>
      </div>
      <div className="pd-ilist">
        {all.map((x) => (
          <ImpRow key={x.id} x={x} onMove={onMove} />
        ))}
      </div>
      {left.length ? (
        <div className="pd-ifoot num">
          <span>
            <b>
              {left.length} position{left.length > 1 ? "s" : ""} · {usd(tot)}
            </b>
            <small>+{usd(mo)} / month once deposited</small>
          </span>
          <button type="button" className="btn-p g" onClick={() => { const t = impEarn(left.map((i) => i.id)); if (t) predictToast(t); }}>
            Earn on all · {Math.ceil(left.length / 3)} signature{left.length > 3 ? "s" : ""}
          </button>
        </div>
      ) : (
        <div className="pd-idone">
          {IC.check}
          <span>All wallet positions are in the vault. They show on each market and in Portfolio.</span>
        </div>
      )}
      <p className="pd-fact">
        {IC.shield}
        <span>Depositing keeps your bet: same shares, same payout if right. Matched pairs are lent in the USDC Earn pool. Selling is one step; if the Earn pool is short of USDC, part of a sell waits until it frees up.</span>
      </p>
    </>
  );
}

function PolyTab({ onMove }: { onMove: (x: ImportItem) => void }) {
  const [addr, setAddr] = useState("");
  const [err, setErr] = useState("");
  const pm = pmLink();
  if (!pm)
    return (
      <div className="pd-link">
        <div className="pd-link-h">
          <b>
            <Icon sym="POLY" className="pd-i20" />
            Link your Polymarket account
          </b>
          <span>Read-only: we read your positions from Polymarket&apos;s public data. Nothing moves until you confirm a move.</span>
        </div>
        <div className="pd-link-o">
          <button type="button" className="btn-o" onClick={() => pmLinkSet({ addr: "0x3f2c…a91c", how: "wallet" })}>
            {PIC.link}Connect EVM wallet
          </button>
          <span className="pd-or">or</span>
          <label className="pd-addr">
            <input placeholder="Polymarket profile address 0x…" value={addr} onChange={(e) => setAddr(e.target.value)} autoComplete="off" spellCheck={false} aria-label="Polymarket profile address" />
          </label>
          <button
            type="button"
            className="btn-o"
            onClick={() => {
              const a = addr.trim();
              if (!/^0x[0-9a-fA-F]{8,40}$/.test(a)) {
                setErr("Enter the 0x address shown on your Polymarket profile.");
                return;
              }
              setErr("");
              pmLinkSet({ addr: `${a.slice(0, 6)}…${a.slice(-4)}`, how: "address" });
            }}
          >
            Look up
          </button>
        </div>
        {err && <p className="pd-err">{err}</p>}
        <p className="pd-fact">
          {IC.shield}
          <span>Polymarket positions are tokens on Polygon. They can&apos;t be sent to Solana: a move sells them there, brings the money to Solana and buys the same outcome here.</span>
        </p>
      </div>
    );
  const all = impAll("polymarket");
  return (
    <>
      <div className="pd-isrc">
        <Icon sym="POLY" className="pd-i16" />
        <span>
          Polymarket account <b>{pm.addr}</b> · {all.length} positions · read-only (sample)
        </span>
        <button type="button" className="lnk" onClick={() => pmLinkSet(null)}>
          Unlink
        </button>
      </div>
      <div className="pd-ilist">
        {all.map((x) => (
          <ImpRow key={x.id} x={x} onMove={onMove} />
        ))}
      </div>
      <p className="pd-fact">
        {IC.shield}
        <span>Move = sell on Polymarket, withdraw to Solana as CASH (Polymarket&apos;s bridge), buy the same outcome on Vanna and deposit it. You sign on Polygon and on Solana; the quote shows every cost first.</span>
      </p>
    </>
  );
}

function Move({ id, q, onBack }: { id: string; q: MoveQuote; onBack: () => void }) {
  const [st, setSt] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const x = impAll("polymarket").find((i) => i.id === id) as ImportItem;
  const e = EVM(x.ev) as PredictEvent;
  const o = OUT(e, x.o) as Outcome;
  const L = lab(o, x.side);
  const done = st === 4;
  const busy = st > 0 && st < 4;
  const run = () => {
    if (st) return;
    setSt(1);
    timers.current = [
      setTimeout(() => setSt(2), 1300),
      setTimeout(() => setSt(3), 3700),
      setTimeout(() => {
        const t = finishMove(id, q);
        setSt(4);
        if (t) predictToast(t);
      }, 5000),
    ];
  };
  const steps: [React.ReactNode, string, string, string][] = [
    [<><Icon sym="POLY" className="pd-i16" />Sell on Polymarket</>, `${shf(x.sh)} ${L} at ${cf(q.sellAvg)} avg · realised ${sUsd(q.realised)}`, `+${usd(q.proceeds)}`, "Polygon · you sign"],
    [<><Icon sym="CASH" className="pd-i16" />Bridge to Solana</>, "pUSD to CASH (Polymarket bridge)", `−${usd(q.bridge)} · ~1 min`, "Polygon · you sign"],
    [<><VMark size={16} />Buy on Vanna + deposit</>, `${shf(q.after)} ${L} at ${cf(q.buyAvg)} avg`, `${p2(q.apy)} APY`, "Solana · you sign"],
  ];
  const [buyC, sellC] = cpair(q.buyAvg, q.sellAvg);
  return (
    <>
      <button type="button" className="pd-iback" onClick={onBack} disabled={busy}>
        {PIC.back}All positions
      </button>
      <h2>{done ? `Moved ${shf(x.sh)} ${L} to Vanna` : "Move to Vanna & earn"}</h2>
      <p className="msub">
        {e.title}
        {e.outs.length > 1 ? ` · ${o.name}` : ""} · {L}
      </p>
      <div className="pd-mvsum num">
        <div>
          <span>{done ? "Sold on Polymarket" : "Shares now"}</span>
          <b>{shf(x.sh)}</b>
          <small>{done ? `realised ${sUsd(q.realised)}` : "on Polymarket"}</small>
        </div>
        <div className="ar">{IC.arrow}</div>
        <div>
          <span>{done ? "Now in Vanna" : "Shares after"}</span>
          <b>{shf(q.after)}</b>
          <small>in Vanna&apos;s vault</small>
        </div>
        <div>
          <span>{done ? "Earning" : "Starts earning"}</span>
          <b className="e">{p2(q.apy)}</b>
          <small>+{usd(q.mo)} / month</small>
        </div>
      </div>
      <ol className="pd-steps">
        {steps.map((s, i) => {
          const n = i + 1;
          const cls = st > n ? "ok" : st === n ? "run" : "";
          return (
            <li key={n} className={cls}>
              <span className="pd-dot">{cls === "ok" ? IC.check : <span>{n}</span>}</span>
              <span>
                <b>{s[0]}</b>
                <small>{s[1]}</small>
              </span>
              <span className="r num">
                {s[2]}
                <small>{s[3]}</small>
              </span>
            </li>
          );
        })}
      </ol>
      <div className="pd-mvkv num">
        <Kv k={<>Price gap <Info text={INFO.gap} /></>} v={<>{q.gap >= 0 ? "+" : "−"}{cf(Math.abs(q.gap))} <span className="mut" style={{ fontWeight: 500 }}>(buy {buyC} here, sell {sellC} there)</span></>} />
        <Kv k={<>Cost of moving <Info text={INFO.moveCost} /></>} v={`${shf(q.lossSh)} shares (${pct(q.lossPct, 1)}) · ~${usd(q.lossUsd)}`} />
        <Kv k={<>Slippage <Info text={INFO.slip} /></>} v={`Polymarket sell −${nf(q.sellSlip, 1)}% · Vanna buy +${nf(q.buySlip, 1)}% · limit ${nf(q.limit, 1)}%`} />
        <Kv k="Out of the market" v="~1 min while funds bridge" />
        <Kv k="Resolution" v="World operator here, UMA on Polymarket" />
      </div>
      <PreviewNote />
      {st === 0 ? (
        <button type="button" className="btn-p g" onClick={run}>
          Simulate move · 3 signatures
        </button>
      ) : busy ? (
        <button type="button" className="btn-p" disabled>
          Moving: step {st} of 3
        </button>
      ) : (
        <button type="button" className="btn-p g" onClick={onBack}>
          Done
        </button>
      )}
    </>
  );
}

/** The import sheet; renders while `importTab` is set in the Predict store. */
export function ImportSheet() {
  usePredictSample();
  const tab0 = usePredictStore((s) => s.importTab);
  const [tab, setTab] = useState<"wallet" | "polymarket">("wallet");
  const [mv, setMv] = useState<{ id: string; q: MoveQuote } | null>(null);
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  // Re-sync the tab each time the sheet is (re)opened on a given tab.
  if (tab0 && openedFor !== tab0) {
    setOpenedFor(tab0);
    setTab(tab0);
    setMv(null);
  }
  if (!tab0 && openedFor) setOpenedFor(null);
  if (!tab0) return null;
  const pm = pmLink();
  const wl = impLeft("wallet").length;
  const pl = impLeft("polymarket").length;
  const onMove = (x: ImportItem) => setMv({ id: x.id, q: mvQuote(x) });
  return (
    <Modal wide onClose={closePredictImport}>
      <div className="pd-imp">
        {mv ? (
          <Move id={mv.id} q={mv.q} onBack={() => setMv(null)} />
        ) : (
          <>
            <h2>Bring your positions</h2>
            <p className="msub">Put outcomes you already hold to work in Vanna&apos;s yield vault.</p>
            <PreviewNote />
            <div className="pd-itabs" role="tablist">
              <button type="button" className={tab === "wallet" ? "on" : ""} role="tab" aria-selected={tab === "wallet"} onClick={() => setTab("wallet")}>
                <Icon sym="WORLD" className="pd-i18" />
                Wallet <em>· Solana</em> <small>{wl}</small>
              </button>
              <button type="button" className={tab === "polymarket" ? "on" : ""} role="tab" aria-selected={tab === "polymarket"} onClick={() => setTab("polymarket")}>
                <Icon sym="POLY" className="pd-i18" />
                Polymarket <em>· Polygon</em> <small>{pm ? pl : "link"}</small>
              </button>
            </div>
            {tab === "wallet" ? <WalletTab onMove={onMove} /> : <PolyTab onMove={onMove} />}
          </>
        )}
      </div>
    </Modal>
  );
}
