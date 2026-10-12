"use client";

/**
 * Portfolio V3 building blocks (ports of the design's portfolio.js helpers): the info card, the
 * chart card, the Current / History switch, the card-row grid table, the perps-style table, tags,
 * badges and the transaction link. Styled by `portfolio-v3.css` (`pf-*` classes).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AreaChart, Info, type ChartSeries } from "@/components/v3/ui";
import { IC, Icon } from "@/components/v3/icons";
import { usd } from "@/components/v3/format";
import { explorerUrl } from "@/lib/solana/config";
import { LIQ_HF, hfPos } from "@/lib/account-model";

/** One sentence per info icon (the design's TT). */
export const TT = {
  net: "Your wallet tokens, your lending supply (interest included) and your margin account's equity, at today's oracle prices.",
  earn: "Lending interest plus trading P&L (perps realized and open, spot open) and farm earnings (Kamino, Basis and Perena vaults: value now minus what you put in). Borrowed funds are not P&L. Borrow interest is shown with the health factor.",
  hf: "Everything your margin account holds divided by what it owes; at 1.10 or below it can be liquidated.",
  interest: "Interest your loans have accrued so far; it adds to what the account owes, so it lowers the health factor.",
  value: "Everything in your margin account (tokens, farm receipts and the Phoenix account) before subtracting what it owes.",
  coll: "Collateral you deposited into the margin account (deposits minus withdrawals), at today's prices.",
  borrowed: "Everything your margin account owes, interest included, at today's prices.",
  lev: "Everything the account holds (borrowed funds included, open perps at their full size) divided by your account equity. 1.00x means no borrowing.",
  ratio: "What the account owes as a share of everything it holds.",
  left: "Value the account can lose before the health factor reaches 1.10.",
  room: "The smallest single price move that takes the health factor to 1.10, with every other price unchanged.",
  liqColl: "Price of your largest volatile collateral at which the account reaches health factor 1.10, other prices unchanged.",
  liqPos: "Price of this market at which your whole cross-margined account reaches health factor 1.10; None means no move in this price alone liquidates it.",
  flash: "Closes every position and repays every loan; your collateral stays in the margin account.",
  holdings: "What you supplied to Vanna's lending pools plus the interest it earned, at today's prices.",
  lendInt: "Interest your supply has earned so far, across all pools (only pools whose on-chain history proves the cost basis).",
  perpsValue: "Equity of your Phoenix positions plus the USDC idle in your Phoenix account, as Vanna values it.",
  perpsSize: "Total size of your open perp positions at the index price.",
  perpsPnl: "Profit or loss on open perp positions at the index price, before fees and funding.",
  perpsReal: "USDC back from Phoenix plus what is idle there, minus what was sent in, for positions already closed (fees and funding included).",
  spotSize: "Market value of every token your margin account holds (deposits, swapped tokens, Kamino and vault receipts), at today's prices.",
  spotLS: "Value of the tokens you hold long, and of the tokens you borrowed and sold short.",
  spotPnl: "Profit or loss on open spot positions with an on-chain entry price, at today's price, before fees and interest.",
  farmApy: "APY of all your farm positions weighted by their value (Kamino supply APY, Basis vaults' 7-day APY, Perena's published APY), before the borrow cost of any loan that funds them.",
  farmShare: "Farm positions as a share of everything in your margin account.",
  farmEarned: "Underlying redeemable now minus what was supplied (from the margin's on-chain farm history).",
};

export const sign = (n: number) => (n > 0.004 ? "pos" : n < -0.004 ? "neg" : "");

