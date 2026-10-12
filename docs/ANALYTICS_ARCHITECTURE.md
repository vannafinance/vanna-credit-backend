# Risk Analytics - architecture

Route: `/analytics/*` (nav item sits before Copilot). Read-only. Every figure is read from the fork's
on-chain accounts or computed from those reads; what cannot be read is `null` with a reason - never
zero, never a reference/fallback price, never sample data. (See `AGENTS.md` in the workspace root.)

## Collateral model (depends on the deployed program version!)

The current program does **not** register collateral per token in the margin account. Health is computed
from every token in `ProtocolConfig.allowed_tokens` that the account's vault holds, plus the account's
active **venues** (`MarginAccount.venue_asset_indexes`, e.g. Phoenix). Debt is still per account
(`debt_asset_indexes`). `lib/analytics/server/accounts.ts` follows this model.

**The IDL (`idl/vanna_credit_layer.json`) must match the deployed program.** An older IDL decodes the
venue list as a collateral list and makes healthy accounts look liquidatable - this happened once when the
program was upgraded and the IDL was stale. After any program upgrade: update the IDL, then run
`npx tsx scripts/analytics-parity.ts 6 <a wallet with collateral>` (it compares this reader with the site's
own `fetchMarginSnapshot`; it must print `parity OK`).

Vault balances are read as 8-byte slices; which vaults exist per account is remembered (and persisted), with a
full re-probe every 15 minutes, so a refresh does not scan every account × every allowed token.

## The rule that drives the design: never scan on a request

Finding "all accounts" is the slow part. `getProgramAccounts` is not usable on the hosted fork (it is
forwarded to the upstream mainnet RPC and returns 429, and the accounts only exist on the fork anyway),
so accounts are found from the program's own transactions and then **verified** on-chain.

| Concern | What we do |
| --- | --- |
| Account discovery | `lib/analytics/server/registry.ts`. Walks program signatures backwards in bounded ticks (`ANALYTICS_TICK_BUDGET`, default 120 tx/tick) up to a look-back window (`ANALYTICS_MAX_SIGNATURES`, default 5000). Later ticks only fetch signatures newer than the newest seen (`until`). Each transaction is fetched once; each candidate key is verified once (owner = Vanna program, `MarginAccount` discriminator, PDA matches its authority); negative results are remembered. |
| Honest coverage | `Coverage` is returned with every summary: accounts found, transactions scanned/pending, oldest scanned time, `complete`. The UI says "found in recent activity", never "all accounts". |
| Reading accounts | `lib/analytics/server/accounts.ts`. Shared state (asset configs, pools, oracle accounts, fork clock) is read **once** per pass; then 2 batched phases of `getMultipleAccounts` (100/chunk - the fork rejects JSON-RPC batching): margin accounts → vaults/debt positions of **active** indexes only. Same math/rounding as `margin.ts` (collateral rounds down, debt up). Checked against `fetchMarginSnapshot` by `scripts/analytics-parity.ts`. |
| Refreshing | `lib/analytics/server/store.ts`: stale-while-revalidate + single-flight. A request returns the last snapshot in ms and, if it is older than `ANALYTICS_REFRESH_SECONDS` (default 45) or discovery has backlog, kicks a background pass. While there is backlog, passes only read *new* accounts and publish partial results (honest coverage); when idle, all known accounts are re-read in one batch. Browser tabs only poll the server snapshot (15 s; 3 s while warming), so RPC load does not grow with viewers. |
| Paging | `/api/analytics/accounts` filters, sorts, searches and pages **server-side** (max 100 rows/page); the browser never receives the full list. Summary aggregates are computed over all accounts on the server. |
| What-if input | `/api/analytics/scenario-input` - fetched only when the calculator opens; the calculator runs in the browser and writes nothing. |
| Failures | Provider errors are reduced to an error class (RPC messages can embed keyed URLs). A failed pass keeps serving the previous snapshot; failures back off (≥5 s between attempts). |

## Durable scan state (restarts and multiple instances)

`lib/analytics/server/persistence.ts` saves the scan state - account registry, first-seen times, scan
cursors, the queue of transactions not yet inspected, the decoded event ring and the server-measured
health readings - and reloads it before the first scan. The last snapshot of account rows is saved too (with the time it was measured) and shown immediately after a
restart or on a new instance, then replaced by the first fresh read; it is always labelled with its own "updated"
time. Nothing else derived (prices, pool state) is saved - those are re-read from the chain.

