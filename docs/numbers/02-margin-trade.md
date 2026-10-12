# Where the numbers come from: Margin, Perps and Spot

**Pages:** `/margin` (and `/`), `/trade/perps/[pair]` (e.g. `ethusdc`), `/trade/spot`.
**Chain:** core program `H37YVBG3eGtz89ofd7iDLc2PJgn12778392XeU2QJcGC`, oracle `FXY5DRfekMUTbUp4uyCFpCZmCccrp6kPq3hTM4GRihnc`, hosted Surfpool fork `https://rpc-devnet.solana.vanna.finance`.
**Live snapshot:** 2026-10-12 08:12 UTC wall clock. The fork clock read 1791807038 = 2026-10-12 12:10:38 UTC, so it runs about 4 h ahead of wall time. All file:line references are relative to the repo root.

---

## 0. The shared engine: how an account is valued

Every page here reads the same two on-chain pictures of the margin account:

| Layer | What it is | Where it runs | Refresh |
|---|---|---|---|
| **Margin snapshot** | `fetchMarginSnapshot(owner)` (`lib/solana/margin.ts:201-427`). It reads the MarginAccount PDA, every AssetConfig, each asset's margin vault (SPL token account), debt-position PDA and reserve, every oracle account, and the Phoenix venue. Deduplicated with `singleFlight`. | **Server:** `GET /api/account/[addr]` (`app/api/account/[addr]/route.ts:15-25`) → `useAccountSnapshot` (`hooks/use-account-snapshot.ts:44-66`). **Browser:** the same function, called inside `fetchPerpsView`. | `/api/account`: `staleTime 5 s`, plus invalidation on every ledger tick. `usePerpsView`: `refetchInterval 6 s`, `staleTime 3 s` (`hooks/use-perps.ts:18-32`). |
| **Account model** | `lib/account-model.ts`: plain-float maths over `{collateral rows, debt rows, Phoenix idle USDC, perp positions}`, built by `useV3Account` (`hooks/use-v3-account.ts:31-66`) from `usePerpsView().view.account` (`lib/solana/perps.ts:107-127`). | Browser | Follows `usePerpsView` (6 s) |
| **Oracle prices** | `GET /api/prices` (`app/api/prices/route.ts:14-38`) → `useTokenPrices` / `usePriceEntries` (`hooks/use-token-prices.ts:23-62`) | Server | `staleTime 5 s`, plus ledger tick |
| **Ledger tick** | `contexts/ledger-subscriber.tsx`: a WebSocket `onSlotChange` throttled to one tick per **8 s** (`TICK_INTERVAL_MS`), with an HTTP `getSlot` fallback poll every **10 s**. No ticks while the tab is hidden. | Browser | Not applicable |

Nothing is cached in localStorage. After a transaction, `refreshAfterTx` (`lib/after-tx.ts:33-41`) invalidates the `['margin']` (and `['perps']`) queries at once and the rest after 2 s.

**Which layer feeds which number**

- **Health factor, leverage, buffer, equity, totals** and every "before → after" preview: the **account model** (`useV3Account`). They do not come from the program-style `snapshot.healthFactor`.
- **Per-token vault balances, debts and borrow APR:** the **snapshot** from `/api/account`.
- **Token USD prices used for typed amounts** (e.g. "~ $X USD"): `/api/prices`.

### 0.1 Price of one token (oracle agent mirror)

`priceFromAccounts` (`lib/solana/oracle.ts:109-162`) reads each asset's on-chain `OracleConfig` from the oracle program's `PriceBook`:

1. **Kamino Scope** (primary).
   - price = product of up to 4 `OraclePrices` entries in `scope_chain`. Each entry is a u64 `value` at offset `40 + 56·i`, with `exp` at +8 and `unix_timestamp` at +24 (`oracle.ts:78-99`).
   - exponent = −Σ exp.
   - Timestamp = the **oldest** entry's timestamp.
2. **Pyth** `PriceUpdateV2` (× `pyth_factor` if set, e.g. JupSOL = JUPSOL/SOL × SOL/USD).
   - Read only when there is no Scope price **or the Scope price is stale**.
   - Used only if it is **newer** than the Scope price (`oracle.ts:140-159`).
3. **Perena vaults** (USD\*): a u64 price (6 decimals) plus an i64 publish time, read straight from the vault account (`oracle.ts:115-122`).

**Freshness:** `fresh = |forkNow − publishTime| ≤ OracleConfig.max_age_secs` (`oracle.ts:114`). `forkNow` is the fork's Clock sysvar, not wall time.

**Basis vault receipts** (vbSOL / vbETH / vbBTC) are priced by **simulating the vault's oracle** (`basisOraclePrice`, `lib/solana/margin.ts:266-281`). If a simulation fails, the last good price is kept in memory and flagged not fresh.

**Stale prices are NOT zeroed for display** (`margin.ts:182-191`). Zeroing them made the HF jump from 2.03 to 1.04 between keeper refreshes. Stale symbols that hold a balance are listed in `snapshot.stalePrices` instead. Every transaction first refreshes prices (`ensureFreshPrices`), so the program never values with a stale price.

### 0.2 USD value of a holding (nano-USD)

`normalizeTokenValue` (`lib/solana/math.ts:217-224`), an exact port of `health.rs`:

```
value_nanoUSD = amount_raw × price × 10^(price_exponent − token_decimals + 9)
```

- **Collateral** is rounded **down** and **debt** rounded **up**, like the program.
- `usd = valueNano / 1e9` (`margin.ts:345, 372`).
- **Kamino cTokens** (kSOL, kUSDC…): `underlying_raw = floor(receipts × total_liquidity / collateral_supply)` from the klend reserve (`lib/solana/kamino.ts:128-131`). It is then valued with the underlying's price and decimals (`margin.ts:325-334`). An unreadable reserve gives the receipt $0.
- **Phoenix venue** (one collateral line, no token): see 0.4.
- Only assets that are **active** in `collateral_asset_indexes` count toward the totals (`margin.ts:335`).

### 0.3 Debt (accrued to fork-now)

The `Reserve` is projected to `forkNow` (`projectReserve`, `math.ts:123-161`):

