"use client";

/**
 * The Predict events of an answer (`answer.list` kind `predict_markets`), drawn from the website's own list: the same
 * `/api/predict/events` request (same `cat` / `q`) and query cache the Predict page uses, so the Copilot can never show
 * fewer events, other outcomes or other prices than the page. Nothing here comes from the model's wording.
 *
 * Each card follows the Predict page's card (`predict-list.tsx` `Card`): a game shows its teams, the draw and each
 * one's YES price; a single question its chance and YES / NO prices; a multi-outcome question its two likeliest
 * outcomes and "+N more". Every card opens the event on the Predict page.
 */

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { usePredictEvents } from "@/hooks/use-predict";
import { byChance, canTrade, isDraw, mainOuts, predictHref } from "@/lib/predict/view";
import type { PredictEvent, PredictOutcome } from "@/lib/predict/types";
import { cf, cpair, partyCol, pc } from "@/components/predict/ui";
import { usdC } from "@/components/v3/format";
import type { AnswerList } from "@/lib/copilot/answer-schema";

const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
/** The Predict page's badge colours (predict-v3.css `--pd-ava` / `--pd-accent`). */
const BADGE = { bg: "#eae2fb", fg: "#6635d1" };

/** The page's list order: "Trending" (tradable first, then 24h volume) when no category is picked. */
function ordered(events: PredictEvent[], list: AnswerList): PredictEvent[] {
  const out = events.slice();
  if (!list.category) out.sort((a, b) => Number(b.outs.some((o) => o.tradable)) - Number(a.outs.some((o) => o.tradable)) || b.v24 - a.v24);
  return out;
}

function Disc({ src, text, bg, fg, size }: { src?: string | null; text: string; bg: string; fg: string; size: number }) {
  const style: CSSProperties = { width: size, height: size, borderRadius: 999, flex: "none", display: "grid", placeItems: "center", overflow: "hidden" };
  if (src)
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" width={size} height={size} draggable={false} style={{ ...style, objectFit: "cover" }} />;
  return (
    <span aria-hidden style={{ ...style, background: bg, color: fg, fontSize: text.length > 2 ? size * 0.3 : size * 0.42, fontWeight: 800, lineHeight: 1 }}>
      {text}
    </span>
  );
}