/** "Lender Stats" / "Farming Info" card: title + key/value rows. */
export function InfoCard({ title, rows }: { title: string; rows: [ReactNode, ReactNode, string?, string?][] }) {
  return (
    <section className="pf-info">
      <h3>{title}</h3>
      <div className="pf-info-b">
        {rows.map(([k, v, cls, tip], i) => (
          <div className="pf-kv" key={i}>
            <span>
              {k}
              {tip && <Info text={tip} />}
            </span>
            <b className={`num ${cls ?? ""}`}>{v}</b>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Chart card: title, current value, a sub chip and either the chart or an empty note. Pass
 * `series: null` when the chain has no history to draw (the current value still shows).
 */
export function ChartCard({
  title,
  value,
  sub,
  series,
  labels,
  empty = "No history yet",
  h = 116,
  min,
}: {
  title: string;
  value: ReactNode;
  sub: ReactNode;
  series: ChartSeries[] | null;
  labels?: string[];
  empty?: ReactNode;
  h?: number;
  min?: number;
}) {
  const flat = !series || series.every((s) => s.pts.every((v) => Math.abs(v) < 0.005));
  const n = labels?.length ?? 0;
  const xl = n > 3 ? [labels![0], labels![Math.round(n / 3)], labels![Math.round((2 * n) / 3)], labels![n - 1]] : labels;
  return (
    <section className="pf-chart">
      <div className="pf-chart-h">
        <div>
          <span className="pf-chart-t">{title}</span>
          <b className="num">{value}</b>
        </div>
        <span className="pf-chart-s num">{sub}</span>
      </div>
      {flat ? (
        <div className="pf-chart-e">{empty}</div>
      ) : (
        <div className="pf-chart-b">
          <AreaChart series={series!} h={h} yFmt={(v) => usd(v, 2)} xLabels={xl} xTips={labels} fmtKey="usd" ticks={3} min={min} />
        </div>
      )}
    </section>
  );
}

/** Current Position | Position History switch (the live Earn table tabs). */
export function HistNav({ value, onChange, labels = ["Current Position", "Position History"] }: { value: "cur" | "hist"; onChange: (v: "cur" | "hist") => void; labels?: [string, string] }) {
  return (
    <nav className="pf-seg" role="tablist">
      {(["cur", "hist"] as const).map((k, i) => (
        <button key={k} type="button" role="tab" aria-selected={value === k} className={value === k ? "on" : ""} onClick={() => onChange(k)}>
          {labels[i]}
        </button>
      ))}
    </nav>
  );
}

export interface GridRow {
  key: string;
  cells: ReactNode[];
  /** Whole row clickable (not a <button>, so it may hold buttons). */
  onClick?: () => void;
  hidden?: boolean;
}

/** The live Earn "Positions Table" body: header + card rows (labelled cards below 1280 px). */
export function Grid({ cols, heads, rows, empty }: { cols: string; heads: ReactNode[]; rows: GridRow[]; empty?: ReactNode }) {
  const visible = rows.filter((r) => !r.hidden);
  if (!visible.length) return <div className="pf-none">{empty ?? "No data available"}</div>;
  const label = (h: ReactNode) => (typeof h === "string" ? h : "");
  return (
    <div className="pf-grid">
      <div className="pf-th" style={{ gridTemplateColumns: cols }}>
        {heads.map((h, i) => (
          <span key={i}>
            {h ? <i className="pf-sort">{IC.sort}</i> : null}
            {h}
          </span>
        ))}
      </div>
      <div className="pf-tb">
        {visible.map((r) => (
          <div
            key={r.key}
            className={`pf-tr ${r.onClick ? "pf-click" : ""}`}
            style={{ gridTemplateColumns: cols }}
            onClick={r.onClick}
            role={r.onClick ? "link" : undefined}
            tabIndex={r.onClick ? 0 : undefined}
            onKeyDown={r.onClick ? (e) => e.key === "Enter" && e.target === e.currentTarget && r.onClick!() : undefined}
          >
            {r.cells.map((c, i) => (
              <span key={i} className="pf-td" data-l={label(heads[i])}>
                {c}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Cell text: title (+ tags) + description. */
export function Ct({ children, desc, tags }: { children: ReactNode; desc?: ReactNode; tags?: ReactNode }) {
  return (
    <>
      <span className="pf-ct">{children}</span>
      {tags && <span className="pf-tags">{tags}</span>}
      {desc !== undefined && desc !== "" && <span className="pf-cd">{desc}</span>}
    </>
  );
}

export const Tag = ({ children, cls = "" }: { children: ReactNode; cls?: string }) => <span className={`pf-tag ${cls}`}>{children}</span>;
export const LsTag = ({ side }: { side: "long" | "short" }) => <Tag cls={side === "long" ? "pf-t-long" : "pf-t-short"}>{side === "long" ? "Long" : "Short"}</Tag>;

/** History type badge: outflows amber, borrow / liquidation red, the rest green. */
export function Badge({ act }: { act: string }) {
  const cls = /withdraw|close|reduce|sell|repay|settle/i.test(act) ? "pf-warn" : /borrow|liquid/i.test(act) ? "pf-bad" : "pf-ok";
  return <span className={`pf-badge ${cls}`}>{act}</span>;
}
export const Success = () => <span className="pf-badge pf-ok">Success</span>;

const GO = (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
    <path d="M9.3 5H.6M9.3 5 5 .6M9.3 5 5 9.3" stroke="currentColor" strokeWidth="1.25" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const short = (sig: string) => `${sig.slice(0, 4)}…${sig.slice(4, 8)}`;
/** Transaction link to the explorer (custom-RPC cluster = the fork). */
export function TxCell({ sig, plain }: { sig: string; plain?: boolean }) {
  if (!sig) return <>N/A</>;
  return (
    <a className={plain ? "pf-txl" : "pf-tx"} href={explorerUrl("tx", sig)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
      {short(sig)}
      {!plain && <i>{GO}</i>}
    </a>
  );
}

/** "Oct 7, 15:04" — one date format on every history (ms since epoch). */
export const when = (ms: number) => {
  if (!ms) return "N/A";
  const d = new Date(ms);
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** Token logo + label. */
export const TokCell = ({ sym, label, tags }: { sym: string; label?: ReactNode; tags?: ReactNode }) => (
  <Ct tags={tags}>
    <Icon sym={sym} className="ico pf-i16" />
    {label ?? sym}
  </Ct>
);

/** Venue name with logo(s) ("Jupiter", "Kamino", "Phoenix"). */
export const Venue = ({ name }: { name: string }) => (
  <span className="pf-ven">
    <Icon sym={name} className="ico pf-i16" />
    {name}
  </span>
);

/** The live perps table (cards below 1280 px). `right` = right-aligned column indexes. */
export function PTable({ heads, rows, right = [] }: { heads: ReactNode[]; rows: { key: string; side?: "long" | "short" | null; cells: ReactNode[] }[]; right?: number[] }) {
  const label = (h: ReactNode) => (typeof h === "string" ? h : "");
  return (
    <div className="pf-pt">
      <div className="pf-pt-s">
        <table>
          <thead>
            <tr>
              {heads.map((h, i) => (
                <th key={i} className={right.includes(i) ? "pf-r" : ""}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                {r.cells.map((c, i) => (
                  <td key={i} className={`${right.includes(i) ? "pf-r" : ""}${i === 0 && r.side ? ` pf-s-${r.side}` : ""}`} data-l={label(heads[i])}>
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Popover dropdown (the design's core popover): one trigger, a menu; outside click / Escape closes.
 */
export function Dropdown({ trigger, children, right }: { trigger: (open: boolean, toggle: () => void) => ReactNode; children: (close: () => void) => ReactNode; right?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e.type === "keydown" && (e as KeyboardEvent).key !== "Escape") return;
      if (e.type === "mousedown" && ref.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <span className="pf-dd" ref={ref}>
      {trigger(open, () => setOpen((o) => !o))}
      {open && (
        <div className={`pop ${right ? "r" : ""} pf-pop`} role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </span>
  );
}

export const FILTER_IC = (
  <svg width="17" height="12" viewBox="0 0 17 12" aria-hidden="true">
    <path d="M.8 0h15a.8.8 0 0 1 0 1.7H.8A.8.8 0 0 1 .8 0zM2.9 5h10.9a.8.8 0 0 1 0 1.7H2.9a.8.8 0 0 1 0-1.7zM5.8 10h5a.8.8 0 0 1 0 1.7h-5a.8.8 0 0 1 0-1.7z" fill="currentColor" />
  </svg>
);
export const EYE_IC = (
  <svg width="14" height="10" viewBox="0 0 14 10" aria-hidden="true">
    <path d="M6.7 7.3a2.7 2.7 0 1 0 0-5.5 2.7 2.7 0 0 0 0 5.5zm0 1.8C3.9 9.1 1.4 7.4.3 4.5 1.4 1.7 3.9 0 6.7 0s5.3 1.7 6.4 4.5c-1.1 2.9-3.6 4.6-6.4 4.6z" fill="currentColor" />
  </svg>
);

/** The design's health-factor bar: liquidation tick at 1.10, the account's marker when it has debt. */
export function HfBar({ hf }: { hf: number | null }) {
  return (
    <div className={`hfbar pf-hfbar ${hf === null ? "pf-off" : ""}`} aria-hidden="true">
      <span className="pf-liqt" style={{ left: `${hfPos(LIQ_HF)}%` }} />
      {hf !== null && <i style={{ left: `${hfPos(hf)}%` }} />}
    </div>
  );
}