```
u            = total_borrows / (liquidity + total_borrows)                                  (WAD)
rate_per_sec = multiplier × (linear·u + linear·u^32 + jump·u^64) / 31_556_952               (WAD)
interest     = ceil(total_borrows × rate_per_sec × elapsed)
debt_raw     = ceil(borrow_shares × total_borrows' / total_borrow_shares)                   (math.ts:203-206)
borrowApr    = rate_per_sec × 31_556_952                (annualBorrowRate, math.ts:92-95; pool: protocol-state.ts:225)
```

### 0.4 Phoenix venue value (counts as collateral)

On-chain mirror: `loadPhoenixVenue` (`lib/solana/phoenix-state.ts:165-207`) and `positionEquityUsd` (`lib/solana/phoenix.ts:332-346`), matching `vanna_oracle::phoenix::position_equity`. Each position is valued at **Vanna's index oracle** (Scope → Pyth), not at the Phoenix mark.

```
idleUsdc      = trader.collateral / 1e6 × USDC_price
valueUsd_i    = baseLots_i / 10^lotDecimals × index_i
quoteUsd_i    = virtualQuoteLots_i / 1e6 × USDC_price                        (= −entry notional for a long)
fundingUsd_i  = −(cumFunding − fundingSnapshot_i) × baseLots_i / 1e6 × USDC_price
feeUsd_i      = |valueUsd_i| × takerFeeMicro / 1e6                          (fee to close)
equity_i      = valueUsd_i + quoteUsd_i + fundingUsd_i − feeUsd_i
venue value   = max(0, idleUsdc + Σ equity_i)          → valueNano = floor(× 1e9), added at FULL value (margin.ts:379-398)
```

The client model (`lib/account-model.ts:64-70`) recomputes this in float as `tokens·(index − entry) + funding − |tokens·index|·takerFee`. That treats the entry notional at $1 per USDC rather than the USDC oracle price, so it differs by a few cents (see the worked example).

### 0.5 Health factor

```
HF = Σ active collateral USD (incl. borrowed tokens sitting in the vault + Phoenix venue) ÷ Σ debt USD
```

- **Unweighted:** no LTV or liquidation-threshold weights per asset (`margin.ts:383`).
- Program and snapshot: `HF_WAD = floor(collateralNano × 1e18 / debtNano)` (`math.ts:227-230`); `null` = no debt.
- UI model: `holdings / debt`, ∞ when debt ≤ 1e-9 (`account-model.ts:79-82, 94-107`).

| Threshold | Value | Code |
|---|---|---|
| Liquidatable at | **HF ≤ 1.10** (on-chain healthy means strictly > 1.10) | `LIQ_HF` `lib/account-model.ts:17`; `BALANCE_TO_BORROW_THRESHOLD_WAD` `lib/solana/math.ts:15`; `LIQUIDATION_HEALTH_FACTOR` `lib/solana/config.ts:50` |
| UI blocks actions below | 1.15 | `SAFE_HF` `account-model.ts:19`; `SAFE_HEALTH_FACTOR` `config.ts:56` |
| UI warns below | 1.25 | `WARN_HF` `account-model.ts:21` |
| Colour zones | ≥1.5 or ∞ ok (Safe), ≥1.25 caution (Healthy), >1.10 warn (At risk), else danger (Liquidation) | `hfZone` `account-model.ts:228`, `hfLabel` `components/v3/format.ts:35` |
| Display | 2 dp; "No debt" if ∞ or ≥ 100 | `hfFmt` `format.ts:34` |

**Stablecoins** (prices held fixed in price-move scans, and excluded from "exposure"): USDC, USDT, JupUSD, PYUSD, USDS, USDG, phUSD, CASH, plus Kamino receipts of these (`account-model.ts:23-34`).

---

## 1. Margin page: `/margin` and `/`

Both routes render `components/margin/margin-page-content.tsx`. The screen's data bag is `useMarginScreen` (`components/margin/use-margin-screen.ts`):

- `now = accountNumbers(model)`.
- `snap` = the `/api/account` snapshot.
- `prices` = `/api/prices`.
- `vault(sym)`, `debt(sym)` and `wbal(sym)`, where values ≤ 1e-9 are treated as 0.

### 1.1 Stats strip (`margin-page-content.tsx:104-110`)

| Number | Source | Formula | Code | Edge cases |
|---|---|---|---|---|
| **Net Health Factor** | CALC (model) | `holdings / debt` | `account-model.ts:94-107`; render `margin-page-content.tsx:105` | Shows "No debt" when debt ≤ 1e-6 (`noDebt`, `mg-sim.ts:55`) or while loading. Red banner when HF ≤ 1.10 (`:100, 123-132`). |
| **Collateral Left Before Liquidation** | CALC | `max(0, holdings − 1.10 × debt)` | `liqBuffer` `mg-sim.ts:52` | "No debt" if no debt. Compact USD (`usdC`: $10.8K). |
| **Net Available Collateral** | CALC | `equity = holdings − debt` | `account-model.ts:96` | Can be negative (shown as −$). Unlike the legacy `margin-health.ts`, it is not floored. |
| **Net amount Borrowed** | CALC | `Σ debtRows.usd` (debt accrued to fork-now × oracle price, rounded up) | `perps.ts:124`, `margin.ts:357-374` | Not applicable |
| **Net Leverage Taken** | CALC | `exposure / equity`, with `exposure = Σ non-stable collateral USD + Σ |perp tokens × index|` | `account-model.ts:97-104` | equity ≤ 0 gives ∞, which `levFmt` prints as **"0.00x"** (`format.ts:33`). **Not** "1 + debt/equity". Stable collateral (incl. borrowed USDT in the vault) is not exposure, so a fully hedged account can show < 1x. USD\* and vb\* receipts are **not** in the stable set, so they count as exposure. |

All five values show $0 / "0.00x" until the first snapshot arrives (`dash = m.loading`).

### 1.2 Leverage your Assets (`components/margin/mg-leverage.tsx`)

