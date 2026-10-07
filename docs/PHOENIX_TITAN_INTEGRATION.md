# Phoenix Perps and Titan Swaps: How the Integration Works

This document explains how Vanna's margin accounts trade **perpetuals on Phoenix** (Perps page)
and **swap through Titan** (Spot page, next to Jupiter). It covers:

- the on-chain pieces and which contract functions run, in what order;
- what the frontend builds for each user action, with real examples from the fork;
- how health checks, valuation and liquidation treat a Phoenix position;
- fork-only workarounds and what is still needed for mainnet.

Repos:

- **Contracts:** `vanna-credit-layer`, branch `feature/phoenix-titan`.
- **App:** `vanna-credit-backend`.

---

## 1. The big picture

A Vanna margin account is a PDA owned by the core program. It can't sign for itself from outside,
so every interaction with an external protocol goes through **one generic core instruction**:
`margin_execute`.

```
User wallet ──signs──▶ vanna_credit_layer::margin_execute(data, call_account_count, new_assets)
                         │
                         ├─▶ vanna_validator::review_call   "is this exact call allowed? what may it spend?"
                         │        returns a CallPermit
                         │
                         ├─▶ CPI into the target program, signed by the margin PDA
                         │        (Titan / Ember / Phoenix / Jupiter / Kamino)
                         │
                         ├─▶ check the margin's token vaults (spend caps, ownership, no delegate)
                         │
                         └─▶ vanna_oracle::get_price for every holding → health factor must stay ≥ borrow threshold
```

The core program knows nothing about Phoenix or Titan specifically. The protocol-specific rules
live in two places:

| Program | Address | Role |
|---|---|---|
| `vanna_credit_layer` (core) | `H37YVBG3eGtz89ofd7iDLc2PJgn12778392XeU2QJcGC` | Margin accounts, lending, `margin_execute`, `public_liquidate`, health checks |
| `vanna_validator` | `6fND3vhtstp486iE6rsSNVUox3kcjNNRsSLAN7ZPs7th` | `review_call`: per-protocol allow-list. Decides which instructions, accounts and amounts are allowed |
| `vanna_oracle` | `FXY5DRfekMUTbUp4uyCFpCZmCccrp6kPq3hTM4GRihnc` | `get_price`: token prices (PriceBook) and the **Phoenix venue value** (MarketBook) |

External programs:

