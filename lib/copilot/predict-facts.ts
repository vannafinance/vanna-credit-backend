/**
 * Predict (World.xyz prediction markets, the app's Predict page) read answers, built by code from `vanna_predict`.
 *
 * Every figure is copied from the MCP's result (which copies the app's `/api/predict/*`): prices in cents per share
 * (a share pays 1 CASH if its outcome wins), CASH balances, values and P&L. Nothing is estimated, converted or ranked
 * here, and no outcome is ever called likely: the user reads the market's own prices and picks.
 */

import { fmtUsd, humanizeMcpError } from "./explain";
import type { PredictCategory } from "./intent";
import { mcp } from "./mcp-client";
import type { AnswerFact } from "./answer-schema";
import type { ReadCtx, ReadOutcome } from "./mcp-facts";
import { num } from "./risk";

type Row = Record<string, unknown>;
const rows = (v: unknown): Row[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Row[]) : []);
const fact = (label: string, value: string, tone?: AnswerFact["tone"]): AnswerFact => ({ label, value, ...(tone ? { tone } : {}) });
const cents = (v: unknown) => (num(v) === null ? "—" : `${Number(v).toFixed(1)}¢`);
const cash = (v: unknown) => (num(v) === null ? "—" : `${Number(v).toLocaleString("en-US", { maximumFractionDigits: 6 })} CASH`);
const shares = (v: unknown) => (num(v) === null ? "—" : Number(v).toLocaleString("en-US", { maximumFractionDigits: 6 }));
const usd = (v: unknown) => (num(v) === null ? "—" : fmtUsd(Number(v)));

/** Rows shown in one table: a 32-team championship stays readable; the full list is in `data` for the model. */
const MAX_TABLE_ROWS = 40;

export const PREDICT_NOTE =
  "Prices are cents per share: a share pays 1 CASH (World's dollar) if its outcome wins, nothing if it loses. 'Buy' is what one costs now, 'sell' what one sells for now. Predict uses your wallet's CASH, never the margin account, so it doesn't change your health factor. On a market that joins Vanna's pool, bought shares go into the pool and earn while you hold them, as on the website.";

function unavailable(err: unknown, what: string): ReadOutcome {
  return {
    ok: false,
    fixedWording: true,
    data: {},
    answer: { headline: `I couldn't get ${what} right now, so I have no figure to give you.`, facts: [], note: humanizeMcpError(err).message, venue: "none" },
  };
}

const sideText = (o: Row, side: "yes" | "no") => String(o[`${side}_label`] ?? (side === "yes" ? "Yes" : "No"));

function outcomeRow(event: Row | null, o: Row): string[] {
  const row = [
    String(o.name ?? ""),
    `${sideText(o, "yes")} ${cents(o.yes_buy_cents)} / ${cents(o.yes_sell_cents)}`,
    `${sideText(o, "no")} ${cents(o.no_buy_cents)} / ${cents(o.no_sell_cents)}`,
    o.tradable === true ? (o.joins_vanna_pool === true ? "yes · joins Vanna's pool" : "yes") : "no live price",
  ];
  return event ? [String(event.title ?? ""), ...row] : row;
}

export async function readPredictMarkets(category: PredictCategory | null, query: string | null, ctx: ReadCtx): Promise<ReadOutcome> {
  let raw: Row;
  try {
    raw = await mcp.predictMarkets({ ...(category ? { category } : {}), ...(query ? { query } : {}) }, ctx);
  } catch (err) {
    return unavailable(err, "the Predict markets");
  }
  const events = rows(raw.events);
  const table = events.flatMap((e) => rows(e.outcomes).map((o) => outcomeRow(e, o)));
  const filter = [category, query ? `"${query}"` : null].filter(Boolean).join(", ");
  return {
    ok: true,
    data: { predict_markets: raw },
    answer: {
      headline: events.length
        ? `${events.length} Predict event${events.length === 1 ? "" : "s"} listed${filter ? ` for ${filter}` : ""}.`
        : `No Predict event is listed${filter ? ` for ${filter}` : ""} right now.`,
      facts: [],
      ...(table.length
        ? { tables: [{ caption: table.length > MAX_TABLE_ROWS ? `First ${MAX_TABLE_ROWS} of ${table.length} outcomes` : undefined, columns: ["Event", "Outcome", "YES buy / sell", "NO buy / sell", "Tradable"], rows: table.slice(0, MAX_TABLE_ROWS) }] }
        : {}),
      note: PREDICT_NOTE,
      venue: "predict",
    },
  };
}

