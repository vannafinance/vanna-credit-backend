"use client";

/** Bottom of the terminal: Positions | History | Account, plus the close / close-all modals. */
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { PerpHistoryRow, PerpSide } from "@/lib/solana/perps-types";
import { explorerUrl } from "@/lib/solana/config";
import type { AccountNumbers, LiqRoom } from "./account-model";
import { LIQ_HF, hfZone } from "./account-model";
import { hfFmt, levFmt, nf, price, roomSub, roomText, roomZone, sUsd, spct, tokAmt, upDn, usd } from "./format";
import { Go, Img, Info, Modal, PHOENIX_ICON, Slider, VANNA_ICON, marketIcon } from "./ui";
import { VannaLoader } from "@/components/v3/vanna-loader";

/** One open position as the terminal shows it. */
export interface PositionRow {
  key: string;
  side: PerpSide;
  tokens: number;
  entry: number;
  /** Phoenix mark (live), USD. */
  mark: number;
  /** Size at the mark, USD. */
  sizeUsd: number;
  /** Liquidation price of the whole account along this market (adverse side), null = None. */
  liq: number | null;
  /** Unrealized PnL at the mark, USD. */
  pnl: number;
  /** This position's share of the Phoenix USDC (cross margin, split by entry notional). */
  collateral: number;
  leverage: number;
  /** collateral + PnL + funding. */
  equity: number;
  fundingUsd: number;
  takerFee: number;
}

const sideTxt = (s: PerpSide) => (s === "long" ? "Long" : "Short");
const SideTag = ({ s }: { s: PerpSide }) => <span className={`px-side ${s}`}>{sideTxt(s)}</span>;

function DistTag({ liq, base }: { liq: number; base: number }) {
  const d = ((liq - base) / base) * 100;
  return <small className={`px-dist ${Math.abs(d) < 10 ? "near" : ""}`}>{spct(d, 1)}</small>;
}

function LiqCell({ row, hf }: { row: PositionRow; hf: number }) {
  if (hf <= LIQ_HF)
    return (
      <>
        <b className="z-danger">Now</b>
        <Info text="The account is at or below health factor 1.10 and can be liquidated now." />
      </>
    );
  if (row.liq === null)
    return (
      <>
        <span className="px-mut">None</span>
        <Info text="No price move against this position liquidates the account on its own: the rest of the account covers it." />
      </>
    );
  return (
    <span className="px-2l">
      <span>${price(row.liq)}</span>
      <DistTag liq={row.liq} base={row.mark} />
    </span>
  );
}