| Number | Source | Formula | Code | Edge cases |
|---|---|---|---|---|
| Deposit row **Balance** | WB: wallet balance (user store, `/api/account` `wallet.ui`). MB: margin vault amount (snapshot). | Not applicable | `:70, 330` | Percent chips use **spendable** wallet SOL = balance − 0.05 SOL (`lib/margin/amounts.ts:63-68`) |
| Deposit "~ $X USD" | CALC | `amount × /api/prices` | `:294, 308` | Unknown price gives $0 |
| **Safe borrow limit** (`accMax`) | CALC (model) | Largest B, split equally across 1 or 2 borrow tokens, with `HF(withBorrows(withDeposits(model, deps), B)) ≥ 1.15`. Found by bisection: doubling to find the top, then 60 halvings (`mg-sim.ts:61-87`). Borrowed tokens are added to **both** collateral and debt. | `:83` | For a stable borrow this equals the closed form `(C − 1.15·D)/0.15` (`lib/solana/margin.ts:757-761`) |
| **Max leverage (slider)** | CALC | `clamp(floor2(1 + accMax / depositUsd), 1, 10)`. With no deposit typed: `1.15/0.15 = 7.67x` (`FRESH_ACCOUNT_MAX_LEVERAGE`, `amounts.ts:35`). | `:84` | The slider scale is always 1x–10x (`LEVERAGE_SLIDER_CAP`); the selected value is clamped to the max. Step 0.01; ± buttons step to whole numbers. Default 2x. |
| Borrow amount (auto) | CALC | `maxUsd = depositUsd × (lev − 1)`, split in equal USD across tokens, `/ price`, floored to token decimals | `:86-87`; `splitBorrowUsd` `amounts.ts:117-124` | A typed amount overrides it until a driving input changes |
| **Total / Max** | CALC | Total = Σ borrow amount × price; Max = `maxUsd` | `:90, 455-456` | Error if Total > Max + $0.01 or > accMax + $0.01 |
| **Preview** (before → after) | CALC (model) | `accountNumbers(withBorrows(withDeposits(model, deps), borrows))` | `:107-108, 480-490` | Rows: Account leverage, You're depositing, You're borrowing, Margin Collateral (= holdings), Outstanding Debt, Health Factor, Liquidation Buffer (= holdings − 1.1·debt). Warning if the after-HF is between 1.15 and 1.25 (`:285`). |

MB mode ("use margin balance") sends no deposit: `accMax` is computed on the current account, and the MB amount only sizes the leverage.

### 1.3 Repay Loan (`components/margin/mg-repay.tsx`)

| Number | Source | Formula | Code | Edge cases |
|---|---|---|---|---|
| **Net Outstanding Amount to Repay** | FETCHED snapshot `debts[sym].debt` (accrued to fork-now, rounded up) | `debt_raw / 10^dec` | `:71, 141` | "~ $" uses `/api/prices`; "<$0.01" for sub-cent values |
| Tooltip "interest accrued" | CALC from history | `debt_now − Σ borrowed + Σ repaid`, counted back to the last `open-debt` event | `amounts.ts:213-232` | **null** when the `DebtPositionOpened` event is outside the scanned history (200 signatures); the tooltip then says the split is unavailable |
| **Available Balance in Margin / Wallet** | Snapshot vault amount, or spendable wallet balance | Not applicable | `:74, 142-146` | Not applicable |
| % chips | CALC | 10/25/50 %: `min(debt × p, source balance)`. 100 % = **full repay** (`repay_all`). | `:93-98` | A full repay needs `debt × 1.002` in the source (`REPAY_ALL_BUFFER`, `amounts.ts:23, 169-193`). Borrowed tokens in the vault are usually slightly less than the accrued debt, so a full repay from margin often shows "Insufficient Balance". |
| Preview | CALC (model) | `withRepay`: debt −x; if repaying from margin, collateral −x too | `:119-122, 218-231`; `mg-sim.ts:42-46` | After-buffer shows "N/A, no debt" when the debt is fully repaid |

### 1.4 Transfer Collateral (`components/margin/mg-transfer.tsx`)

| Number | Source | Formula | Code | Edge cases |
|---|---|---|---|---|
| Max (wallet → margin, "MB") | Wallet balance | SOL keeps 0.05 SOL | `:57` | Not applicable |
| **Max withdraw** (margin → wallet, "WB") | CALC (model) | Largest x in [0, vault USD] with `HF(withWithdraw(x)) ≥ 1.15`, by bisection; `/ price`, floored to decimals | `:59-66`; `mg-sim.ts:90-93` | With no debt: the whole vault (`all: true`, to the last base unit). Price 0 gives a max of 0. |
| "~ X USD" | CALC | `max × price` | `:171` | Not applicable |
| Preview | CALC (model) | Margin Collateral, Health Factor, Liquidation Buffer after the deposit or withdraw | `:117-118, 198-208` | Red text if after-HF ≤ 1.10; amber if after-HF is between 1.15 and 1.25 |

### 1.5 Right column: Margin Account Info (`components/margin/mg-right.tsx:56-70`)

| Number | Source | Formula | Code |
|---|---|---|---|
| **Total Borrowed value** | CALC | `now.debt` | `:58` |
| **Net Available Collateral** | CALC | `now.equity = holdings − debt` | `:59` |
| **Total Value** | CALC | `now.holdings` (all collateral incl. borrowed tokens, idle Phoenix USDC and perp equity) | `:60` |
| **Net Health Factor** | CALC | `holdings / debt` | `:61` |
| **Net Borrow Rate** | CALC from snapshot | `Σ(borrowApr_i × debtUsd_i) / Σ debtUsd_i` (debt-weighted), × 100 shown with 2 dp | `use-margin-screen.ts:75`; render `mg-right.tsx:62` |

Not connected, or no account: every row shows $0.00, "No debt" or 0.00 %.

### 1.6 Liquidation card (`mg-right.tsx:150-193`)

| Number | Formula | Code |
|---|---|---|
| Zone chip | `hfLabel(hf)`: Safe / Healthy / At risk / Liquidation | `:159` |
| HF (big) | `hfFmt(now.hf)` | `:174` |
| "Liquidation at 1.10 · buffer $X" | buffer = `max(0, holdings − 1.10·debt)` | `:176` |
| Meter position | `hfPos(h) = clamp((h − 1)/1.5 × 100, 0, 100)` %; the 1.10 tick sits at 6.67 %; right end = 2.50+ | `account-model.ts:230` |

The card is hidden with no account or an empty account, and shows "No debt" with no debt. Room-before-liquidation and per-asset liquidation prices were removed from this card. They are still computed (`liqRoom`) and shown on Perps and Spot.

### 1.7 Oracles and LTs (collapsible, `mg-right.tsx:94-141`)