export async function readPredictMarket(id: string, ctx: ReadCtx): Promise<ReadOutcome> {
  let raw: Row;
  try {
    raw = await mcp.predictMarket(id, ctx);
  } catch (err) {
    return unavailable(err, "that Predict event");
  }
  const e = (raw.event && typeof raw.event === "object" ? raw.event : {}) as Row;
  const outs = rows(e.outcomes);
  const facts: AnswerFact[] = [];
  if (e.ends) facts.push(fact("Ends", String(e.ends)));
  if (num(e.open_interest_cash) !== null) facts.push(fact("Open interest", cash(e.open_interest_cash)));
  if (num(e.volume_24h_cash) !== null) facts.push(fact("24h volume", cash(e.volume_24h_cash)));
  if (e.last_trade) facts.push(fact("Last trade", String(e.last_trade)));
  if (e.one_outcome_wins === true) facts.push(fact("Outcomes", "exactly one wins"));
  return {
    ok: true,
    data: { predict_market: raw },
    answer: {
      headline: `${String(e.title ?? "This event")}: ${outs.length} outcome${outs.length === 1 ? "" : "s"}.`,
      facts,
      ...(outs.length ? { tables: [{ columns: ["Outcome", "YES buy / sell", "NO buy / sell", "Tradable"], rows: outs.slice(0, MAX_TABLE_ROWS).map((o) => outcomeRow(null, o)) }] } : {}),
      note: typeof e.rules === "string" && e.rules ? `${e.rules} ${PREDICT_NOTE}` : PREDICT_NOTE,
      venue: "predict",
    },
  };
}

export async function readPredictPositions(ctx: ReadCtx): Promise<ReadOutcome> {
  let raw: Row;
  try {
    raw = await mcp.predictPositions(ctx.user.wallet, ctx);
  } catch (err) {
    return unavailable(err, "your Predict positions");
  }
  const wallet = (raw.wallet ?? {}) as Row;
  const summary = (raw.summary ?? {}) as Row;
  const pool = (raw.vanna_pool ?? {}) as Row;
  const positions = rows(raw.positions);
  const movable = rows(raw.can_move_to_pool);
  const pnl = num(summary.pnl_usd);
  const facts: AnswerFact[] = [fact("CASH in your wallet", cash(wallet.cash))];
  if (positions.length) {
    facts.push(fact("Positions value", usd(summary.value_usd)), fact("Cost", usd(summary.cost_usd)));
    facts.push(fact("P&L", usd(summary.pnl_usd), pnl === null ? undefined : pnl >= 0 ? "good" : "warn"));
    facts.push(fact("Pays if every pick wins", cash(summary.payout_if_all_win_cash)));
  }
  if (num(pool.deposited_usd)) facts.push(fact("Vanna pool: lent to Vanna", usd(pool.deposited_usd)), fact("Vanna pool APY", num(pool.apy_pct) === null ? "—" : `${Number(pool.apy_pct).toFixed(2)}%`));
  const tables = [];
  if (positions.length) {
    tables.push({
      columns: ["Event", "Outcome", "Shares (in pool)", "Avg / now", "Value", "P&L", "Pays if it wins"],
      rows: positions.map((p) => [
        String(p.event ?? ""),
        `${String(p.outcome ?? "")} ${String(p.label ?? p.side ?? "").toUpperCase()}`,
        `${shares(p.shares)} (${shares(p.pooled_shares)})`,
        `${cents(p.avg_price_cents)} / ${cents(p.now_price_cents)}`,
        usd(p.value_usd),
        usd(p.pnl_usd),
        cash(p.pays_if_win_cash),
      ]),
    });
  }
  if (movable.length) {
    tables.push({
      caption: "World shares in your wallet that can move into Vanna's pool",
      columns: ["Event", "Outcome", "Shares", "Value"],
      rows: movable.map((x) => [String(x.event ?? ""), `${String(x.label ?? x.outcome ?? "")}`, shares(x.shares), usd(x.value_usd)]),
    });
  }
  return {
    ok: true,
    data: { predict_positions: raw },
    answer: {
      headline: positions.length ? `You hold ${positions.length} Predict position${positions.length === 1 ? "" : "s"}.` : "You hold no Predict positions.",
      facts,
      ...(tables.length ? { tables } : {}),
      note: "Predict positions are in your wallet (or Vanna's pool), not your margin account: they don't count toward your health factor.",
      venue: "predict",
    },
  };
}