| Backend | Chosen when | Notes |
| --- | --- | --- |
| Firestore (REST) | `ANALYTICS_FIRESTORE_PROJECT` set | Shared by every instance; same auth as the Copilot store (`google-auth-library`, no new dependency). Stored as plain JSON in `state_0..n` + `state_meta` (chunks < 1 MiB; meta written last). Last writer wins - safe because the data is derived and re-scannable. |
| Local file | not production, no project set | `/.local/analytics/state.json` (git-ignored), atomic write. |
| Memory only | production without a project | Works, but every cold start rescans (~2.5 min); reported as `persistence.backend = "memory"` in `/api/analytics/summary`. |

A saved state is trusted only if the schema and program id match **and** its newest transaction still
exists on the fork (a fork reset discards it). Saves are throttled (15 s) and only when something changed.
Measured locally: restart → ready with all 192 accounts / 1,499 transactions in ~10 s (was ~150 s).

### Setting up Firestore for the deployed site

Analytics needs its own Firestore in the project the site runs in (it does not share the Copilot's, which lives in another project).
One-time, then it needs no more attention. Region is permanent, so pick the Cloud Run region.

```sh
PROJECT=vanna-credit-solana-test; REGION=us-central1; SERVICE=vanna-credit-solana-test
gcloud firestore databases list --project=$PROJECT            # skip the create if a (default) database already exists
gcloud services enable firestore.googleapis.com --project=$PROJECT
gcloud firestore databases create --project=$PROJECT --database='(default)' --location=$REGION --type=firestore-native
SA=$(gcloud run services describe $SERVICE --region=$REGION --project=$PROJECT --format='value(spec.template.spec.serviceAccountName)')
# empty = the default compute account: $(gcloud projects describe $PROJECT --format='value(projectNumber)')-compute@developer.gserviceaccount.com
gcloud projects add-iam-policy-binding $PROJECT --member="serviceAccount:$SA" --role=roles/datastore.user --condition=None
gcloud run services update $SERVICE --region=$REGION --project=$PROJECT --update-env-vars=ANALYTICS_FIRESTORE_PROJECT=$PROJECT
```

`--update-env-vars` merges (never `--set-env-vars` / `--clear-env-vars`, which would drop the access code and the Copilot settings).
No Firestore security rules are needed: the server reads and writes with its service account. If the store is unreachable the
dashboard keeps working from memory and `/api/analytics/summary` reports `persistence.error`. Saved state is a few documents
(`state_meta`, `state_0..n`) in the `solana_analytics` collection, rewritten at most every 15 s (rows every 2 min).
If the whole state ever exceeds 12 chunks the cached rows are dropped and only the scan state is saved.

Optional env: `ANALYTICS_FIRESTORE_PROJECT`, `ANALYTICS_FIRESTORE_DATABASE` (default `(default)`),
`ANALYTICS_FIRESTORE_COLLECTION` (default `solana_analytics`). The runtime service account needs Firestore
read/write on that project.

Known limits (documented, not hidden):
- Several instances each run their own scan loop and all save to the same document; a dedicated keeper
  (one instance doing the scanning) is the next step for heavy traffic.
- Every full pass is O(N accounts) in `getMultipleAccounts` chunks. Fine for thousands; beyond that,
  tier the refresh (hot accounts - those with debt or low health - more often).
- Accounts that never transacted inside the look-back window are not found.

## Pages and where their data comes from

| Page | Data |
| --- | --- |
| Overview | `/summary` (8 KPIs, health/composition), `/accounts` (server-paged table, YOU row), `/protocol` (pools totals) |
| Positions | wallet lookup (`/accounts/[owner]`), summary distributions + health x leverage heatmap |
| Liquidations | summary, accounts (`filter=liquidatable`, `withdebt`), `/events` (real `Liquidated` events: liquidator, debt, collateral, health) |
| Top accounts | summary concentration, accounts sorted by debt, `/events` feed |
| Alerts | derived live in `lib/analytics/alerts.ts` (own health, prices not updated, pool utilization, liquidations, scan state). Nothing stored; no notification channels |
| Lending Pools / Collateral / Prices | `/protocol` (pools, rate curve calculated with the contract formula, asset configs, price limits) |
| What-if Calculator (last) | `/scenario-input` (saved baseline), engine `lib/analytics/whatif.ts` runs in the browser, read-only |
| Account page `/analytics/accounts/<margin or wallet address>?from=` | `/accounts/[owner]` (the row + where it stands: debt rank, share, closeness to liquidation), `/accounts/[owner]/activity` (its real transactions), `/protocol` (prices for the price slider). Reached from the Overview dropdown ("View full details"), Top accounts, Liquidations, Alerts, Positions lookup and What-if; the breadcrumb follows `?from=` |

Events come from the transactions the registry already inspects (the same `getTransaction` body carries
the logs), so they cost no extra RPC. Coverage is the registry's scan window.

Not provided, on purpose: Current PnL (no cost basis on-chain), an insurance fund (the program has none),
Stellar-style synthetic scenario pages. HF trend is the server's own measurements (one per refresh,
in memory), labelled as such. "First seen" is the earliest scanned transaction, not creation time.