| Number | Source | Code |
|---|---|---|
| Liquidation Threshold "1.10x" | Constant `LIQ_HF` | `:113` |
| Per token: source label | `/api/prices` `source` ("scope" → Kamino Scope, "pyth" → Pyth) | `:128` |
| Per token: price | `/api/prices` `usd` (2 dp if ≥ 10, else 4 dp) | `:131` |
| fresh / stale · age | `ageSecs = forkNow − publishTime` (`api/prices/route.ts:21`); stale = `!fresh` (0.1). Age shown as s, m or h. | `:132-134` |

### 1.8 Positions: Current Positions (`components/margin/mg-positions.tsx:60-93`)

The whole cross-margin account is shown as **one row**. Data comes from the snapshot `m.snap`.

| Column | Formula | Code | Edge cases |
|---|---|---|---|
| **Collateral Deposited** | For each registry token: `deposited = vault_amount − min(vault_amount, debt_of_same_token)`, valued at `usd/amount`. Vault receipts (vb\*, USD\*) are shown as themselves with tag "vault". The Phoenix line is shown as "Phoenix perps", tag "perps", at venue value. | `:66-86` | Lines under $0.01 are hidden |
| **Borrowed Assets** | `debt` (tokens) and `usd`, plus share chip `round(usd_i/Σusd × 100)` %, plus "idle" = borrowed tokens still in the vault (`min(vault, debt)`) | `:62, 82-85, 127-158` | Not applicable |
| **Leverage Taken** | `now.leverage` (exposure / equity, see 1.1) | `:187` | Not applicable |
| **Health Factor** | `now.hf` | `:161` | Not applicable |
| **Interest accrued till date** | `Σ accrued_i(tokens) × (usd_i/debt_i)` from history (1.3) | `:89-90, 162` | An unknown accrual (null) counts as **0**, so the cell can read **$0.00** while interest is actually accruing. See the worked example. |
| Header chips Spot / Perps / Farm | Count of non-stable registry tokens held; `view.positions.length`; farm positions | `:91, 99-106` | Not applicable |

### 1.9 Positions History (`mg-positions.tsx:250-325`)

- **Source:** `useMarginHistory` → `fetchMarginHistory` (`lib/solana/history.ts:230`). It calls `getSignaturesForAddress(wallet, {limit: 200})` (`MAX_SIGNATURES`, `:115`) and then one `getTransaction` per signature, 6 at a time. Rows are decoded from Anchor events.
- **Refresh:** `staleTime 10 s` plus ledger tick (`hooks/use-margin.ts:25-40`). Transactions are kept in an in-process cache for 5 min.
- **Columns:**
  - Date: event timestamp, else `blockTime`, in local time.
  - Type: Account created, Deposit, Withdraw, Borrow, Repay or Liquidated.
  - Amount: event raw amount / 10^decimals.
  - Tx hash.
- **Paging:** 5 rows per page. Activity older than the last 200 wallet signatures does not appear.

### 1.10 Flash repay previews (`components/v3/flash-repay-modal.tsx`, plan in `lib/solana/flash-repay.ts:209-385`)

The plan is computed in the browser from `fetchMarginSnapshot`. Query `['flash-repay','plan',…]`, `staleTime 15 s`. Slippage choices are 0.1 / 0.5 / 1 %, default 0.5 %.

| Number | Formula | Code |
|---|---|---|
| **Positions** | Number of perps + farm receipts | modal `:313-317` |
| **Borrowed** | `debtUsd = Σ debt usd` (snapshot, accrued) | `flash-repay.ts:331` |
| **Est. costs** | `Σ Phoenix closeFeeUsd + Σ max(0, swap inUsd − outUsd)`. Each planned swap leg is quoted (Jupiter or Titan); without a quote, the oracle estimate is used. | `:315-316, 372-373` |
| **Left in margin / To your wallet** | Every bucket left after taking each loan's `debt × 1.005` (`DEBT_BUFFER_BPS = 50`). The buffer is added back, because `repay_all` takes the exact debt. | `:33, 320-330, 370` |
| Positions closed | `phoenixValueUsd` (venue value) + farm receipts' USD | `:227, 344` |
| Per perp | `sizeUsd`; `|equityUsd|` USDC "after fee"; P&L = `pnl + funding` | `:216-226` |
| Swap legs | `needUsd = shortfall × price × (1 + slip + 0.3 %)`; source = stables first, then the largest holding | `:270-296` |
| "keep at least" | `max(0, leftUsd − tradedUsd × slip)`, with `tradedUsd = Σ perp size + Σ swap inUsd` | modal `:296`; `flash-repay.ts:374` |
| After: HF → "No debt"; leverage → 1x (0x with transfer) | Display only | modal `:487-498` |
| Blocked | `shortUsd = Σ uncovered × price > $0.01` | `:332`, modal `:297` |

---

## 2. Perps: `/trade/perps/[pair]`

`app/trade/perps/[pair]/page.tsx` → `components/perps/terminal/perps-terminal.tsx`.

**Three sources:**

- **A.** `usePerpsView` (on-chain, every 6 s).
- **B.** `usePhoenixLive` (`components/perps/terminal/use-phoenix-live.ts`).
  - **Mainnet** Phoenix public feed: WebSocket `wss://perp-api.phoenix.trade/v1/ws` (market, orderbook, trades and candles channels) and REST `https://perp-api.phoenix.trade`.
  - Push-based. The book repaints at most every 250 ms. Reconnect backoff is 2 → 15 s.
- **C.** `usePerpsHistory`: on-chain, only while the History tab is open, `staleTime 10 s`.

Market statics (leverage cap, `tradingEnabled`, index-oracle config) are cached **5 min** (`phoenix-state.ts:96-114`).

### 2.1 Market bar (`components/perps/terminal/market-bar.tsx`)