export async function readPredictHistory(market: string | null, ctx: ReadCtx): Promise<ReadOutcome> {
  let raw: Row;
  try {
    raw = await mcp.predictHistory(ctx.user.wallet, market, ctx);
  } catch (err) {
    return unavailable(err, "your Predict trades");
  }
  const trades = rows(raw.trades);
  return {
    ok: true,
    data: { predict_history: raw },
    answer: {
      headline: trades.length ? `${trades.length} Predict trade${trades.length === 1 ? "" : "s"}.` : "No Predict trades yet.",
      facts: [],
      ...(trades.length
        ? {
            tables: [{
              columns: ["When", "Market", "Side", "Shares", "CASH", "Price"],
              rows: trades.slice(0, MAX_TABLE_ROWS).map((t) => [String(t.time ?? "—"), String(t.question ?? ""), `${String(t.side ?? "")} ${String(t.outcome ?? "")}`, shares(t.shares), cash(t.cash), cents(t.price_cents)]),
            }],
          }
        : {}),
      venue: "predict",
    },
  };
}

export async function readPredictQuote(legs: Array<{ market: string; outcome: "yes" | "no"; side: "buy" | "sell" | "deposit"; amount: string }>, ctx: ReadCtx): Promise<ReadOutcome> {
  let raw: Row;
  try {
    raw = await mcp.predictQuote(ctx.user.wallet, legs, ctx);
  } catch (err) {
    return unavailable(err, "a quote for that trade");
  }
  const quotes = rows(raw.quotes);
  const warnings = Array.isArray(raw.warnings) ? raw.warnings.map(String) : [];
  return {
    ok: true,
    data: { predict_quote: raw },
    answer: {
      headline: `Quote for ${quotes.length} outcome${quotes.length === 1 ? "" : "s"} at the live price; nothing is built.`,
      facts: [],
      tables: [{
        columns: ["Leg", "Side", "In", "Out", "Price", "Pays if it wins", "Into Vanna's pool"],
        rows: quotes.map((q) => [
          String(q.leg ?? ""),
          `${String(q.side ?? "")} ${String(q.outcome ?? "").toUpperCase()}`,
          q.side === "buy" ? cash(q.cash_in) : shares(q.shares_in),
          q.side === "buy" ? `${shares(q.shares_out)} shares` : q.side === "sell" ? cash(q.cash_out) : "—",
          cents(q.price_cents),
          cash(q.payout_if_win_cash),
          shares(q.shares_into_vanna_pool),
        ]),
      }],
      note: [...warnings, "Prices move: the trade is priced again when it is built for your wallet."].join(" "),
      venue: "predict",
    },
  };
}