| Program | Address | Used for |
|---|---|---|
| Phoenix Eternal | `EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih` | Perps: deposit, market orders, withdraw |
| Phoenix exchange (global config) | `2zskx2iyCvb6Stg7RBZkt1f6MrF4dpYtMG3yMvKwqtUZ` | Global state: vault, perp asset map, withdraw queue |
| Ember | `EMBERpYNE6ehWmXymZZS2skiFmCa9V5dp14e1iduM5qy` | Wraps USDC ⇄ phUSD 1:1 (Phoenix's collateral token) |
| phUSD mint | `PhUsd11YkbjSaWjFncfAAmatntsjx3MgDR9B6g1ks3A` | Phoenix collateral token |
| Titan router | `T1TANpTeScyeqVzzgNViGDNrkQ6qHz9KrSBS4aNXvGT` | `swap_route_v3`: the swap route Titan's API builds |

---

## 2. One-time setup (admin)

These run once per network from `vanna-credit-layer/scripts` (`integrations-fork.ts`). They are
already done on the hosted fork.

### 2.1 Titan: `register-titan`

| Contract call | What it does |
|---|---|
| `vanna_credit_layer::admin_register_integration` | Creates the `Integration` PDA (`["integration", TITAN]`) that binds the Titan program to `vanna_validator`. Without it, `margin_execute` with Titan as target fails the `integration` seed check. |

That is all Titan needs. A swap only moves tokens between two of the margin's own vaults, and
those tokens are already registered assets.

### 2.2 Phoenix: `register-phoenix --market SOL|ETH|BTC|TSLA|META`

| # | Contract call | What it does |
|---|---|---|
| 1 | `admin_register_integration` (Phoenix) | Integration PDA for the Phoenix program → validator |
| 2 | `admin_register_integration` (Ember) | Integration PDA for Ember → validator (needed for the USDC ⇄ phUSD wrap) |
| 3 | `vanna_oracle::open_market_book(venue = exchange, program = PHOENIX, collateral_price = USDC feed)` | Creates the **MarketBook**: the oracle's list of Phoenix markets Vanna allows. Done once. |
| 4 | `vanna_oracle::list_market(index_price, max_leverage_bps, trading_enabled)` | Adds one Phoenix market (orderbook account, asset id, index price source, leverage cap). Run once per market. |
| 5 | `admin_register_asset(phUSD)` (+ `set_price_source`) | phUSD becomes a known asset priced at the USDC feed (collateral only, never borrowable) |
| 6 | `admin_register_venue(exchange)` + `admin_update_asset_config` | Creates the **venue AssetConfig** (`["asset", PHOENIX_EXCHANGE]`) and enables it as collateral. The whole Phoenix account counts as **one collateral line** on the margin. |

Markets listed on the fork:

| Market | Max leverage | Index price (what the oracle values positions at) |
|---|---|---|
| SOL-PERP | 5x | Pyth SOL/USD |
| ETH-PERP | 5x | Pyth ETH/USD |
| BTC-PERP | 5x | Pyth BTC/USD |
| TSLA-PERP | 3x | TSLA index (fork: TSLAx price) |
| META-PERP | 3x | META index (fork: METAx price) |

**MarketBook layout** (zero-copy). The app decodes it in `lib/solana/phoenix.ts`:

- market count at byte 106;
- collateral price config at byte 108;
- entries start at byte 292, each 228 bytes.

Each entry holds: `market` @0, `asset_id` @32, `max_leverage_bps` @36, `trading_enabled` @40, and the
`index_price` OracleConfig @44.

---

## 3. Phoenix perps

### 3.1 The model

- The **margin PDA is its own Phoenix trader**. The trader account is the PDA
  `["trader", margin, 0u16]` (cross-margin subaccount 0).
- Phoenix holds collateral in **phUSD**. The margin's USDC is wrapped to phUSD by Ember (1:1),
  then deposited into the trader.
- Orders are **immediate-or-cancel market orders**. They fill against the book inside the
  transaction, so there is no keeper and no pending order. That is why the Perps page has no
  "Open orders" tab.
- On the margin, everything inside Phoenix (deposited collateral ± every position's PnL, funding
  and close fee) shows as **one collateral line, "Phoenix"**, valued by the oracle.

### 3.2 What the validator allows (`vanna_validator/src/phoenix.rs`)

`review_call` dispatches on the target program. For Ember it calls `ember_permit`; for Phoenix it
calls `permit_for`.

| Call (8-byte discriminator) | Who may call | Rules enforced | Permit returned |
|---|---|---|---|
| **Ember `deposit`** (USDC → phUSD) | Owner only | Exactly 8 accounts, `amount > 0` | Spends USDC vault (index 4) up to `amount`, receives phUSD vault (index 5) |
| **Ember `withdraw`** (phUSD → USDC) | Owner only | `amount` ≠ 0 (None = all) | Spends phUSD, receives USDC |
| **Phoenix `deposit_funds`** | Owner only | `amount > 0`; account 2 = exchange, 4 = margin's phUSD ATA, 5 = margin's trader PDA, 6 = Phoenix global vault | Spends phUSD up to `amount`; **`opens_venue = true`** (puts "Phoenix" on the collateral list) |
| **Phoenix `withdraw_funds`** | Owner, or liquidator | Same account checks; the **withdraw queue must be empty and the amount within the current withdraw budget**, otherwise `WithdrawWouldQueue`. For a liquidator, the amount is overridden to the trader's full collateral. | Receives phUSD into the margin's phUSD ATA |
| **Phoenix `place_market_order`** (reduce-only) | Owner, or liquidator | Orderbook must be **listed in the MarketBook** | Always allowed: it can only shrink risk |
| **Phoenix `place_market_order`** (opening) | Owner only | Market listed **and** `trading_enabled`; must carry a **limit price**; `num_quote_lots` must be None; **leverage check** (below) | `opens_venue = true` |

**Leverage check** (`check_leverage`). It values exposure at the order's **limit price**:

```
new_base   = current position base lots ± order lots
this       = |new_base| × limit_price × tick_size
others     = Σ |virtual_quote_lots| of the trader's other open positions
require    (this + others) × 10 000  ≤  trader_collateral × max_leverage_bps
```

Example: 200 phUSD collateral on SOL (5x cap) allows up to $1,000 of exposure. The app sizes the
order to stay inside this cap, shrinking it 0.5% at a time if needed. Without that, the
transaction would fail with `LeverageTooHigh`.

### 3.3 How the oracle values the venue (`vanna_oracle/src/phoenix.rs::venue_price`)

On every health check the core program asks `get_price` for the venue holding. The oracle:

1. reads the trader (`["trader", margin, 0]`) and requires `is_supported` (cross subaccount, owned by the margin);
2. starts with `collateral × USDC price`;
3. for each open position:
   - looks up its market in the MarketBook (unlisted → `MarketNotInBook`);
   - reads the **index price** and the market's `cumulative_funding` from the perp asset map;
   - adds `position_equity`:
     ```
     equity = base_lots × index_price               (position value)
            + virtual_quote_lots × USDC_price       (− entry notional for a long, + for a short)
            − (cumulative_funding − funding_snapshot) × base_lots   (funding owed)
            − |base value| × taker_fee              (cost to close)
     ```
4. returns `max(0, total)` and `open = collateral ≠ 0 || any base_lots ≠ 0`.

`open = false` means the venue holds nothing. `margin_execute` then removes "Phoenix" from the
collateral list.

The app reproduces this exact formula in `lib/solana/phoenix-state.ts::loadPhoenixVenue`, so the
health factor the UI shows matches what the chain computes.

### 3.4 User flow 1: open a position

Example: **2x SOL long with 200 USDC** from a margin holding 1,000 USDC.

**Step 0 (first time only): create the Phoenix trader.**

| Tx | Instruction | Signed by |
|---|---|---|
| A | Phoenix `register_trader` (discriminator `[75,243,224,167,1,5,51,32]`): creates `["trader", margin, 0]` with 128 position slots. Permissionless: the wallet pays the rent and the margin is the authority. | Wallet |
| B | **Fork only:** the app calls `POST /api/perps/phoenix-access`, which writes the trader's capability flags (u32 @ byte 96) from `0x06` to `0x3e`. On mainnet, Phoenix grants these itself (see §6). | — (cheatcode) |

**Step 1: the open transaction (one transaction, `lib/solana/perps.ts::openPerp`).**

Before building it, the app:

- refreshes the fork's prices (`ensureFreshPrices`);
- refreshes the SOL orderbook (`/api/perps/phoenix-book`);
- reads the venue (`loadPhoenixVenue`).

Then it builds:

```
ix 0  ComputeBudget (CU limit, 256 KiB heap frame)
ix 1  ATA create (idempotent): margin's phUSD vault
ix 2  vanna_credit_layer::margin_execute
        target   = Ember
        data     = Ember deposit(200_000_000)               // 200 USDC → 200 phUSD
        validator: ember_permit → spends USDC ≤ 200, receives phUSD
ix 3  vanna_credit_layer::margin_execute
        target   = Phoenix, venue_asset = AssetConfig["asset", PHOENIX_EXCHANGE]
        data     = deposit_funds(200_000_000)                // phUSD → trader collateral
        validator: permit_for → DEPOSIT_FUNDS, opens_venue = true
ix 4  vanna_credit_layer::margin_execute
        target   = Phoenix, venue_asset = Phoenix venue
        data     = place_market_order { side: BID, price_in_ticks: limit, num_base_lots: N,
                                        order_type: IOC, flags: 0 }
        validator: permit_for → listed + trading enabled + leverage ≤ 5x
```

- **Limit price:** reference price × (1 + slippage) for a long, × (1 − slippage) for a short. The
  reference is the index price, falling back to Phoenix's mark. Default slippage is 1%, or 3% for
  TSLA/META, whose books are thinner.
- **Size N:** `collateral × leverage / limit`, in base lots.

Inside **each** `margin_execute`, after the CPI, the core program:

1. checks the margin's vaults (spent ≤ permit cap, still owned by the margin, no delegate or close authority);
2. values every holding through `vanna_oracle::get_price`, including the Phoenix venue (§3.3);
3. requires health ≥ the borrow threshold (`HealthFactorTooLow` otherwise);
4. updates the collateral list (adds "Phoenix" when `opens_venue`; removes USDC if its vault reached 0);
5. emits `MarginExecuted { spent, received, borrow_health_factor_wad }`.

After the transaction, the app reads the trader again to report the actual fill. Example output
from `scripts/e2e-perps.ts`:

```
Long SOL-PERP 2x: 3.33 SOL (~$394.86) tx=4uvQn1wCZmyS2UHc3KjKFkpeE9bQz67Ax8UZRzdG1SJh…
[SOL long] marginUSDC=800.00 phoenix=$199.x  → "Phoenix" is now a collateral line
```

If the book has nothing inside the limit, the IOC order fills 0. The USDC stays in Phoenix as
collateral, and the UI says "no fill at your price limit".

**Account segments of a Phoenix `margin_execute`.** The remaining accounts are laid out as:

```
[ CPI accounts for Phoenix ]                       ← call_account_count of them
[ collateral groups: (asset_config, vault) × n ]   ← every active collateral; the venue group is
                                                     (asset_config(exchange), margin)
[ new-asset groups ]                               ← new_assets of them
[ validator segment: market_book, exchange ]
[ oracle segment: market_book, exchange, perp_asset_map, trader, USDC price accounts,
                  + orderbook & index-price accounts of every OPEN market and the TARGET market ]
```

These transactions are large, so the app puts the static Phoenix accounts into an address lookup
table (`/api/perps/lookup-table`, cached for 120 s).

### 3.5 User flow 2: close a position

`closePerp`. Example: close the 3.33 SOL long.

**Transaction 1: reduce-only order.**

```
ix  margin_execute
      target = Phoenix
      data   = place_market_order { side: ASK (opposite of the position), price_in_ticks: limit,
                                    num_base_lots: |position|, flags: REDUCE_ONLY (128) }
      validator: reduce-only → always allowed (also for a liquidator)
```

If nothing fills at the requested slippage, the app retries once with a wider limit (up to 5%), so
a close goes through instead of leaving the position open.

**Transaction 2 (only when no position is left): bring the USDC home.**

```
ix  margin_execute → Phoenix withdraw_funds(collateral)      // trader → margin's phUSD vault
      validator: withdraw queue empty and amount ≤ withdraw budget
      venue `open` becomes false → "Phoenix" leaves the collateral list
ix  margin_execute → Ember withdraw(None)                    // all phUSD → USDC
```

Example output:

```
Close SOL-PERP long: 3.33 SOL closed                       (TSLA still open → USDC stays in Phoenix)
Close TSLA-PERP short: 0.541 TSLA closed — 299.40 USDC back in your margin account
```

If Phoenix's withdraw budget is used up, the USDC stays in Phoenix and the user can use the
**Withdraw** button later (`withdrawPerpCollateral`, the same two calls).

### 3.6 Liquidation

`vanna_credit_layer::public_liquidate(calls: Vec<VenueCall>, new_assets)` lets anyone liquidate an
unhealthy margin. For the Phoenix venue it runs the given calls in **Liquidator mode**. The
validator only allows:

- **reduce-only market orders**, to close positions; and
- **`withdraw_funds`**, with the amount forced to the trader's full collateral (the permit
  returns new instruction data).

