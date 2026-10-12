# Predict: World.xyz integration (phase 1, below the UI)

Predict lists World.xyz prediction markets and trades them on the hosted Surfpool fork
(`https://rpc-devnet.solana.vanna.finance`). Outcome tokens bought on markets the yield pool has
allowlisted go into Vanna's `outcome_yield_pool` in the same wallet approval. The keeper merges
matched YES+NO pairs into USDC and lends it into the USDC reserve of the core lending program
(`H37YVBG3eGtz89ofd7iDLc2PJgn12778392XeU2QJcGC`).

This was ported from Backend-Solana-v2 `lib/world/*`, which already worked on the fork. It reuses
this app's fork connection, send/confirm code, wallet bridge, PDAs, token registry, Jupiter config
and cheatcode helper. The Predict UI (`components/predict/*`, `lib/predict-sample.ts`) still runs on
sample data. The next step is to point it at the hooks below.

## Files

| Path | Role |
|---|---|
| `lib/predict/constants.ts` | Program ids, mints, account layouts (Market, **Group**), discriminators, limits (safe to import in the browser) |
| `lib/predict/types.ts` | Raw World types, the **UI model** (mirrors `lib/predict-sample.ts`), API contract |
| `lib/predict/decode.ts` | Pure decoders: Market, Group, Token-2022 metadata, token amounts |
| `lib/predict/grouping.ts` | Pure **event grouping** + category / question classification |
| `lib/predict/math.ts` | Pure maths: prices from fills, trade sizing, pool share maths (bit-for-bit with the program), formatting |
| `lib/predict/pack.ts` | Packs ordered instruction groups into as few v0 transactions as fit |
| `lib/predict/rpc.server.ts` | Mainnet RPC fallbacks (account reads / program scan / history) |
| `lib/predict/catalog.server.ts` | Mainnet scan of Markets + Groups, mint metadata, World JSON (disk cache), open interest |
| `lib/predict/prices.server.ts` | Prices from mainnet maker fills (JanusFI program, BisonFI treasury) |
| `lib/predict/events.server.ts` | Builds the listed `PredictEvent`s: grouping + prices + live pool balances |
| `lib/predict/keys.server.ts` | Fork maker and pool keeper keypairs (env, else `.cache/`) |
| `lib/predict/maker.server.ts` | Fork maker float + CASH faucet (cheatcodes) |
| `lib/predict/pool.server.ts` | outcome_yield_pool: PDAs, batched state reads, create_pool / deposit / redeem / allow_market builders, keeper merge (heal + retry) |
| `lib/predict/jupiter.server.ts` | CASH⇄USDC routes restricted to Manifest, fork route-account healer |
| `lib/predict/lut.server.ts` | Shared address lookup table, owned by the maker and created once |
| `lib/predict/trade.server.ts` | Builds the trade: legs → instruction groups → packed, maker-signed transactions |
| `lib/predict/positions.server.ts` | Wallet + pooled positions, summary, vault, importable |
| `lib/predict/activity.server.ts` | The wallet's trades, rebuilt from fork transactions |
| `lib/predict/client.ts` | Browser / script fetchers and `executePredictTrade`: sign every transaction with one `signAllTransactions`, send them in order, then merge |
| `hooks/use-predict.ts` | React Query hooks |
| `app/api/predict/**` | API routes (below) |
| `idl/outcome_yield_pool.json` | Pool program IDL (copied from Backend-Solana-v2) |
| `scripts/e2e-predict.ts` | End-to-end test on the hosted fork through the API |
| `scripts/predict-allow-markets.ts` | Admin `allow_market` (+ `create_pool`). **Dry run by default** |
| `lib/predict/*.test.ts` | Unit tests (decode, grouping, math, pack): 44 tests |

## How it works

### Markets and events

- **Discovery (mainnet, read only).** `getProgramAccounts(prediCt…)` runs twice. The first call
  filters on `dataSize 320` and returns the Markets: CASH mint at byte 40, YES at 72, NO at 104,
  vault at 136, resolution kind at 224, window start and end in ms at 258 and 266. The second
  filters on the `Group` discriminator `d1f9d03fb659bafe` (layout in `constants.ts`). The Surfpool
  fork cannot list accounts, so it is not used here.
- **Listed set.** This is every Up/Down window that is open now or opens within the next hour,
  plus every market with at least 1 CASH in its vault. When one member of a Group is listed, all
  its members are listed too, so a match keeps its draw.