| Number | Source | Formula | Code | Edge cases |
|---|---|---|---|---|
| **Mark** | B: WS `markPx` | Not applicable | `:122` | "0.0000" before the first message |
| **Index** | B: WS `oraclePx` (Phoenix's oracle) | Not applicable | `:129-131` | **Not** the Vanna on-chain index used for HF and liquidation |
| **24h change** | CALC | `(markPx − prevDayPx)/prevDayPx × 100` | `:44-45` | null shows "+0.00%" |
| **24h volume** | B: `dayNtlVlm` (USD) | `usdC` compact | `:132` | Not applicable |
| **Open interest** | CALC | `openInterest (base) × markPx` | `:133-135` | Not applicable |
| **Funding / 1h** | B: `funding`, already a percent | `spct(…, 4)` | `:136-137` | Not applicable |
| Funding countdown | CALC client-side | `3599 − (UTCmin·60 + UTCsec)`, i.e. assumes funding on the UTC hour | `:18-27` | Not read from any API |
| **Market status / feed** | A: on-chain `tradingEnabled`, then Vanna index `fresh` (0.1) | "Closed for new positions" / "Open · Feed stale" / "Open · Feed fresh" | `:66-72, 143-152`; `perps.ts:93-95` | `tradingEnabled` can be up to 5 min old |
| Max Nx | A: `maxLeverageBps / 10_000` | Not applicable | `:81`; `perps.ts:94` | Placeholder 5x (3x for TSLA/META) |

### 2.2 Margin account strip (`market-bar.tsx:205-261`; state built in `perps-terminal.tsx:80-97`)

| Number | Formula | Code |
|---|---|---|
| **HF** | Model `holdings/debt` (0.5) | `account-model.ts:94-107` |
| **Account leverage** | `exposure/equity` (1.1); ∞ prints "0.00x" | `:97-104` |
| **Room before liquidation** | `liqRoom`. For each exposed volatile price key, the price multiplier that brings HF to 1.10 with everything else held. Scan grids: DOWN = 1 − (i/100)·0.999 (1 % steps); UP = 1.05^i up to about 20.6×. Then 48-step bisection. The smallest move is shown as "SOL −x.x%". The sub-line moves all volatile prices together. | `account-model.ts:113-184`; `format.ts:47-61` |
| **Available** | `marginUsdc` = USDC **token amount** in the margin vault | `perps.ts:111` |
| **Perps value** | On-chain venue value `valueNano/1e9` (0.4) | `perps.ts:112` |
| **Open P&L** | `Σ sign × tokens × (liveMark − entry)` (excludes funding and fees) | `perps-terminal.tsx:107, 126` |

Room states: "No debt", "Liquidatable now" (HF ≤ 1.10), "None" (no price move gets there), or "KEY ±x.x%". Warning colour when |pct| < 10.

### 2.3 Order panel (`components/perps/terminal/order-panel.tsx:76-129`)

**Inputs:**
- `mark` = WS `markPx`, else the on-chain mark `ticks × tickSize × 10^lotDecimals / 1e6`.
- `c` = typed collateral in USDC.
- `L` = leverage: default 3, 0.5 steps, capped at the on-chain max.
- `s` = slippage %: default 1 %, or 2 % for TSLA and META (`perps.ts:67-71`).

| Number | Formula | Code |
|---|---|---|
| Available (collateral header) | `marginUsdc`; MAX = `floor(available × 100)/100` | `:201, 212` |
| **Max/Min entry (limit)** | `mark × (1 ± s/100)` (+ for long) | `:80` |
| **Position size** | `qty = c × L / limit` (tokens); `notional = qty × entry` | `:81-84` |
| **Est. entry** | Walk the WS order book up to the limit: `Σ(take × price) / filled`, else `mark`. A partial fill shows "No fill within x%". | `use-phoenix-live.ts:279-293`; `:82-83` |
| **Fee** | `qty × entry × takerFee`; `takerFee = takerFeeMicro / 1e6` (on-chain orderbook header byte 96) | `:84-85`; `phoenix.ts:187` |
| **Liq. price (est.)** | `positionLiqPrice(sim)`: index × the account-wide multiplier at HF 1.10, adverse side only. Distance = `(liq/mark − 1) × 100`. | `:101`; `account-model.ts:187-191` |
| **Zero-equity price** | `mark × (1 − 1/L)` long, `mark × (1 + 1/L)` short. Only this order's own collateral; ignores fees and cross-margin. | `:103` |
| **After: HF / leverage / room** | `accountNumbers(withOrder(state, …))`: USDC collateral −c, Phoenix collateral `+c − qty·entry·fee`, position added or averaged | `:86-100`; `account-model.ts:208-224` |
| After: Available | `available − c` | `:338` |
| CTA | Blocked if after-HF < 1.15; warns if < 1.25 | `:120-129` |

**The real order is not identical to this preview** (`perps.ts:314-366`):
- The on-chain size is `c × L` at a reference price: the **mainnet** Phoenix mark via `/api/perps/phoenix-book`, else the on-chain mark.
- It is then shrunk by 0.5 % steps until it fits `traderCollateral × maxLev − other markets' notional`. The preview does not model this cap.

### 2.4 Order book and trades (`components/perps/terminal/order-book.tsx`)

| Number | Source / formula | Code |
|---|---|---|
| Ask / bid price, size | WS `orderbook` levels, top 10 per side | `:73-89` |
| Total | Cumulative size from the best price outward; depth bar = `cum / max(cumAsk, cumBid)` | `:75-86` |
| Mid row | `mark` | `:102` |
| Spread | `bestAsk − bestBid`; % = `spread / ((ask + bid)/2) × 100` (3 dp) | `:83-84, 103` |
| Trades | WS `trades`: `price = quote / base`, size = base, buy if side = bid. Seeded by REST `/v1/trades/{sym}/fills?limit=40`. Shows 23. | `use-phoenix-live.ts:113-125, 220-233` |
| Chart O/H/L/C, Δ | REST `/v1/candles/{sym}` (120) plus WS candles; `Δ% = (c − o)/o × 100` | `price-chart.tsx:57-59, 105-118` |

**Note:** the book, trades and mark come from **mainnet** Phoenix, while positions live on the fork.

### 2.5 Positions table (`perps-terminal.tsx:101-126`, `bottom-panel.tsx`)

On-chain inputs per position (`phoenix-state.ts:169-196`):
- `sizeTokens = |baseLots| / 10^lotDecimals`.
- `entryPrice = |virtualQuoteLots / 1e6| / sizeTokens`.
- `fundingUsd` as in 0.4.

| Column | Formula | Code |
|---|---|---|
| **Size** | `tokens` and `tokens × mark` | `:115` |
| **Entry** | `entryPrice` (on-chain) | Not applicable |
| **Mark** | WS `markPx`, else the on-chain index | `:105` |
| **Liq. price** | `positionLiqPrice(state, key, side)` (account-wide, adverse side, **index**-based). Distance uses the mark. "Now" if HF ≤ 1.10; "None" if no crossing. | `:117`; `bottom-panel.tsx:40-66` |
| **PnL** | `sign × tokens × (mark − entry)` (no funding or fees) | `:107` |
| **ROE** | `pnl / collateral × 100` | `bottom-panel.tsx:203` |
| **Equity** | `collateral + pnl + fundingUsd` (no close fee) | `:120` |
| coll. / row leverage | `collateral = idleUsdc × (tokens·entry)_i / Σ(tokens·entry)`; leverage = `tokens × mark / collateral` | `:103, 108, 119` |
| Close modal | fee = `f × tokens × mark × takerFee`; realized ≈ `f × pnl − fee`; "back to margin" = `phoenixUsdc + pnl + funding − fee` | `bottom-panel.tsx:464-559` |

**Two valuations coexist:**
- **Table** PnL, Equity and ROE use the **live Phoenix mark** and **no** close fee.
- **HF, liquidation and Perps value** use the **Vanna index** and **subtract** the close fee.

`fetchPerpsView` also computes per-position `zeroEquityPrice` and `liquidationPrice` (`perps.ts:135-166`). The terminal does **not** display them.

### 2.6 History tab (`perps.ts:505-601`)

- Last **100** wallet signatures.
- Action decoded from the Phoenix selector inside `margin_execute`.
- Size = filled quote from the return data `/ 1e6`, falling back to `tokens × limit`.
- USDC = deposit or withdraw amount `/ 1e6`.

### 2.7 Account tab (`bottom-panel.tsx:259-312`)

| Row | Value |
|---|---|
| Health factor | `now.hf` |
| Leverage | `now.leverage` |
| Total collateral | `now.holdings` |
| Total debt | `now.debt` |
| Margin USDC | `marginUsdc` |
| Room | `liqRoom` |
| Perps value | `venueValueUsd` |
| USDC in Phoenix | `idleUsdc` (USD-priced) |
| Unrealized PnL | `openPnl` |
| Open positions | Count of positions |

The Withdraw button is enabled when `withdrawableNow > 0`. That is Phoenix's withdraw budget: `min(max, remaining + slots × replenish)` (`phoenix-state.ts:139-144`).

---

## 3. Spot: `/trade/spot`

`components/spot/v3/SpotPage.tsx` renders three things: `SwapCard` (`components/spot/spot-nonorderbook/SwapCard.tsx`), `AccountPanel`, and `PositionsBox` (history only).

- **Swaps always run from the margin account.** `swapMode = "margin"` (`SwapCard.tsx:110`), wrapped in the core program's `margin_execute` (`lib/solana/exec.ts:214-253`, `lib/solana/titan.ts:190-221`).
- **No best-of comparison on this page.** The provider is the dropdown choice, default **Jupiter** (`SwapCard.tsx:124`), passed as `provider` (`:225`). Only that aggregator is quoted.
  - `bestSwapQuote` (`lib/solana/aggregator.ts:81-100`) picks the highest raw `outAmount`, with ties going to Jupiter. It is used by Flash repay, not here.
- **No open-positions table or close modal is mounted.** `components/spot/v3/CloseModal.tsx` and `hooks/use-spot-positions.ts` are used by Portfolio, not Spot.

### 3.1 Swap quote card

**Quote fetch:** debounced **400 ms**; there is no periodic refresh, only the manual ↻ button. At submit, a quote older than **20 s** is re-quoted, and the swap aborts if the new minimum is lower.

- **Jupiter:** `/api/jupiter/quote` → `api.jup.ag` (or `lite-api.jup.ag`) `/swap/v1/quote`.
  - `maxAccounts = 20`, retried at 32.
  - DEXes are restricted to `Raydium, Raydium CLMM, Raydium CP, Orca V2, Meteora DLMM, Whirlpool` (fork-supported).
  - Code: `app/api/jupiter/quote/route.ts:17-36`, `exec.ts:185-205`.
- **Titan:** `/api/titan/quote` → `portal.api.titan.exchange/api/v1/quote/swap` (`lib/solana/server/titan-api.ts:54-108`). Needs `TITAN_API_KEY`; without it a banner is shown.

| Number | Source / formula | Code | Edge cases |
|---|---|---|---|
| **Swappable** | Snapshot vault amount (`collateralBalances`, `/api/account`) | `:163-181` | "0" with no margin account |
| % chips / MAX | `floor(balanceRaw × pct / 100)` | `:481-495` | Not applicable |
| **You Receive** | `quote.outAmount`, **truncated** to 6 dp | `:266-267, 54-60` | Not applicable |
| "~ $" (pay / receive) | Typed amount × `/api/prices` | `:269-280` | Hidden if the price is 0 |
| **Rate** | `outUi / inUi` from the quote (or the inverse when flipped) | `:286-294` | This is the execution rate, not the oracle price |
| **Price impact** | Jupiter `priceImpactPct × 100` (abs value). Shown as "<0.01%"; level low < 1, medium < 3, else high; banner when > 5 % | `:297-305` | **Hidden for Titan** (no field) |
| **Slippage** | Default 0.5 %; presets 0.1 / 0.5 / 1; sent as `clamp(round(pct × 100), 1, 5000)` bps | `:113-121`; `swap-modals.tsx:14-15` | Shows the raw typed text while the request uses the clamped value |
| **Min. received** | Jupiter: `otherAmountThreshold`. Titan: `floor(out × (10000 − slippageBps)/10000)`. | `:308-311`; `aggregator.ts:52` | Not applicable |
| Route / hops | `routePlan[].swapInfo.label` and `percent` (the "fee" slot is actually the split %) | `:314-349` | Not applicable |
| **Fees** | **Not shown.** No platform fee: the margin adapter forbids it, and Titan has no provider fee. | Not applicable | Not applicable |
| **HF before → after** | Model: `withSwap(state, from, inUsd, to, outUsd)`, with `inUsd = quote in × price` and `outUsd = quote out × price` | `:354-371`; `components/spot/v3/swap-model.ts:24-35` | Blocked if after < 1.15 and lower than before; amber if after < 1.25 |

### 3.2 Account panel (`components/spot/v3/AccountPanel.tsx`)

All values come from the model (`useV3Account`). "After" values apply only when a quote exists.

| Number | Formula | Code |
|---|---|---|
| Status chip | `hfLabel` | `:111` |
| Health factor (now → after) | `holdings / debt` | `:117-127` |
| HF meter | `hfPos` | `:128-143` |
| Account leverage | `exposure / equity` | `:146` |
| Borrowed | `now.debt` (a swap never changes it) | `:147` |
| Swappable {from} | Snapshot amount; after = `max(0, amt − inUsd / price)` | `:148-153` |
| {vol} liq. price | `price × liqMultiplier(state, key, side)`: side = short if the token is borrowed and not held, else long; "None" when no crossing | `:61-64, 154` |
| Room before liquidation | `liqRoom` (2.2) | `:155-161` |

### 3.3 Position History (`components/spot/v3/PositionsBox.tsx`)

- Rows: `useMarginHistory`, filtered to `type === "swap"`, built from the `MarginExecuted` spent and received lists (`history.ts:340-366`).
- Columns:
  - Time.
  - Paid: spent raw / 10^decimals.
  - Received: the actual fill.
  - Via: Jupiter or Titan, from the target program.
  - **Health after:** the event's `borrow_health_factor_wad / 1e18` (the program's own HF), truncated to 3 dp.
  - Tx.
