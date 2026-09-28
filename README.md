# Vanna Credit — Solana app

The Vanna web app for Solana: Portfolio, Earn, Margin, Swap, Farm and a testnet Faucet. It runs against the [`vanna-credit-layer`](https://github.com/vannafinance/vanna-credit-layer) program on a Surfpool mainnet fork.

| | |
|---|---|
| Network | Hosted Surfpool mainnet fork: `https://rpc-devnet.solana.vanna.finance` |
| Program | `H37YVBG3eGtz89ofd7iDLc2PJgn12778392XeU2QJcGC` (`vanna_lending`) |
| Assets | SOL, USDC, USDT, JitoSOL, JupSOL (the real mainnet mints) |
| Stack | Next.js 16, React 19, Tailwind v4, zustand, react-query, Anchor 0.32 client, Solana wallet adapter |

## Run

```bash
npm install
cp .env.example .env.local   # then set JUPITER_API_KEY (https://portal.jup.ag)
npm run dev                  # http://localhost:3000
```

Connect Phantom, Backpack or Solflare with a **custom RPC** set to `https://rpc-devnet.solana.vanna.finance`. Then open **Faucet** in the navbar: it gives 1000 of each token.

## Pages

| Page | Route | What it does |
|---|---|---|
| Portfolio | `/portfolio` | Wallet, margin, collateral and debt totals. The **Lender** tab shows Earn positions, history and earned interest. The **Trader** tab has Margin, Spot and Farm sub-tabs. |
| Earn | `/earn`, `/earn/[symbol]` | Supply to and withdraw from Vanna's lending pools (`lender_supply` / `lender_redeem`). APYs come from the program's own rate curve. |
| Margin | `/`, `/margin` | Create a margin account; deposit (WB = from wallet, MB = margin balance); borrow (single, dual, cross-asset) with a leverage slider; repay from the wallet or from margin; withdraw collateral. |
| Swap | `/trade/spot` | Jupiter swaps. **WB** swaps from the wallet. **MB** swaps inside the margin account via `margin_execute`, and the program health-checks it after the swap. |
| Farm | `/farm`, `/farm/[symbol]` | Single-asset Kamino Lend vaults. In one transaction you supply from the wallet or margin balance, borrow the same asset for up to 5x leverage, and supply the total to Kamino. The cTokens stay in the margin account and count toward its health factor. |
| Faucet | navbar popup | Adds 1000 of each token via fork cheatcodes. |

Kamino **multi-asset** (Kamino Liquidity) strategies are not offered. That program rejects CPI (`CPINotAllowed`, verified on the fork), so a margin account can never hold their shares.

## How it talks to the chain

- **`lib/solana/`** is the service layer. Pages and hooks call only this.
  - `lend.ts`: Earn.
  - `margin.ts`: margin account, deposit, borrow, repay, withdraw, and the exact health-scan `remaining_accounts`.
  - `exec.ts`: `margin_execute` for Jupiter swaps and Kamino supply/redeem.
  - `kamino.ts`: receipts and cToken valuation, an exact port of the program's.
  - `history.ts`: history decoded from the program's events.
  - `tokens.ts`: the single token registry.
- **Everything is read from chain.** There is no indexer and no browser storage for data. History comes from `getSignaturesForAddress` plus `getTransaction`, one request per signature, with the program's events parsed from the logs.
- **Server routes** (`app/api/*`) do the fork-only work:
  - `prices/refresh`: the price keeper. It rewrites each Pyth `PriceUpdateV2` with the live Jupiter USD price, stamped with the fork clock. It also heals Kamino reserves whose `last_update.slot` is ahead of the fork.
  - `faucet`: uses `surfnet_setTokenAccount`.
  - `jupiter/*`: Jupiter proxy with the API key.
  - `farm/pools`: Kamino's live metrics.
  - `pools`, `account/[addr]`, `prices`.

Fork quirks the code handles:
- Pyth prices go stale after 3600s, so they are refreshed before every risk-checked transaction.
- The fork's clock is ahead of wall time, so prices are stamped with the fork clock.
- The hosted fork's slot is behind mainnet, which breaks freshly cloned Kamino reserves; the price keeper heals them.
- `getProgramAccounts` is rate-limited upstream, so asset configs are read by PDA instead.
- Cloned DEX pools can go stale; they are re-cloned via `surfnet_resetAccount`.

## Tests

```bash
npx tsc --noEmit && npm run lint && npm run build
npx tsx --env-file=.env.local scripts/e2e-fork.ts   # faucet → Earn (5 assets) → margin: cross-asset + dual borrow, repay, withdraw
npx tsx --env-file=.env.local scripts/e2e-exec.ts   # margin swaps via Jupiter, leveraged Kamino farm deposit / withdraw
```

Both scripts drive the app's own service layer with a fresh keypair on the fork.

## Fresh fork

The protocol setup (pools, Kamino receipts, integrations, prices) lives in `vanna-credit-layer/scripts/bootstrap-fork.sh`. It defaults to the hosted fork; for a local Surfpool, set `DEVNET_RPC_URL=http://127.0.0.1:8899`.