- **Metadata.** Names and symbols come from the YES mint's Token-2022 metadata. The question, image
  and category come from `https://m.world.xyz/<mint>`, cached in memory and in
  `.cache/predict-world-metadata.json`. World's own catalog API (`api.world.xyz`) returns 403 to
  scripts, so it is not used.
- **Prices.** They come from the last mainnet maker fills. Every party whose CASH and an outcome
  token moved in opposite directions in one transaction traded that outcome. The trader's side is
  used when it is a signer. Otherwise the maker's side is used, flipped to the trader's view. Many
  World trades are paid in USDC or SOL through DFlow, so the trader's own CASH never moves; the
  source only read the trader's side and left most markets unpriced. A side with no fill of its own
  is derived from YES + NO = 1, with a 2¢ synthetic spread. Up/Down windows with no trade open at
  51/49. An event-detail request also scans that market's own recent trades.
- **Allowlist.** It is read from the fork's AllowedMarket PDAs and cached for 60 s. It is never
  hardcoded. When this was written, 205 of the 444 listed non-window markets were allowlisted, and
  each of those has its pool.

### Event grouping (`lib/predict/grouping.ts`)

The rules run strongest evidence first. A derived family with only one live member falls back to
a single binary event. These counts are from a live run on 2026-10-10 (279 events):

| Rule | How | Count | Real examples |
|---|---|---|---|
| `window` | Name `<ASSET> Up` with a start and end time | 100 | `BTC Up or Down · 15 min` (yl/nl = Up/Down) |
| `group` → `match` | **World's on-chain `Group`** (mutually exclusive), sports, ≤2 sides + optional Draw | 65 | `Real Madrid vs Villarreal` (A216Yt…: Real Madrid / Villarreal / Draw); `NE Patriots vs LV Raiders` (NFL, `exh:false` since ties lose both) |
| `group` → `multi` | Larger Groups, titled from the members' shared question | 5 | `Who will win the 2026 NFL championship?` (4iDWpS…, 32 teams); `Will the Fed make exactly … rate cuts in 2026?` (78vH6e…, 21); Nobel Peace Prize (HaPAgV…, 10) |
| `wins` | `<X> wins <CODE>` / "Resolves YES if X wins <event>" | 4 | `Who wins Formula 1 2026 Drivers' Championship?` (14 drivers), `Who wins Singapore Grand Prix 2026?`, `WC26 winner?` |
| `level` → `strike` / `multi` | Same question with a different level (`above $X`, `between X and Y`, `exceed X%`, `$X or above`) | 7 | `Will Bitcoin trade … at any point in 2026?` (↑ $119,999.99 … ↓ $45,000, `lv` set); `Will the Nasdaq 100 Index close … at year-end 2026?` (19 buckets incl. the ↓ / ↑ tails → `multi`), S&P 500, WTI, gas, CPI, U3 |
| `date` | Same question with a different deadline (`by Oct 31`) | 0 live (unit-tested) | ladder sorted by date |
| `template` | Same question with a different subject (`Will {} win the 2028 Democratic presidential nomination?`) | 7 | 2028 GOP nomination (16), 2028 US Presidential (18), Dem nomination (11), House / Senate control (2 each), `Who will be arrested in 2026?` (`exh:false`) |
| `symbol` | Same symbol root and category (`BOP-DD-Y`, `BOP-RR-Y` …) | 1 | Senate × House balance of power (4) |
| `vs` | `NOR vs ENG: ENG wins (YES)` / `… Draw (YES)` (World Cup markets with no JSON and no Group) | 2 | `NOR vs ENG` |
| `single` | Everything else | 88 | `Will Barcelona win?` (World has no Group or opponent for it), `US enters a recession in 2026?` |

Side markets whose question mentions spread, total, O/U or handicap and names both teams of a
match join that match as `grp: "lines"`. None are live on World right now, so this is covered by a
unit test only. Event ids are the Group pubkey (`group`), the market id (`single` / `window`), or
`f-<fnv1a(key)>` for derived families. These ids stay stable across restarts.

### Trading (`POST /api/predict/trade`)