A liquidator can never open exposure or deposit with someone else's margin. After unwinding, the
USDC is back in the margin and the normal liquidation repays the debt.

### 3.7 Where it lives in the app

| File | What |
|---|---|
| `lib/solana/phoenix.ts` | Constants, `PERP_MARKETS`, decoders (exchange, perp asset map, orderbook header, trader, withdraw budget, MarketBook), instruction builders (`marketOrderData`, `amountData`, `emberWithdrawData`, `depositAccounts`, `withdrawAccounts`, `orderAccounts`, `emberAccounts`, `registerTraderIx`), `positionEquityUsd` |
| `lib/solana/phoenix-state.ts` | `loadPhoenixVenue`: reads everything (sliced reads, statics cached 5 min) and values the venue like the oracle |
| `lib/solana/perps.ts` | `fetchPerpsView`, `openPerp`, `closePerp`, `withdrawPerpCollateral`, `fetchPerpsHistory` |
| `lib/solana/margin.ts`, `exec.ts` | Venue group in the collateral list; `marginExecuteIx` with `venue: {asset, state, targetAssetIds, opens, closes}` |
| `lib/solana/server/perps-keeper.ts` | Lookup table, fork capability grant, fork book refresh / resync |
| `app/api/perps/*` | `lookup-table`, `phoenix-access` (fork), `phoenix-book` (fork) |
| `scripts/e2e-perps.ts` | Full end-to-end test |