## Account page

`components/analytics/views/account.tsx`. Header (wallet, margin address, status), a banner ("this is your account" only when the connected
wallet owns it), six figures, a price slider, where it ranks, collateral and debt, and **real transactions**.

- The price slider reuses the What-if engine (`simulateAccount`) on this account's own lines, for one asset at a time (assets priced at about
  $1 are not offered). Accounts with a Phoenix lump value, no debt, or not valued show a one-line reason instead.
- Activity comes from `fetchMarginHistory` (the Margin page's own reader: the owner wallet's signatures, each transaction's Anchor events
  decoded), worded by `lib/analytics/activity.ts`, cached 30 s per owner and shared between viewers. It reads at most the wallet's 200 latest
  signatures and says when older ones are not shown. Each row links to the explorer.
- Ranks (`standingOf` in `lib/analytics/risk.ts`) are over the accounts the dashboard has valued.
- `?from=` (validated against a fixed list) only chooses the breadcrumb: Overview > Accounts, Top accounts > Largest borrowers, and so on.

## UI / logic separation

```
lib/analytics/types.ts          API contract (JSON-safe)
lib/analytics/risk.ts           pure: classify, derive, summarize, filter/sort   (+ risk.test.ts)
lib/analytics/pools.ts          pure: pool USD valuation & totals (null unless price fresh and clocks aligned)
lib/analytics/{format,reasons,definitions}.ts   presentation helpers (wording lives here, not in the API)
lib/analytics/server/*          registry, batch reader, snapshot store   (server only)
app/api/analytics/*             thin route handlers: summary, accounts, accounts/[owner], protocol, scenario-input
hooks/use-analytics.ts          the only place the UI fetches
components/analytics/*          presentation only (no fetching, no financial math)
```

## Wording: no jargon

"stale" / "unavailable" are not shown to users. Accounts are valued at the **last on-chain price**, as the
Margin page does: the fork keeper refreshes prices in bursts, and dropping every account whose price is a few
seconds past its allowed age made the whole dashboard empty and refill. The account detail notes which prices
had not been updated (`stalePrices`); the Prices page shows each age; the alert for old prices only fires beyond
3x the allowed age. An account is *not valued* only when a price is missing altogether, or it refers to an
asset the protocol has no configuration for (e.g. asset #13, which is not registered on the fork).

## Theme

Analytics uses the site's V3 tokens (`app/v3.css`) and follows `html.dark` - the same switch as the rest
of the site. There is no separate theme button.

## Env

`ANALYTICS_MAX_SIGNATURES` (5000), `ANALYTICS_TICK_BUDGET` (120), `ANALYTICS_REFRESH_SECONDS` (45),
`ANALYTICS_TX_CONCURRENCY` (3), `ANALYTICS_BACKLOG_PAUSE_MS` (2000) - all optional, defaults in brackets. RPC
comes from the existing `FORK_RPC_URL` / `NEXT_PUBLIC_SOLANA_RPC_URL`.

## Verify

```sh
npx vitest run lib/analytics
npx tsx scripts/analytics-parity.ts 12     # batch reader vs fetchMarginSnapshot, read-only
npx tsc --noEmit
```
