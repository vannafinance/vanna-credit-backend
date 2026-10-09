"use client";

/** Alerts: derived live from the same data as the rest of the page. Nothing is stored or sent. */
import { useState } from "react";
import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { useAnalyticsProtocol, useAnalyticsSummary, useMyAccount } from "@/hooks/use-analytics";
import { deriveAlerts, type Priority } from "@/lib/analytics/alerts";
import { Badge, Empty, Kpi, Notice } from "../ui";
import { ViewHead } from "../shell";

const PRIORITIES: Array<[Priority, string, string]> = [["P0", "Act now", "danger"], ["P1", "Critical", "danger"], ["P2", "Warning", "warn"], ["P3", "For information", "neutral"]];

export function AlertsView() {
  const wallet = useWallet();
  const { data: sum, isError } = useAnalyticsSummary();
  const { data: protocol } = useAnalyticsProtocol();
  const { data: mine } = useMyAccount(wallet.publicKey?.toBase58() ?? null);
  const [filter, setFilter] = useState<"all" | Priority>("all");
  const ready = !!sum?.summary && !!protocol;
  const alerts = deriveAlerts({ summary: sum?.summary ?? null, protocol, you: mine ?? null, coverage: sum?.coverage ?? null, serviceError: isError });
  const shown = alerts.filter((a) => filter === "all" || a.priority === filter);
  const count = (p: Priority) => alerts.filter((a) => a.priority === p).length;
  return (
    <>
      <ViewHead title="Alerts" blurb="What needs attention right now, worked out live from the data on these pages." />
      <div className="an-kpi-grid">
        {PRIORITIES.map(([p, label, tone]) => <Kpi key={p} label={`${p} · ${label}`} value={ready ? String(count(p)) : "—"} na={!ready} tone={ready && count(p) ? (tone as "danger" | "warn") : ""} sub={count(p) === 1 ? "1 alert" : `${count(p)} alerts`} />)}
      </div>
      <div className="an-seg" role="group" aria-label="Priority filter" style={{ justifySelf: "start" }}>
        {(["all", "P0", "P1", "P2", "P3"] as const).map((k) => <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)}>{k === "all" ? "All" : k}</button>)}
      </div>
      {!ready ? <Empty title="Loading…" text="Reading the latest data." icon="activity" />
        : shown.length === 0 ? <Empty title="Nothing needs attention" text="No alert is firing for the current data." icon="check" />
        : <div className="an-panel an-flush"><div className="an-feed">{shown.map((a) => (
          <div className="an-feed-item" key={a.id}>
            <div className={`an-feed-icon an-${a.priority === "P3" ? "accent" : a.priority === "P2" ? "warn" : "danger"}`}>{a.priority}</div>
            <div className="an-feed-main"><b>{a.title}{a.yours && <span className="an-you-pill">YOU</span>}</b><p>{a.detail}</p></div>
            <div className="an-feed-meta"><Badge tone={a.priority === "P3" ? "neutral" : a.priority === "P2" ? "warn" : "danger"}>{a.metric}</Badge>{a.link && <><br /><Link href={a.link} style={{ color: "var(--accent)", fontWeight: 600 }}>View →</Link></>}</div>
          </div>
        ))}</div></div>}
      <Notice>Alerts are worked out each time the page refreshes. They are not stored, and no notifications are sent anywhere.</Notice>
    </>
  );
}