---

## 4. Titan swaps

### 4.1 The model

Titan is a swap **meta-aggregator**. Its API (`/api/v1/quote/swap`) returns a quote **together
with ready-to-sign instructions** for the `swap_route_v3` instruction of the Titan router. On the
Spot page, a dropdown next to "Swap" picks **Jupiter** or **Titan**. The quote and the swap both go
through the picked one (`lib/solana/aggregator.ts`, `provider`).

The API key never reaches the browser:

```
Browser ──▶ /api/titan/quote (Next.js server, holds TITAN_API_KEY) ──▶ portal.api.titan.exchange
```

For a margin swap, the quote is requested with `userPublicKey = margin PDA`. Titan then builds the
route with the margin as payer and user, which is what the validator requires.

### 4.2 What the validator allows (`vanna_validator/src/titan.rs`)

```
require mode == Owner                          // liquidators can't route through Titan
require data[0] == 42                          // swap_route_v3 only
require data[1] == 3                           // config = KEEP_OUTPUT_WSOL | KEEP_INPUT_ACCOUNT
amount = data[2..10] (u64), require > 0
fee    = data[21..23] (u16), require == 0      // no provider fee may be skimmed
require ≥ 12 accounts, accounts[9..12] == Titan program (unused optional slots)
permit: margin at accounts 0 and 1 (payer + user),
        spends accounts[3] (input vault) ≤ amount, receives accounts[4] (output vault)
```