- Header shows "partial history" when there are more than 200 signatures.

---

## 4. Worked example: the real account

- **Wallet:** `34iZErvTLtY6K9JAmcTTbMcWFP9toSX7iXnYwpENH7XW`
- **Margin PDA:** `GB1EDKaeGcPEvnMgcPd8Q1ibQV3p4DgNys3ahJWLoMZf`
- **Read:** 2026-10-12 08:12 UTC (wall), via `GET http://localhost:3100/api/account/<wallet>` and a scratch `tsx` script calling `fetchPerpsView`, `fetchPoolStates` and `fetchMarginHistory` on the fork.
- **Fork clock:** 1791807038 (12:10:38 UTC).
- **Freshness:** `stalePrices = []`; every Scope price has publishTime = fork-now − 1 s. Basis receipts were published about 4 h earlier but are within their max age.

### 4.1 Collateral lines (snapshot, all active)

| Line | Amount | Price (USD) | USD (nano-rounded) | How valued |
|---|---|---|---|---|
| SOL | 80 | 112.18925817 | 8,975.14 | `80e9 × price`, Scope |
| USDC | 170 | 0.99985901 | 169.98 | Scope |
| USDT | 11,055.998487 | 0.99893079 | 11,044.18 | Almost all of it is the **borrowed** USDT sitting idle in the vault |
| kUSDC | 83.017241 cTokens | 0.99985901 (USDC) | 100.02 | cTokens × reserve rate × USDC price |
| kSOL | 17,306.167767 cTokens | 112.189 (SOL) | 2,244.33 | Same, about 20.0 SOL underlying |
| USD\* | 9.074881 | 1.101795 | 10.00 | Perena vault price |
| vbSOL / vbETH / vbBTC | 244.46 / 50.04 / 51.31 | 0.98373 / 0.99973 / 1.00044 | 240.48 / 50.03 / 51.34 | Basis vault oracle simulation |
| **Phoenix venue** | — | — | **104.37** | idle 99.9167 + ETH long equity 4.4558 |
| **Σ collateral** |  |  | **22,989.857195729** | `totalCollateralUsd` |