export function BottomPanel({
  connected,
  onConnect,
  rows,
  history,
  historyLoading,
  tab,
  onTab,
  now,
  room,
  available,
  phoenixUsdc,
  withdrawableNow,
  perpsValue,
  openPnl,
  busy,
  onClose,
  onCloseAll,
  onWithdraw,
}: {
  connected: boolean;
  onConnect: () => void;
  rows: PositionRow[];
  history: PerpHistoryRow[];
  historyLoading: boolean;
  tab: "positions" | "history" | "account";
  onTab: (t: "positions" | "history" | "account") => void;
  now: AccountNumbers | null;
  room: LiqRoom | null;
  available: number;
  phoenixUsdc: number;
  withdrawableNow: number;
  perpsValue: number;
  openPnl: number;
  busy: boolean;
  onClose: (row: PositionRow, pct: number) => Promise<unknown>;
  onCloseAll: () => Promise<unknown>;
  onWithdraw: () => Promise<unknown>;
}) {
  const router = useRouter();
  const [closing, setClosing] = useState<{ row: PositionRow; pct: number } | null>(null);
  const [closingAll, setClosingAll] = useState(false);
  const n = connected ? rows.length : 0;
  const hf = now?.hf ?? Infinity;
  const tabs = [
    ["positions", `Positions (${n})`],
    ["history", "History"],
    ["account", "Account"],
  ] as const;

  return (
    <section className="px-bot">
      <div className="px-btabs">
        <div className="px-bt" role="tablist">
          {tabs.map(([v, l]) => (
            <button key={v} type="button" className={tab === v ? "on" : ""} role="tab" aria-selected={tab === v} onClick={() => onTab(v)}>
              {l}
            </button>
          ))}
        </div>
        {tab === "positions" && connected && n > 0 && (
          <button type="button" className="px-ghost" disabled={busy} onClick={() => setClosingAll(true)}>
            Close all
          </button>
        )}
      </div>

      {!connected ? (
        <div className="px-empty">
          <button type="button" className="px-connect" onClick={onConnect}>
            Connect a wallet
          </button>
        </div>
      ) : tab === "positions" ? (
        rows.length === 0 ? (
          <div className="px-empty">
            <span className="px-mut">No open positions</span>
          </div>
        ) : (
          <>
            <div className="px-tbl-w px-positions-table" role="region" aria-label="Open positions" tabIndex={0}>
              <table className="px-tbl num">
                <thead>
                  <tr>
                    <th>Market</th>
                    <th>Position size</th>
                    <th>Entry</th>
                    <th>Mark</th>
                    <th>
                      <span className="px-th">
                        Liq. price
                        <Info text="The price, moving against the position, at which the whole margin account would be liquidated; None means the rest of the account covers it." />
                      </span>
                    </th>
                    <th>PnL (ROE)</th>
                    <th>
                      <span className="px-th">
                        Equity
                        <Info text="What the position is worth to you now: its share of the Phoenix USDC plus open P&L and funding." />
                      </span>
                    </th>
                    <th className="r">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key}>
                      <td>
                        <span className="px-mk">
                          <Img src={marketIcon(r.key)} className="px-mk-ic" />
                          <span className="px-2l">
                            <b>{r.key}-PERP</b>
                            <small>
                              <SideTag s={r.side} /> · {levFmt(r.leverage)} · <Img src={PHOENIX_ICON} className="px-vn-ic" />
                              Phoenix
                            </small>
                          </span>
                        </span>
                      </td>
                      <td>
                        <span className="px-2l">
                          <span>
                            {tokAmt(r.tokens, r.key)} {r.key}
                          </span>
                          <small>{usd(r.sizeUsd)}</small>
                        </span>
                      </td>
                      <td>${price(r.entry)}</td>
                      <td>${price(r.mark)}</td>
                      <td>
                        <LiqCell row={r} hf={hf} />
                      </td>
                      <td>
                        <span className={`px-2l ${upDn(r.pnl)}`}>
                          <b>{sUsd(r.pnl)}</b>
                          <small>{spct(r.collateral > 0 ? (r.pnl / r.collateral) * 100 : 0)}</small>
                        </span>
                      </td>
                      <td>
                        <span className="px-2l">
                          <span>{usd(r.equity)}</span>
                          <small>{usd(r.collateral)} coll.</small>
                        </span>
                      </td>
                      <td className="r">
                        <button type="button" className="px-close-btn" disabled={busy} onClick={() => setClosing({ row: r, pct: 100 })}>
                          Close
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Narrow bottom panel: one card per position instead of a sideways-scrolling table. */}
            <div className="px-pcards num">
              {rows.map((r) => (
                <div key={r.key} className="px-card">
                  <div className="px-card-h">
                    <Img src={marketIcon(r.key)} className="px-mk-ic" />
                    <b>{r.key}-PERP</b>
                    <SideTag s={r.side} />
                    <span className="px-card-lev">{levFmt(r.leverage)}</span>
                    <button type="button" className="px-close-btn px-card-close" disabled={busy} onClick={() => setClosing({ row: r, pct: 100 })}>
                      Close
                    </button>
                  </div>
                  <div className="px-card-g">
                    <Cell k="Size">
                      {tokAmt(r.tokens, r.key)} {r.key}
                    </Cell>
                    <Cell k="Entry">${price(r.entry)}</Cell>
                    <Cell k="Mark">${price(r.mark)}</Cell>
                    <Cell k="Liq. price">
                      <LiqCell row={r} hf={hf} />
                    </Cell>
                    <Cell k="PnL (ROE)">
                      <span className={upDn(r.pnl)}>
                        {sUsd(r.pnl)} ({spct(r.collateral > 0 ? (r.pnl / r.collateral) * 100 : 0)})
                      </span>
                    </Cell>
                    <Cell k="Equity">{usd(r.equity)}</Cell>
                  </div>
                </div>
              ))}
            </div>
          </>
        )
      ) : tab === "history" ? (
        <HistoryTable rows={history} loading={historyLoading} />
      ) : (
        <div className="px-acc num">
          <div className="px-acc-b">
            <div className="px-acc-t">
              <Img src={VANNA_ICON} className="px-od-ic" />
              Vanna margin account
            </div>
            <Kv k="Health factor" tip="How safe the whole margin account is: holdings ÷ debt. It can be liquidated at 1.10 or below." cls={hfZone(hf)}>
              {hfFmt(now ? now.hf : Infinity)}
            </Kv>
            <Kv k="Account leverage" tip="Everything the account holds (borrowed funds included, open perps at their full size) divided by your own money (equity). 1.00x means no borrowing.">
              {levFmt(now ? now.leverage : 0)}
            </Kv>
            <Kv k="Total collateral" tip="Everything the margin account holds, including the Phoenix account, at the oracle prices.">
              {usd(now ? now.holdings : 0)}
            </Kv>
            <Kv k="Total debt" tip="Everything the margin account has borrowed, at today's prices.">
              {usd(now ? now.debt : 0)}
            </Kv>
            <Kv k="Margin USDC available" tip="Idle USDC in your margin account that orders can use.">
              {nf(available, 2)} USDC
            </Kv>
            <Kv k="Room before liquidation" tip="The smallest single price move that liquidates the account, every other price unchanged." cls={room ? roomZone(room) : ""} sub={room ? roomSub(room) : undefined}>
              {room ? roomText(room) : "None"}
            </Kv>
            <button type="button" className="px-lnk" onClick={() => router.push("/margin")}>
              Deposit / Borrow USDC on the Margin page
              <Go />
            </button>
          </div>
          <div className="px-acc-b">
            <div className="px-acc-t">
              <Img src={PHOENIX_ICON} className="px-od-ic" />
              Phoenix
              <Info text="Your perps collateral sits in Phoenix as phUSD, shared across all Phoenix markets (cross margin)." />
            </div>
            <Kv k="Perps value (Phoenix)" tip="What your Phoenix account counts for in the health factor: its USDC plus every position's equity at the index price.">
              {usd(perpsValue)}
            </Kv>
            <Kv k="USDC in Phoenix" tip="The phUSD collateral in your Phoenix account; it backs every open position.">
              {nf(phoenixUsdc, 2)} USDC
            </Kv>
            <Kv k="Unrealized PnL" cls={upDn(openPnl)}>
              {sUsd(openPnl)}
            </Kv>
            <Kv k="Open positions">{String(rows.length)}</Kv>
            {/* With positions open the USDC backs them (closing the last one sends it home). */}
            {phoenixUsdc > 0.01 && rows.length === 0 && (
              <button type="button" className="px-lnk" disabled={busy || withdrawableNow <= 0} onClick={() => void onWithdraw()}>
                Withdraw USDC to margin
                <Go />
              </button>
            )}
          </div>
        </div>
      )}

      {closing && (
        <CloseModal
          ctx={closing}
          onPct={(pct) => setClosing({ ...closing, pct })}
          onlyPosition={rows.length === 1}
          phoenixUsdc={phoenixUsdc}
          busy={busy}
          onCancel={() => setClosing(null)}
          onConfirm={async () => {
            const c = closing;
            setClosing(null);
            await onClose(c.row, c.pct).catch(() => undefined);
          }}
        />
      )}
      {closingAll && (
        <Modal title="Close all positions" onClose={() => setClosingAll(false)}>
          <CloseAllBody
            rows={rows}
            phoenixUsdc={phoenixUsdc}
            busy={busy}
            onCancel={() => setClosingAll(false)}
            onConfirm={async () => {
              setClosingAll(false);
              await onCloseAll().catch(() => undefined);
            }}
          />
        </Modal>
      )}
    </section>
  );
}