const teamArt = (o: PredictOutcome) => (o.image && !/\/img\//.test(o.image) ? o.image : null);

/** The event's logo as the page draws it (`EvLogo`): both teams of a game, else the artwork or the short code. */
function EventLogo({ e }: { e: PredictEvent }) {
  const teams = mainOuts(e).filter((o) => !isDraw(o));
  if (e.type === "match" && teams.length === 2)
    return (
      <span style={{ position: "relative", width: 40, height: 34, flex: "none" }}>
        {teams.map((o, i) => (
          <span key={o.k} style={{ position: "absolute", left: i ? 14 : 0, top: i ? 8 : 0, borderRadius: 999, boxShadow: "0 0 0 2px var(--cp-surface, #fff)" }}>
            <Disc src={teamArt(o)} text={o.name.slice(0, 1).toUpperCase()} bg={partyCol(e, o)} fg="#fff" size={26} />
          </span>
        ))}
      </span>
    );
  return <Disc src={e.image} text={e.ic} bg={BADGE.bg} fg={BADGE.fg} size={34} />;
}

function Price({ children, tone }: { children: ReactNode; tone: "yes" | "no" | "plain" }) {
  const color = tone === "yes" ? "var(--cp-ok-fg)" : tone === "no" ? "var(--cp-danger-fg)" : "var(--cp-g900)";
  const bg = tone === "yes" ? "var(--cp-ok-bg)" : tone === "no" ? "var(--cp-danger-bg)" : "var(--cp-g50)";
  return (
    <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 600, color, background: bg, borderRadius: 6, padding: "2px 7px", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
      {children}
    </span>
  );
}

const row: CSSProperties = { display: "flex", alignItems: "center", gap: 8, minWidth: 0 };
const nameStyle: CSSProperties = { flex: 1, minWidth: 0, fontSize: 14, color: "var(--cp-g900)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

function YesNo({ o, yesLabel = "Yes", noLabel = "No" }: { o: PredictOutcome; yesLabel?: string; noLabel?: string }) {
  const [y, n] = canTrade(o) ? cpair(o.y, o.n) : ["No price", "No price"];
  return (
    <>
      <Price tone="yes">
        {yesLabel} {y}
      </Price>
      <Price tone="no">
        {noLabel} {n}
      </Price>
    </>
  );
}

function EventCard({ e }: { e: PredictEvent }) {
  const ps = mainOuts(e);
  const teams = ps.filter((o) => !isDraw(o));
  let body: ReactNode;
  let more = 0;
  if (e.type === "match" && teams.length === 2) {
    const [a, b] = teams;
    const dr = ps.find(isDraw);
    body = [a, ...(dr ? [dr] : []), b].map((o) => (
      <div key={o.k} style={row}>
        <Disc src={isDraw(o) ? null : teamArt(o)} text={isDraw(o) ? "=" : o.name.slice(0, 1).toUpperCase()} bg={partyCol(e, o)} fg="#fff" size={18} />
        <span style={nameStyle}>{isDraw(o) ? "Draw" : o.name}</span>
        <span style={{ fontFamily: MONO, fontSize: 12, color: "var(--cp-g500)" }}>{pc(o.y)}</span>
        <Price tone="yes">Yes {canTrade(o) ? cf(o.y) : cf(null)}</Price>
      </div>
    ));
  } else if (e.outs.length === 1) {
    const o = e.outs[0]!;
    body = (
      <div style={row}>
        <span style={{ ...nameStyle, fontFamily: MONO, fontWeight: 700 }}>
          {pc(o.y)} <span style={{ fontFamily: "inherit", fontWeight: 400, color: "var(--cp-g500)" }}>{o.yl ?? "chance"}</span>
        </span>
        <YesNo o={o} />
      </div>
    );
  } else {
    const rows = e.outs.slice().sort(byChance);
    more = rows.length - 2;
    body = rows.slice(0, 2).map((o) => (
      <div key={o.k} style={row}>
        <span style={nameStyle}>{o.name}</span>
        <span style={{ fontFamily: MONO, fontSize: 12, color: "var(--cp-g500)" }}>{pc(o.y)}</span>
        <YesNo o={o} />
      </div>
    ));
  }
  return (
    <Link
      href={predictHref(e.id)}
      style={{ display: "block", textDecoration: "none", border: "1px solid var(--cp-g100)", background: "var(--cp-g50)", borderRadius: 10, padding: "10px 12px" }}
    >
      <div style={{ ...row, gap: 10, marginBottom: 8 }}>
        <EventLogo e={e} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--cp-g400)" }}>
            {e.tag}
            {e.live ? " · Live" : ""}
          </div>
          <div style={{ fontSize: 15, fontWeight: 600, color: "var(--cp-g900)", overflowWrap: "anywhere" }}>{e.title}</div>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{body}</div>
      <div style={{ ...row, justifyContent: "space-between", marginTop: 8, fontFamily: MONO, fontSize: 11, color: "var(--cp-g400)", flexWrap: "wrap" }}>
        <span>{e.last ? `Last trade ${e.last}` : "No trades yet"}</span>
        <span style={{ display: "flex", gap: 10 }}>
          {more > 0 && <span>+{more} more</span>}
          <span>Vol {usdC(e.vol)}</span>
          {(e.type === "binary" || e.type === "updown") && <span>OI {usdC(e.oi)}</span>}
        </span>
      </div>
    </Link>
  );
}

export function PredictEventsList({ list }: { list: AnswerList }) {
  const { data, isLoading } = usePredictEvents({ cat: list.category, q: list.query });
  if (isLoading)
    return (
      <p className="m-0 mt-4" style={{ fontFamily: MONO, fontSize: 12, color: "var(--cp-g400)" }}>
        Loading Predict events…
      </p>
    );
  const events = ordered(data ?? [], list);
  if (!events.length) return null;
  return (
    <div className="mt-4">
      <p className="m-0 mb-2" style={{ fontFamily: MONO, fontSize: 12, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--cp-g400)" }}>
        {events.length} event{events.length === 1 ? "" : "s"}
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 10 }}>
        {events.map((e) => (
          <EventCard key={e.id} e={e} />
        ))}
      </div>
    </div>
  );
}