Debt: USDT `debtRaw = 11,057.152654` × 0.99893079, rounded up = **$11,045.330235811**.

### 4.2 Health factor

```
Snapshot (program-style): HF = 22,989.857195729 / 11,045.330235811 = 2.081409   → floor(WAD) shown as 2.081409
Model (what the UI shows): holdings = Σ rows (22,885.4846) + venueValue (104.3447) = 22,989.8293
                           HF = 22,989.8293 / 11,045.3304 = 2.0814 → "2.08"  (zone z-ok, "Safe", since ≥ 1.5)
```

The $0.028 gap between the two holdings figures comes from the venue line. The model values the ETH entry notional at $1 per USDC (`0.079 × (2558.9637 − 2501.8) = 4.5159`). The oracle prices the virtual quote at the USDC price 0.99985901 (`202.1581 − 197.6143 = 4.5438`).

### 4.3 Stats strip / Account Info

| Number | Filled formula | Shown |
|---|---|---|
| Net Health Factor | 22,989.83 / 11,045.33 | **2.08** |
| Collateral Left Before Liquidation | 22,989.83 − 1.10 × 11,045.33 = 22,989.83 − 12,149.86 | **$10,839.97** ("$10.8K" in the strip) |
| Net Available Collateral (equity) | 22,989.83 − 11,045.33 | **$11,944.50** |
| Net amount Borrowed / Total Borrowed value | Σ debt | **$11,045.33** |
| Total Value | holdings | **$22,989.83** |
| Net Leverage Taken | exposure = SOL 8,975.14 + kSOL 2,244.33 + vbSOL 240.48 + vbETH 50.03 + vbBTC 51.34 + USD\* 10.00 + ETH perp 0.079 × 2,558.96 (202.16) = 11,773.47; ÷ 11,944.50 | **0.99x** |
| Net Borrow Rate | Single loan, so the debt-weighted average = USDT pool APR (below) | **1.21%** |

Leverage is below 1 because the debt is USDT that still sits in the vault (stable, so it is not exposure). In this model only the volatile holdings count, and they are smaller than equity. The vb\* and USD\* receipts count as exposure even though they are near-$1 vaults.

### 4.4 Borrow rate (USDT pool)

The fork reserve `rateCurve` has `linear = 0.01`, `jump = 0.30` and `multiplier = 3.5` (all WAD). Utilization is `u = 0.344983` (borrowed 11,057.15 of 32,051.09 supplied).

```
APR = 3.5 × (0.01 × (u + u^32) + 0.30 × u^64)
    = 3.5 × (0.01 × 0.344983 + ~0 + ~0)
    = 0.0120744  → 1.21 %
```

### 4.5 Liquidation buffer, limits, room

