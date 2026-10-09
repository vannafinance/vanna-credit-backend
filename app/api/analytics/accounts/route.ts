import type { NextRequest } from "next/server";
import { jsonResponse } from "@/lib/solana/server/json";
import { cachedRow, decorate, readSnapshot } from "@/lib/analytics/server/store";
import { inBand, matchesFilter, searchRows, sortRows } from "@/lib/analytics/risk";
import type { AccountFilter, AccountSortKey } from "@/lib/analytics/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FILTERS: AccountFilter[] = ["all", "liquidatable", "atrisk", "healthy", "nodebt", "incomplete", "withdebt"];
const SORTS: AccountSortKey[] = ["health", "debt", "collateral", "equity", "leverage", "buffer", "status"];
const MAX_PER_PAGE = 100;

/**
 * GET /api/analytics/accounts?filter=&sort=&dir=&q=&page=&per=
 * Server-side filter, sort, search and paging, so the browser only ever receives one page
 * (the account list can grow to thousands). Counts per filter are over all accounts.
 */
export async function GET(request: NextRequest) {
  const p = request.nextUrl.searchParams;
  const filter = (FILTERS as string[]).includes(p.get("filter") ?? "") ? (p.get("filter") as AccountFilter) : "all";
  const sort = (SORTS as string[]).includes(p.get("sort") ?? "") ? (p.get("sort") as AccountSortKey) : "health";
  const dir: 1 | -1 = p.get("dir") === "desc" ? -1 : 1;
  const per = Math.min(MAX_PER_PAGE, Math.max(1, Number(p.get("per")) || 10));
  const { snapshot, state } = readSnapshot();
  if (!snapshot) return jsonResponse({ state, asOf: null, rows: [], total: 0, filteredTotal: 0, page: 1, per, pages: 1, filterCounts: null });

  const band = p.get("band");
  const searched = searchRows(band ? snapshot.rows.filter((r) => inBand(r, band)) : snapshot.rows, p.get("q") ?? "");
  const filtered = sortRows(searched.filter((r) => matchesFilter(r, filter)), sort, dir);
  const pages = Math.max(1, Math.ceil(filtered.length / per));
  const page = Math.min(pages, Math.max(1, Number(p.get("page")) || 1));
  // The connected wallet's own row is pinned by the UI; send it (and its true rank) separately.
  const youOwner = p.get("you");
  const youRow = youOwner ? cachedRow(youOwner) : null;
  const youRank = youRow ? filtered.findIndex((r) => r.owner === youRow.owner) : -1;
  return jsonResponse({
    state,
    asOf: snapshot.asOf,
    forkTime: snapshot.forkTime,
    rows: filtered.slice((page - 1) * per, page * per).map(decorate),
    you: youRow ? { row: decorate(youRow), rank: youRank >= 0 ? youRank + 1 : null } : null,
    total: snapshot.rows.length,
    filteredTotal: filtered.length,
    page, per, pages,
    filterCounts: Object.fromEntries(FILTERS.map((f) => [f, searched.filter((r) => matchesFilter(r, f)).length])),
  });
}
