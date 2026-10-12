"use client";

/**
 * Analytics frame: sidebar navigation, live status bar and the shared tooltip layer. The site's own
 * header (with its light/dark switch and wallet) stays above; theme follows it through `html.dark`.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useAnalyticsSummary } from "@/hooks/use-analytics";
import { clock, finite } from "@/lib/analytics/format";
import { Icon } from "./ui";
import { TooltipHost } from "./tooltip-host";

export const SECTIONS: Array<{ group: string; items: Array<{ href: string; label: string; icon: string; title: string; blurb: string }> }> = [
  { group: "Risk", items: [
    { href: "/analytics", label: "Overview", icon: "overview", title: "Overview", blurb: "" },
    { href: "/analytics/positions", label: "Positions", icon: "health", title: "Positions", blurb: "" },
    { href: "/analytics/liquidations", label: "Liquidations", icon: "liquidations", title: "Liquidations", blurb: "" },
    { href: "/analytics/top-accounts", label: "Top accounts", icon: "accounts", title: "Top accounts", blurb: "" },
    { href: "/analytics/alerts", label: "Alerts", icon: "alerts", title: "Alerts", blurb: "" },
  ] },
  { group: "Markets", items: [
    { href: "/analytics/pools", label: "Lending Pools", icon: "pools", title: "Lending Pools", blurb: "" },
    { href: "/analytics/collateral", label: "Collateral", icon: "collateral", title: "Collateral", blurb: "" },
    { href: "/analytics/prices", label: "Prices", icon: "prices", title: "Prices", blurb: "" },
  ] },
  { group: "Tools", items: [
    { href: "/analytics/what-if", label: "What-if Calculator", icon: "calculator", title: "What-if Calculator", blurb: "" },
  ] },
];

export function AnalyticsShell({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const pathname = usePathname();

  // Every section opens at its top, not wherever the previous one was scrolled to.
  useEffect(() => { window.scrollTo({ top: 0, left: 0, behavior: "instant" }); }, [pathname]);

  // Keep the sidebar just below the site's sticky header, whatever its height is at this screen size.
  useEffect(() => {
    const place = () => {
      const header = document.elementsFromPoint(window.innerWidth / 2, 2).find((el) => !root.current?.contains(el) && ["sticky", "fixed"].includes(getComputedStyle(el).position));
      const bottom = header ? Math.ceil(header.getBoundingClientRect().bottom) : 80;
      root.current?.style.setProperty("--an-top", `${bottom + 16}px`);
    };
    place();
    window.addEventListener("resize", place);
    const t = window.setTimeout(place, 600); // header content (wallet, fonts) can change its height just after load
    return () => { window.removeEventListener("resize", place); window.clearTimeout(t); };
  }, []);

  return (
    <div className="an-root" ref={root}>
      <div className="an-page">
        <aside className="an-sidebar" aria-label="Analytics">
          <div className="an-sidebar-caption">PROTOCOL ANALYTICS</div>
          <nav aria-label="Analytics sections">
            {SECTIONS.map((g) => (
              <div key={g.group}>
                <div className="an-nav-group-label">{g.group}</div>
                {g.items.map((it) => (
                  <Link key={it.href} href={it.href} className="an-nav-link" aria-current={pathname === it.href ? "page" : undefined}>
                    <Icon name={it.icon} />{it.label}
                  </Link>
                ))}
              </div>
            ))}
          </nav>
        </aside>
        <main className="an-content" id="analytics-main">
          <StatusBar />
          {children}
        </main>
      </div>
      <TooltipHost rootRef={root} />
    </div>
  );
}

function StatusBar() {
  const { data, isError, isFetching } = useAnalyticsSummary();
  const qc = useQueryClient();
  // Background polling is silent: only a click on Refresh shows a busy state.
  const [clicked, setClicked] = useState(false);
  const busy = clicked && isFetching;
  const cov = data?.coverage;
  const state = data?.state;
  const warming = !data || state?.status === "warming";
  const scanning = !!cov && !cov.complete;
  const text = isError ? "Couldn't reach the analytics service."
    : warming ? "Starting up - looking for accounts…"
    : scanning ? `Scanning recent activity · ${cov!.accountsFound} accounts found so far`
    : cov ? `${cov.accountsFound} accounts found · ${cov.olderActivityExists === false ? "all program activity" : `last ${cov.transactionsScanned.toLocaleString("en-US")} transactions`}${cov.oldestScannedTime ? ` since ${new Date(cov.oldestScannedTime * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}${cov.olderActivityExists ? " · older activity not covered" : ""}` : "";
  const dot = isError || state?.status === "error" ? "an-bad" : warming || scanning ? "an-warn an-pulse" : "";
  return (
    <div className="an-statusbar" role="status" aria-live="polite">
      <span className="an-live"><span className={`an-dot ${dot}`} />{isError ? "Offline" : "Live"} · Test network</span>
      <span className="an-sep" />
      <span className="an-txt">{text}</span>
      <span className="an-meta">{finite(data?.asOf) ? `Updated ${clock(data!.asOf)}` : "Loading…"}</span>
      <button type="button" className="an-btn an-sm" disabled={busy} onClick={() => { setClicked(true); void qc.invalidateQueries({ queryKey: ["analytics"] }); }}>{busy ? "Refreshing…" : "Refresh"}</button>
    </div>
  );
}

export function ViewHead({ title, blurb }: { title: string; blurb: string }) {
  return (
    <div className="an-view-head">
      <h1>{title}</h1>
      <p>{blurb}</p>
    </div>
  );
}