1. **Buy** N YES for C CASH at ask p (N = C/p). This is one atomic group, the same shape a real
   World fill has. The maker sends N − C CASH, the user calls `prediCt.split(N)`, and the user sends
   the N NO to the maker. On an allowlisted market (unless `noPool`) the group is followed by
   `create_pool` if the pool does not exist yet, then `deposit(is_yes, N)`. With the shared lookup
   table, **buy and deposit fit in one transaction**.
2. **Sell** N at bid b. If the wallet holds fewer than N, the user's pool shares are redeemed first.
   The redeem takes the fewest shares that cover the shortfall. When the pool's dangling tokens fall
   short, a USDC → CASH Manifest route that the pool signs by CPI is attached, as in the source.
   That redeem runs in its own transaction with Jupiter's lookup tables. After it, the user sends N
   to the maker, the maker merges them with its other-side inventory, and the maker pays N·b CASH.
3. **Deposit** (`side: "deposit"`) moves wallet tokens into the pool without trading. This serves
   the UI's "Earn on them" import.
4. **Pay with USDC** (`pay: "USDC"`) runs one USDC → CASH Manifest route first. The buys then spend
   its *minimum* output, split pro rata across buy legs. **This works on the fork** (e2e step 6).
5. Instruction groups keep their order and are packed greedily into v0 transactions of at most
   1,232 bytes and 64 accounts, with the maker's static lookup table. The maker signs the
   transactions it is a party to. The first transaction is simulated on the server: this catches
   balance and fee errors before the wallet prompt and heals a stale Manifest route once (it
   re-clones from mainnet but never touches wallet, pool or maker accounts).
6. In the client, `executePredictTrade` makes one `signAllTransactions` call for the whole batch,
   then sends and confirms each transaction in order. It then calls `POST /api/predict/pool/merge`
   with `mergeMarkets`. The keeper merges whenever min(poolYes, poolNo) > 0, and a market with
   nothing to merge is skipped.

## API contract

All routes are under `/api/predict` (`runtime = nodejs`). Errors return `{ "error": string }`
with status 400 for bad input or a rejected trade, and 502 for upstream (RPC) failures.

| Method | Route | Request | Response |
|---|---|---|---|
| GET | `/events?cat=&q=` | — | `{ events: PredictEvent[], updatedAt }` (first call after a cold start waits for the mainnet scan, ~25–60 s) |
| GET | `/events/:id` | `id` = event id **or any market id** | `{ event: PredictEvent }` (freshly priced, scans unpriced markets ≤8 s) |
| POST | `/trade` | `{ owner, legs: [{ marketId, outcome: "yes"\|"no", side: "buy"\|"sell"\|"deposit", amount }], pay?: "CASH"\|"USDC", noPool?: boolean }` | `TradeBuildResponse` |
| POST | `/faucet` | `{ address, amount? (≤1000 CASH, default 100), usdc?: boolean }` | `{ ok, added, cash, sol, usdc? }` |
| GET | `/positions/:owner` | — | `PositionsResponse` |
| GET | `/activity/:owner?market=` | — | `{ trades: TradeEvent[] }` |
| POST | `/pool/merge` | `{ marketId }` or `{ marketIds: [...] (≤10) }` | `{ results: [{ marketId, signature?, merged?, skipped?, error? }] }` |
| GET | `/status` | — | `{ maker, keeper, config: { admin, keeper, maxSwapLossBps }, keeperMatchesConfig }` |

`amount` units: for `buy` it is the CASH to spend (or USDC when `pay = "USDC"`); for `sell` and
`deposit` it is the number of outcome tokens. All amounts are UI units with 6 decimals.

```ts
interface TradeBuildResponse {
  transactions: { transaction: string /* base64 v0 */; label: string; legIndexes: number[]; makerSigned: boolean }[];
  quotes: { legIndex; marketId; outcome; side; amountIn; amountOut; price; payoutIfWin; pooled; redeemedShares }[];
  lastValidBlockHeight: number;   // shared by all transactions; send them in order
  mergeMarkets: string[];         // POST these to /pool/merge after the batch confirms
  swap: { usdcIn: number; cashOutMin: number } | null;
  warnings: string[];
}
interface PositionsResponse {
  owner: string;
  wallet: { cash: number; usdc: number; sol: number };
  positions: PredictPosition[];   // one per (market, side): wallet tokens + pool shares
  summary: PredictSummary;
  vault: PredictVault;
  importable: PredictImportable[]; // wallet tokens on allowlisted markets (can be deposited)
}
interface TradeEvent { signature; time; marketId; eventId; question; outcome; outcomeLabel; side: "buy"|"sell"; shares; cash; price; pooled }
```