| Figure | Formula | Value |
|---|---|---|
| Liquidation buffer (card) | holdings − 1.1·debt | $10,839.97 |
| Meter position | (2.0814 − 1)/1.5 | 72.1 % of the bar |
| Safe extra borrow (stable borrow, no deposit) | (22,989.83 − 1.15 × 11,045.33)/0.15 | ≈ $68,585 |
| Safe max withdraw | 22,989.83 − 1.15 × 11,045.33 | ≈ $10,287.70 (e.g. min(80 SOL, 10,287.70/112.19 = 91.7) = all 80 SOL) |
| Room before liquidation | `liqRoom` | **SOL −96.6 %**; all volatile prices −92.8 % together |
| ETH long liq. price | `positionLiqPrice` | **None**: ETH alone can't push HF to 1.10, because the venue is floored at 0 and is only $104 |

### 4.6 Interest accrued (positions row): a live discrepancy

- History holds 19 rows (complete). There is one USDT `borrow` of 11,055.998487 on 2026-10-09, but **no `open-debt` row**.
- `accruedInterestBySymbol` therefore returns `null`, and the Positions cell shows **$0.00**. The Repay tooltip says "split unavailable".
- Actual accrual from the debt alone: 11,057.152654 − 11,055.998487 = **1.154167 USDT ≈ $1.15**.

### 4.7 Perps position (ETH-PERP long, on-chain view)

**Inputs:**
- sizeTokens 0.079; entry 2,501.80 (= |virtualQuote|/size).
- Vanna index 2,558.96367393 (fresh); on-chain mark 2,564.50.
- takerFee 0.00035 (= 350 micro, 0.035 %); funding −$0.01722.
- Idle Phoenix USDC $99.9167.

**Oracle and HF valuation (0.4):**
```
valueUsd  = 0.079 × 2,558.9637              = 202.1581
quoteUsd  = −197.6422 × 0.99985901          = −197.6143
pnlUsd    = 202.1581 − 197.6143             = 4.5438
feeUsd    = 202.1581 × 0.00035              = 0.0708
equity    = 4.5438 − 0.0172 − 0.0708        = 4.4558
venue     = max(0, 99.9167 + 4.4558)        = $104.37   ← "Perps value", counted in HF
```

**Positions table** (uses the live mainnet Phoenix mark; shown here with the index 2,558.96 standing in for it):
```
PnL      = +1 × 0.079 × (2,558.96 − 2,501.80)   = +$4.52
coll.    = 99.9167 × (0.079·2501.8)/(0.079·2501.8) = $99.92   (only position)
ROE      = 4.52 / 99.92                           = +4.52 %
Equity   = 99.92 + 4.52 − 0.0172                  = $104.42   (no close fee, unlike the venue's $104.37)
Leverage = 0.079 × 2,558.96 / 99.92               = 2.02x
Liq.     = None
```

**Order-panel example** (hypothetical 100 USDC, 3x long ETH, 1 % slippage, mark 2,564.50):
```
limit = 2,564.50 × 1.01        = 2,590.15
qty   = 100 × 3 / 2,590.15     = 0.11582 ETH
fee   ≈ 0.11582 × 2,564.5 × 0.00035 = $0.104
zero-equity = 2,564.50 × (1 − 1/3) = $1,709.67
```

---

## 5. Known quirks (summary)

1. **Leverage formula differs from "1 + debt/equity".** It is `volatile exposure / equity`. Stable collateral, including idle borrowed stables, is excluded, while vault receipts (vb\*, USD\*) count as volatile. ∞ prints as "0.00x".
2. **Interest accrued shows $0.00 when the open-debt event is not in history** (4.6). An unknown value is summed as 0.
3. **The Perps "Index" in the header is Phoenix's mainnet oracle**, while HF and liquidation use Vanna's fork index. The order book, trades, mark and funding are mainnet Phoenix; positions are on the fork.
4. **Perps table equity and PnL use the mark without the close fee.** Perps value and HF use the index with the fee.
5. **The perps zero-equity price is per order only** (`mark·(1 ∓ 1/L)`). The on-chain size can be shrunk by the leverage cap, which the preview does not show.
6. **The funding countdown assumes UTC top-of-hour.** `tradingEnabled` and `maxLeverage` can be up to 5 min old.
7. **Spot quotes one aggregator (Jupiter by default), not best-of.** Titan quotes have no price impact. There is no auto re-quote except at submit (> 20 s old).
8. **History scans only the last 200 (margin, spot) or 100 (perps) wallet signatures.**
9. **The fork clock is about 4 h ahead of wall time.** Freshness and accrual use the fork clock.

---

## Glossary

- **Holdings:** Σ USD of active collateral lines (vault tokens incl. borrowed ones, Kamino cTokens, vault receipts) plus the Phoenix venue value.
- **Debt:** Σ USD of debt positions, accrued to the fork clock and rounded up.
- **Equity / Net Available Collateral:** holdings − debt.
- **HF (health factor):** holdings ÷ debt, unweighted. Liquidatable at ≤ 1.10; the UI blocks below 1.15 and warns below 1.25.
- **Liquidation buffer / Collateral Left Before Liquidation:** holdings − 1.10 × debt.
- **Exposure:** Σ USD of non-stable collateral plus Σ |perp size × index|.
- **Room before liquidation:** the smallest single-price % move (others held) that takes HF to 1.10.
- **nano-USD:** the program's internal USD unit, 1e-9 USD.
- **WAD:** 1e18 fixed point (HF and rates).
- **Fresh price:** |fork-now − publishTime| ≤ the asset's `max_age_secs`.
- **Kamino Scope:** Kamino's price-aggregator account (primary source). **Pyth:** fallback source.
- **cToken / Kamino receipt (kSOL, kUSDC):** klend collateral token, worth `total_liquidity / collateral_supply` underlying.
- **Phoenix venue:** the margin account's Phoenix perps trader account, counted as one collateral line worth max(0, idle USDC + Σ position equity at the index, minus the close fee).
- **Index vs mark:** index = Vanna's oracle price (used for HF and liquidation); mark = the Phoenix market's mark price (used for display PnL and order sizing).
- **WB / MB:** wallet balance / margin balance (the source of a deposit, repay or transfer).
- **repay_all:** a full repay that closes the debt position; it needs debt + 0.2 % in the source.
- **Fork clock:** the Surfpool fork's Clock sysvar time, used for accrual and freshness. Not wall time.