What the config flags mean:

- **KEEP_INPUT_ACCOUNT (2):** don't close the input token account after the swap. The margin's
  vault must survive.
- **KEEP_OUTPUT_WSOL (1):** leave SOL output as wSOL in the margin's wSOL vault instead of
  unwrapping it.

Titan chooses these flags per pair (it sends 1 for a SOL input and 2 for a SOL output). The app
always rewrites the byte to 3, which only keeps the margin's vaults open, and rejects any other
bit (`lib/solana/titan.ts::marginSwapCall`).

The core program then enforces the rest (`margin_execute`):

- the spend from the input vault is ≤ `amount`;
- the output vault must have grown;
- both vaults are still owned by the margin with no delegate or close authority;
- health is OK after the swap.

**Slippage protection** is Titan's own minimum-out, which is inside the route data.

### 4.3 User flow 3: margin swap through Titan

Example: **100 USDC → SOL inside the margin** (`executeMarginTitanSwap`).

```
1  GET /api/titan/quote?inputMint=USDC&outputMint=SOL&amount=100000000
       &userPublicKey=<margin PDA>&slippageBps=100&mode=margin
   → server calls Titan with providers=Titan, closeInputTokenAccount=false,
     createOutputTokenAccount=false, outputWsol=true, dexes=<fork-safe list>
   → quote: 100 USDC → 0.8505 SOL (Whirlpool, Raydium CLMM) + instructions + lookup tables

2  The app checks the route: exactly ONE Titan instruction (plus ComputeBudget), data[0] == 42,
   config flags ⊆ {1,2} → forced to 3, margin at accounts 0 and 1.

3  Transaction:
   ix 0   ComputeBudget
   ix 1   ATA create (idempotent) for any Titan "atlas" token account the route needs
          (the margin can't pay rent, so the wallet does)
   ix 2   vanna_credit_layer::margin_execute
            target = Titan router, data = swap_route_v3 (config 3), new_assets as needed
            validator: titan::permit_for → spend USDC ≤ 100, receive SOL (wSOL vault)
            CPI: Titan runs the route, signed by the margin PDA
            core: vault checks + health check + MarginExecuted event
```