## UI model and deviations from `lib/predict-sample.ts`

`PredictEvent`, `Outcome` / `PredictOutcome`, `PredictPosition`, `PredictSummary`, `PredictVault`
and `PredictImportable` use the sample's field names and meanings. All extra fields are additive:
`marketId`, `yesMint`, `noMint`, `symbol`, `image`, `yBid` / `nBid` (real bids in ¢), `oi`,
`lastTradeAt`, `tradable` and `poolDetail` on outcomes; `image`, `league`, `groupedBy`, `startMs`
and `endMs` on events; `walletShares`, `poolShares` and `poolValueShares` on positions. In the
sample, a position's `marketId` is the outcome key `k`; here `k` *is* the World market id, so the
two are the same.

Deviations:

- `Cat` adds `"other"` (culture / misc, e.g. the Nobel Peace Prize).
- `Outcome.y` / `n` are `number | null`. `null` means no mainnet trade exists to price the market,
  and `tradable` is then `false`.
- `Outcome.d` (24h change) and `res` (resolved side) are always omitted. No price history is
  indexed, and resolution is not decoded from chain yet.
- `Outcome.pool` is `{ yes, no }`, where each side is that side's dangling tokens **plus the USDC
  its matched pairs became**. This keeps the sample's meaning, `min(yes, no)` = USDC lent + pairs
  pending merge. The raw pool token-account balances are in `poolDetail` (`yesDangling`,
  `noDangling`, `invested`, `pendingMerge`).
- `PredictEvent.vol` equals `v24`, a best-effort 24h figure from the fill scanner. Lifetime volume
  is not indexed. `ends` / `opened` are set only for Up/Down windows, the only markets that store
  times on chain; otherwise they are `""`. `asset` is any World crypto (BTC, ETH, SOL, XRP, HYPE).
  `ic` is a short code; the artwork URL is in `image`. `score`, `when` (except on windows) and
  `open` are not set.
- `PredictPosition.queued` is always 0, because redeem is synchronous. `avg` and `cost` come from
  the wallet's reconstructed buys; `avg` falls back to the mark when no buy is found.
  `yieldShares` = pool redeem value − pool shares (it can be slightly negative after a merge's
  swap fee). `apy` = USDC supply APR × matched %.
- `PredictVault.earned` is always 0, because lifetime yield needs a deposit-history index.
  `deposited` / `pairs` = USDC invested across listed pools; `share` = that ÷ the USDC reserve's
  total supply.

Hooks (`hooks/use-predict.ts`): `usePredictEvents({cat,q})`, `usePredictEvent(id)`,
`usePredictPositions(owner?)`, `usePredictActivity(marketId?, owner?)`, `usePredictTrade()`
(mutation `{ legs, pay?, noPool? }`: one approval, progress shown through `lib/tx-progress`,
everything under the `["predict"]` keys invalidated afterwards) and `usePredictFaucet()`. Nothing is
stored in browser storage.

## Environment variables (Cloud Run)

| Name | Kind | Required | Notes |
|---|---|---|---|
| `PREDICT_FORK_MAKER_SECRET_KEY` | **Secret** (JSON byte array) | Recommended | Fork maker. Use the current one (`EYQes2wF4ErYVuNpNJZLaT5UPCfWny54soY7czoxH4E5`, from `.cache/predict-fork-maker.json`) so the maker's inventory and lookup table are kept. If unset, a new maker is generated per container, which works but holds no inventory. |
| `PREDICT_POOL_KEEPER_SECRET_KEY` | **Secret** (JSON byte array) | **Yes** (for merges) | Must be the pool Config's keeper, `GCE8FcSJskeT36tJgrQidgZGrVGvdNGQ7UgU2bPDyjmv` (from `.cache/predict-pool-keeper.json`). `GET /api/predict/status` shows `keeperMatchesConfig`. |
| `MAINNET_RPC_URL` | env (already used by the app) | Recommended | Mainnet reads (metadata, vaults). The program scan prefers public mainnet (Alchemy throttles it). |
| `PREDICT_LUT_ADDRESS` | env | Optional | Reuse an existing lookup table instead of creating one per container. One was created on the fork: `J4nwPvbAHUBhZW7jJo1PjfAF468fgJz9ry1CRcvV5QgJ` (also in `.cache/predict-lut.json`). |
| `PREDICT_MAINNET_RPC_URL`, `PREDICT_MAINNET_SCAN_RPC_URL`, `PREDICT_MAINNET_HISTORY_RPC_URL` | env | Optional | Overrides (history defaults to publicnode). |
| `JUPITER_API_KEY` | existing secret | Recommended | Merge, redeem shortfall and USDC pay quote through it; keyless is 0.5 req/s shared. |
| `FORK_RPC_URL` | existing env | — | Every transaction and fork read. |