const Cell = ({ k, children }: { k: string; children: React.ReactNode }) => (
  <div>
    <span>{k}</span>
    <b>{children}</b>
  </div>
);

function Kv({ k, tip, cls, sub, children }: { k: string; tip?: string; cls?: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="px-kv">
      <span>
        {k}
        {tip && <Info text={tip} />}
      </span>
      <span className={cls ?? ""}>
        {children}
        {sub && <small>{sub}</small>}
      </span>
    </div>
  );
}

const ACTION_LABEL: Record<PerpHistoryRow["action"], string> = {
  open: "Open / increase",
  close: "Close / reduce",
  cancel: "Cancel order",
  settle: "Withdraw to margin",
  setup: "Account setup",
  deposit: "Deposit to Phoenix",
  nofill: "Order not filled",
};

function HistoryTable({ rows, loading }: { rows: PerpHistoryRow[]; loading: boolean }) {
  if (rows.length === 0)
    return (
      <div className="px-empty">
        {loading ? <VannaLoader caption="Loading your Phoenix history" /> : <span className="px-mut">No perps activity yet</span>}
      </div>
    );
  const t = (unix: number) =>
    unix ? new Date(unix * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "N/A";
  const size = (h: PerpHistoryRow) => usd(h.sizeUsd ?? 0);
  const usdc = (h: PerpHistoryRow) => `${nf(h.usdc ?? 0, 2)} USDC`;
  const label = (h: PerpHistoryRow) => (
    <b className={h.action === "nofill" ? "px-mut" : ""} title={h.action === "nofill" ? "Nothing on the book inside your price limit — the USDC stayed in Phoenix" : undefined}>
      {ACTION_LABEL[h.action]}
    </b>
  );
  const tx = (h: PerpHistoryRow) => (
    <a className="px-tx" href={explorerUrl("tx", h.signature)} target="_blank" rel="noopener noreferrer">
      {h.signature.slice(0, 8)}…
    </a>
  );
  return (
    <>
      <div className="px-tbl-w">
        <table className="px-tbl hist num">
          <thead>
            <tr>
              <th>Time</th>
              <th>Action</th>
              <th>Market</th>
              <th>Side</th>
              <th>Size</th>
              <th>USDC</th>
              <th className="r tx">Tx</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((h, i) => (
              <tr key={`${h.signature}-${i}`}>
                <td>{t(h.timestamp)}</td>
                <td>{label(h)}</td>
                <td>{h.market ? `${h.market}-PERP` : "N/A"}</td>
                <td>{h.side ? <SideTag s={h.side} /> : "N/A"}</td>
                <td>{size(h)}</td>
                <td>{usdc(h)}</td>
                <td className="r tx">{tx(h)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="px-cards hist num">
        {rows.map((h, i) => (
          <div key={`${h.signature}-${i}`} className="px-card">
            <div className="px-card-h">
              {label(h)}
              {h.market && <span className="px-card-lev">{h.market}-PERP</span>}
              {h.side && <SideTag s={h.side} />}
              <span className="px-card-t">{t(h.timestamp)}</span>
            </div>
            {(h.sizeUsd != null || h.usdc != null) && (
              <div className="px-card-g">
                <Cell k="Size">{size(h)}</Cell>
                <Cell k="USDC">{usdc(h)}</Cell>
              </div>
            )}
            <div>{tx(h)}</div>
          </div>
        ))}
      </div>
    </>
  );
}

const CmRow = ({ k, tip, children }: { k: string; tip?: string; children: React.ReactNode }) => (
  <div className="px-cm-r">
    <span>
      {k}
      {tip && <Info text={tip} />}
    </span>
    <b>{children}</b>
  </div>
);

function closeNums(r: PositionRow, f: number) {
  const fee = f * r.tokens * r.mark * r.takerFee;
  return { fee, pnl: f * r.pnl - fee, back: f * (r.collateral + r.pnl + r.fundingUsd) - fee };
}

function CloseModal({
  ctx,
  onPct,
  onlyPosition,
  phoenixUsdc,
  busy,
  onCancel,
  onConfirm,
}: {
  ctx: { row: PositionRow; pct: number };
  onPct: (pct: number) => void;
  onlyPosition: boolean;
  phoenixUsdc: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const r = ctx.row;
  const f = ctx.pct / 100;
  const full = ctx.pct >= 100;
  const c = closeNums(r, f);
  // Closing the last position sends the whole Phoenix balance home; otherwise the USDC stays in Phoenix.
  const homeward = full && onlyPosition;
  const back = homeward ? phoenixUsdc + r.pnl + r.fundingUsd - c.fee : c.back;
  return (
    <Modal title="Close position" onClose={onCancel}>
      <div className="px-cm num">
        <div className="px-cm-h">
          <b>{r.key}-PERP</b>
          <span className={`px-side-chip ${r.side}`}>
            Close {sideTxt(r.side)} {levFmt(r.leverage)}
          </span>
        </div>
        <CmRow k="Mark price">${price(r.mark)}</CmRow>
        <CmRow k="Entry price">${price(r.entry)}</CmRow>
        <CmRow k="Position size">{usd(r.sizeUsd)}</CmRow>
        <CmRow k="Equity">{usd(r.equity)}</CmRow>
        <div className="px-cm-box">
          <span>Close size</span>
          <b>
            {usd(f * r.sizeUsd)} <small>({ctx.pct}%)</small>
          </b>
        </div>
        <Slider id="closepct" value={ctx.pct} min={0} max={100} step={1} marks={[0, 25, 50, 75, 100]} label={(v) => `${v}%`} aria="Close, % of position" onChange={onPct} />
        <CmRow k={`Fee (${nf(r.takerFee * 100, 3)}%)`} tip="Phoenix's taker fee for closing this size, taken from what you get back.">
          {usd(c.fee)}
        </CmRow>
        <CmRow k="Realized PnL (est.)" tip="P&L of the closed part at the mark price, after the closing fee.">
          <span className={upDn(c.pnl)}>{sUsd(c.pnl)}</span>
        </CmRow>
        <CmRow k={homeward ? "Back to margin account" : "Stays in Phoenix"}>~{nf(Math.max(0, back), 2)} USDC</CmRow>
        <p className="px-cm-n">
          Closes at the market price on Phoenix (reduce-only; retried once with a wider limit if the book is thin). Closing your last position sends the USDC back to your
          margin account; otherwise it stays in Phoenix until you withdraw it.
        </p>
        <div className="px-cm-b">
          <button type="button" className="px-btn-o" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="px-btn-p" disabled={ctx.pct <= 0 || busy} onClick={onConfirm}>
            {full ? "Close position" : `Close ${ctx.pct}%`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function CloseAllBody({ rows, phoenixUsdc, busy, onCancel, onConfirm }: { rows: PositionRow[]; phoenixUsdc: number; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const fee = rows.reduce((t, r) => t + closeNums(r, 1).fee, 0);
  const back = phoenixUsdc + rows.reduce((t, r) => t + r.pnl + r.fundingUsd, 0) - fee;
  return (
    <div className="px-cm num">
      <p className="px-cm-p">
        All {rows.length} position{rows.length === 1 ? "" : "s"} close at the market price on Phoenix, one transaction each. Then everything goes back to your margin account.
      </p>
      <CmRow k={`Fees`} tip="Phoenix's taker fees for closing every position, taken from what you get back.">
        {usd(fee)}
      </CmRow>
      <CmRow k="Back to margin account">~{nf(Math.max(0, back), 2)} USDC</CmRow>
      <div className="px-cm-b">
        <button type="button" className="px-btn-o" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="px-btn-p" disabled={busy} onClick={onConfirm}>
          Close all
        </button>
      </div>
    </div>
  );
}