Results from `scripts/e2e-titan.ts` on the fork:

```
margin swap 100 USDC → SOL via Titan   quote 0.8505 SOL (Whirlpool, Raydium CLMM)
  tx=483m9ixmDAYwBYzsafR5G7oRCS99NNhK9K6F3C2XfiyVbimAFWisj6QLWMKouKq5mF2FqzJcNgQo72mCBqGAP7NE
  margin SOL 0 → 0.8458
margin swap 0.3 SOL → USDC via Titan   quote 35.27 USDC (Meteora DLMM, Whirlpool)
  tx=26fpoco4awEUK7X24zfYzm8L3DoRw27yYC1Z45SwcCwSNWXFzCwx7z6X7kF69GhaayEK588tzyHHvQJBQB2Sf3Ca
  margin USDC 400 → 435.27
```

### 4.4 User flow 4: wallet swap through Titan

A plain wallet swap needs no Vanna contract. The app:

1. asks Titan for a quote with `userPublicKey = wallet`;
2. builds a v0 transaction from Titan's instructions and lookup tables (fork blockhash swapped in);
3. simulates it, healing stale cloned pools and retrying if needed (same as Jupiter);
4. has the wallet sign and send it.

Example: `0.5 SOL → 58.78 USDC via Titan (Meteora DLMM)`.

> The Spot page currently swaps **inside the margin account** (the wallet path is kept but not
> exposed in the UI), so in the app Titan normally runs as flow 3.

### 4.5 Where it lives in the app

| File | What |
|---|---|
| `lib/solana/server/titan-api.ts` | Server-only Titan client (`TITAN_API_KEY` or `TITAN_API_URL`), fork DEX filter |
| `app/api/titan/quote/route.ts` | `GET /api/titan/quote`; returns 503 when Titan isn't configured |
| `lib/solana/titan.ts` | `fetchTitanQuote`, `quoteMarginTitanSwap`, `executeMarginTitanSwap`, `executeWalletTitanSwap`, `marginSwapCall` (validator pre-checks) |
| `lib/solana/aggregator.ts` | `bestSwapQuote({ provider })`, `executeSwapQuote`: the Jupiter / Titan switch |
| `components/spot/spot-nonorderbook/SwapCard.tsx` | "via Jupiter ▾" dropdown |
| `scripts/e2e-titan.ts` | End-to-end test |

---

## 5. Fork-only workarounds (hosted Surfpool fork)

The fork lazily clones mainnet accounts and then freezes them. Mainnet keepers don't run on it.
These workarounds exist **only** because of that:

| Problem on the fork | Symptom | Workaround |
|---|---|---|
| Phoenix exchange's `LastRestartSlot` (byte 1096) is from mainnet, but the fork's sysvar says 0 | "Global configuration must be active" | `alignPhoenixExchangeOnFork` (`fork-prices.ts`) rewrites it |
| Fresh trader has only place-order capabilities (`0x06`) | `CapabilityDenied DepositCollateral` | `/api/perps/phoenix-access` sets `0x3e` (fork cheatcode) |
| Orderbook and trader arenas cloned at different slots | "Failed to lookup trader at index NodePointer(n)" | One-shot `scripts/fork-phoenix-resync.ts` (copies Phoenix state at one slot). **Never run it while margins hold Phoenix positions.** |
| Orderbooks frozen, so prices drift from the index | Orders don't fill | Before each trade, `/api/perps/phoenix-book` re-clones the market's orderbook and spline via `surfnet_resetAccount` (throttled to once per 10 s) |
| Index prices frozen | Stale-price errors | `refreshForkPrices` writes fresh Pyth/Scope prices (TSLA/META use TSLAx/METAx as proxies) |
| Prop AMMs (AlphaQ, HumidiFi, SolFi, …) read per-slot keeper state | Titan swap fails with "Invalid account owner" | Titan quotes are restricted to fork-safe pool AMMs (Raydium, Raydium CLMM, Raydium CP, Orca V2, Meteora DLMM, Whirlpool), the same list as Jupiter. Override with `TITAN_FORK_DEXES`. |

---

## 6. Mainnet: what is still needed

1. **Phoenix trader capabilities.** On mainnet, a freshly registered trader can only place
   orders. Depositing collateral needs capabilities that **Phoenix grants** (onboarded traders
   have `0x3e`). Vanna needs Phoenix to grant these to margin-owned traders, which is a
   partnership or whitelisting step. The fork-only `/api/perps/phoenix-access` route must not
   exist on mainnet.
2. **Titan API key.** Set `TITAN_API_KEY` on the server (Titan Developer Platform,
   developer.titan.exchange; the free plan includes 2.5M REST requests a month). Remove the fork
   DEX restriction for mainnet so Titan can route through every venue.
3. **Index price sources for TSLA and META.** On the fork they are proxied through the TSLAx and
   METAx prices. Mainnet should list them with a proper equity index feed.
4. **Remove the fork workarounds** in §5: book refresh, LRS align, resync and the capability grant.

---

## 7. Server environment variables

| Variable | Needed for |
|---|---|
| `TITAN_API_KEY` | Titan quotes (without it, Titan shows "not set up" and Jupiter keeps working) |
| `TITAN_API_URL` | Optional: another Titan endpoint (for example a QuickNode Titan add-on URL) |
| `TITAN_FORK_DEXES` | Optional: override the fork-safe DEX list for Titan |
| `MAINNET_RPC_URL` | Fork price keeper and Phoenix book refresh/resync (a private RPC such as Alchemy is much faster) |
| `JUPITER_API_KEY` | Optional: keyed Jupiter API instead of the rate-limited keyless one |

All of these are server-only. On Cloud Run, set them once with
`gcloud run services update vanna-credit-solana-test --update-env-vars=…`. A normal
`gcloud builds submit` keeps them.

---

## 8. Testing

```bash
# from vanna-credit-backend, against the hosted fork
npx tsx --env-file=.env.local scripts/e2e-perps.ts   # open SOL long, borrow, open TSLA short, close both, history
npx tsx --env-file=.env.local scripts/e2e-titan.ts   # margin + wallet swaps through Titan, Jupiter-only quote
```

Both pass on the hosted fork as of 2026-10-07.

Typical timings:

| Action | Time |
|---|---|
| First perp open (registers the trader) | ~38 s |
| Later opens | ~25 s |
| Closes | ~21 s |
| Perps page data load | ~1.5 s |

Most of the open/close time is the fork confirming several transactions.