The legacy names `WORLD_FORK_MAKER_SECRET_KEY` / `WORLD_POOL_KEEPER_SECRET_KEY` are also accepted.
The `.cache/` directory is gitignored and holds the two keypairs, the metadata cache and the lookup
table address. On Cloud Run it is ephemeral, and `/app` is writable by the `nextjs` user. Example:
`gcloud run services update <svc> --update-secrets=PREDICT_POOL_KEEPER_SECRET_KEY=predict-pool-keeper:latest,PREDICT_FORK_MAKER_SECRET_KEY=predict-fork-maker:latest`.

## Fork-only parts

- **The maker and the faucet.** On mainnet, World's makers only fill trades that DFlow routes with
  a quote signed for the trader, which a fork cannot get. Here the server's maker keypair co-signs
  every trade at the mainnet-derived price. Its SOL and CASH float and the CASH faucet use Surfpool
  cheatcodes (`surfnet_setAccount`).
- **Route healing.** `surfnet_resetAccount` re-clones Manifest route accounts that drifted.
- **The pool program itself**, `4kFzca1u9TUAVK7BjJZ5vVtfJ2QRATs38vN8Bq6qZwG3`, is deployed only on
  the fork.
- **Mainnet production would need** DFlow (or a World API key and route) in place of the fork
  maker, a real keeper service, and a resolution / settle flow (`settle`, `redeem_settled`). None
  of these are built.

## Admin: allowlisting more markets

`~/.config/solana/id.json` (`B7rDiCsL9DAWcd144RxPAiryc6AfVMHmq5n6KtiRmU8R`) **is** the pool
Config's admin and resolver, so it can run `allow_market`.

```
npx tsx scripts/predict-allow-markets.ts --live                 # dry run (239 listed markets not allowlisted yet)
npx tsx scripts/predict-allow-markets.ts <id…> --apply          # allow specific markets
npx tsx scripts/predict-allow-markets.ts --live --apply --create-pool
```

The script has not been run with `--apply`. Pools do not have to exist ahead of time: the first
buy creates the pool in the same batch.

## Tests

- `npx vitest run lib/predict`: 44 unit tests covering decoding (Market, Group, metadata), grouping
  (every rule, using real World names and questions), pricing and pool maths, and packing.
- `npx tsx scripts/e2e-predict.ts [marketId]` needs a dev server (`npx next dev -p 3100`;
  `PREDICT_API` overrides the URL). With a fresh keypair it runs: faucet, then buy YES (auto
  pool), buy NO, keeper merge (checks pool `invested` and the USDC reserve's supply go up), a
  2-outcome multi-leg buy with one signAll, a sell (redeem with the Jupiter shortfall route, then
  sell to the maker), and a buy paid with USDC. At the end it rebuilds the activity history and
  prints the summary.

## Known limits

- Coverage is best-effort. Prices are the last mainnet fills, so a market that has not traded
  recently has no price and cannot be traded. 24h volume undercounts after a cold start.
- A cold start scans about 48k mainnet accounts, filtered to around 4.2k. This takes 25–60 s on
  public mainnet. After that, the catalog is refreshed every 5 minutes in the background.
- No Market account links to its Group, and World does not group everything on chain. Single-team
  markets with no Group (`Will Barcelona win?`) stay binary, because the opponent cannot be found
  in on-chain or public data. Template and level families are heuristics. If World changes its
  question wording, a family can split into separate events; it never merges unrelated markets
  (the rules require the same template).
- Each Up/Down window is its own event. These windows are never allowlisted, and the hosted fork's
  clock (~1.85 h off) can make World reject trades on a window.
- If one transaction trades several outcomes, the activity history splits its cost pro rata by
  shares.
- Sell does not split the redeem when the pool would need a shortfall route larger than Manifest
  can fill at par. The program then fails with `SwapBelowMinimum`, a real market condition.
