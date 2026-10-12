# Basis and Perena integration — 9 October 2026

This update targets the existing hosted Surfpool mainnet fork. The fork was **not reset**. No GCP application deployment or scheduler creation was performed; the application owner will deploy the backend.

## Programs and migration

- Vanna core: `H37YVBG3eGtz89ofd7iDLc2PJgn12778392XeU2QJcGC`.
- Oracle: `FXY5DRfekMUTbUp4uyCFpCZmCccrp6kPq3hTM4GRihnc`.
- Validator: `6fND3vhtstp486iE6rsSNVUox3kcjNNRsSLAN7ZPs7th`.
- Basis: `GtuQoYxzytGKtLqQGkYrVbsaPHTZN5jboP25DrSmKvGr` (existing deployment).
- Perena: `save8RQVPMWNTzU18t3GBvBkN9hT7jsGjiCQ28FpD9H` (existing fork accounts).

Core/oracle/validator were rebuilt from `feature/phoenix-titan` and installed on the existing fork. Program hashes and the initial migration are recorded in `vanna-credit-layer/deployments/hosted-fork.json`. The initial migration preserved 295 margin accounts, their debts, token balances and event sequences. Token holdings now use the protocol's global allowed-token scan; margin accounts retain active venue indexes. The scan budget is 32 positions, with 24 possible allowed-token slots, 3 active debts and 2 active venues.

All seven receipt assets and both integrations are registered. Actual vault, mint and lookup-table addresses are in `lib/solana/vault-catalogue.ts`; the document's obsolete credit-layer address is not used.

A separately approved migration preserved the old `UNCAPPED = 0` meaning as the new `u64::MAX` for 16 token configs and three reserves. The three new reserve `total_supply_shares` counters were initialized from their existing share mint supplies. It did not change liquidity, token balances, debt balances or finite limits. Old unrelated venue records were left unchanged. The migration script is dry-run by default: `vanna-credit-backend/scripts/migrate-legacy-reserve-state.ts` (it lives in this repo, not in vanna-credit-layer). Do not rerun the initial program migration on already migrated state.

## Application behavior

- `/farm`: Perena USD* and Junior under Lending/Single Assets; five live Basis vaults under Delta-Neutral.
- `/farm/basis/{sol,eth,btc,tsla,meta}` and `/farm/perena/{usdstar,junior}`: live NAV/share price, receipt holdings, positions, history and simulated deposit/withdraw previews.
- Every deposit uses margin-account USDC. ETH/BTC/TSLA/META and Perena execute from the margin account via `margin_execute`.
- SOL Basis (since 11 October 2026) also deposits from the margin account, but routed through the wallet because the deployed vault program cannot take that deposit through `margin_execute` (Phoenix ReallocTrader). See "October 11: SOL Basis deposits from margin" below. The earlier wallet-USDC / two-approval flow is gone.
- Withdrawals use margin shares and pay USDC. SOL can partially burn the requested shares when Phoenix only releases part of the collateral; the preview shows the actual burn and payout.
- Basis minimum output is set from simulation with a 0.5% allowance. Perena has no minimum-output parameter; its simulated payout includes fees. Junior instant withdrawals include its 1% exit fee.
- Quotes are rebuilt after pool healing. Phoenix market data is refreshed together before Basis calls. Simulation failures stop before the deposit/withdraw wallet approval.
- A reusable wallet lookup table may require an initial setup approval for large transactions. The shared table contains only static protocol accounts.
- History reads the latest CPI events. SOL Basis deposits use confirmed token balance changes of the wallet and its margin account together when long transaction logs omit the final event.

## Fork-specific data

The existing price keeper and targeted DEX/Phoenix market-account refreshes are fork adapters, not mainnet transaction logic. They do not reset the fork or user positions. Perena's cloned NAV price remains unchanged; its timestamp is aligned to the fork clock so the test oracle can value the receipt. This is **not a fresh mainnet NAV feed**.

APY is not fabricated. The API records at most one valid share-price observation per vault per hour in the existing durable store (`farm_vault_nav`). Seven- and thirty-day APYs remain empty until sufficient observations exist. Configure an hourly GET to `/api/farm/vaults` in your deployment if continuous sampling is desired; otherwise observations are collected on page/API access. No Cloud Scheduler job has been created. Production storage uses the existing `COPILOT_FIRESTORE_PROJECT`, database and store secret configuration. History storage failure does not block current NAV reads.

## Build and deployment handoff

The backend vendors `@vanna/phoenix-vault-client` in `vendor/vanna-phoenix-vault-client-0.1.0.tgz`. Docker copies this directory before `npm ci`; include it and the updated lockfile in the deployment. No client API keys were added.

```bash
npm ci
npx tsc --noEmit
npm test
npm run build
```

The existing `cloudbuild.yaml` remains available for the owner to deploy. Deploy the updated application with its current environment/secrets so it uses the upgraded core ABI. Do not deploy the old IDL/client against the upgraded program.

## Reproduce fork tests

Run the local app on port 3100, then:

```bash
E2E_VAULT_BORROW=1 node --import tsx scripts/e2e-vaults.ts \
  perena-usdstar perena-junior basis-sol basis-eth basis-btc basis-tsla basis-meta
node --env-file=.env.local --import tsx scripts/e2e-fork.ts
```

Tests create new isolated fork wallets and use the fork faucet. They do not spend existing user wallet funds. The vault script now repays its test loan after the round trips. Earlier failed diagnostic wallets can retain test-only receipt balances/loans.

## Verified vault round trips

Each row used a 10 USDC deposit. The successful retests below had an outstanding USDC loan (SOL's first transaction is wallet-funded). These are test executions at their observed market prices, not guaranteed future quotes.

| Vault | Withdrawal signature | Simulated USDC received |
| --- | --- | ---: |
| Perena USD* | `36EKmwZEbmmFcwcboQ1LzJyGt4JNnXS4x2rBRVeb21BAzAJEX8HQSK3iSaP4NxkxgjQQLrcMxDdLoU6ReptiVJt6` | 9.994999 |
| Perena Junior | `7Pe6at9Yqwz1Cq4y3Pd6ifkzfwP63ZsX3YsK4Jyb269zMdguWvUmgXWAS2pUtWvbPeHNb5FyQvXpFFsuuop6ka8` | 9.899999 |
| SOL Basis | `5VXLBWFKGqDu1RjVywAdihpFgKRgBj2M45fbHEP3XRFL8MUoaaczJBQ4Lav7Hdh6KhpWKcrqutv3RbwpvLJqkEjS` | 9.990344 |
| ETH Basis | `i5QAxwKWQ1rY3d4Y73ZYDeYYjrPgWfVuF73DriLEtkUXJjG1i8zLpD6BKTXaTeixqWTFcM5kKTX2eypZH8ZZDXk` | 10.001604 |
| BTC Basis | `4SPfBtmQhAeKCBBN7AmXw27fHedroJvPuHEDiuiY99erwqVLKN55YxgXxwKVywkZr6aCQZbPyDFP14wZXPynPsKg` | 9.987585 |
| TSLA Basis | `5xobJaHEZXtndP32XPxNk5gJw7C5TTLeDfqg3qmiHCcNB8Uy8Uc9iMsV4ibWR33BKtDXWighUoGfh7LukibBZsV7` | 9.983982 |
| META Basis | `5gjEkm1agpj2VxkdeRbey6Vf8wi4nL58VC1S7WR2kCqbcT4atd4SrZ8T1iLxS2EbvNnu9WYdoHqTQNG2rSYZRVdH` | 9.980313 |

## Final validation

- TypeScript check and Next.js production build passed.
- Frontend/service suite: **601 passed, 18 skipped**. The skipped tests include optional live Copilot/MCP checks; they are not claimed as passing.
- Targeted Rust regression: allowed-token limits (10), full flow (1), security (8), account state (3) passed. The earlier Perena (18) and Basis (20) integration suites also passed.
- Existing app fork E2E passed: Earn supply/redeem, margin creation, collateral deposit, SOL cross-asset borrowing, refusal of borrowing a collateral-only token, dual USDT/USDC borrowing, repayment, collateral withdrawal, history and wallet reads.
- All seven vault deposit/withdraw paths passed on isolated loan-backed fork accounts, with on-chain transaction signatures above. SOL's wallet deposit history was verified after adding the truncated-log fallback.
- Browser checks at desktop and mobile widths found no JavaScript exceptions or horizontal page overflow. Light-theme contrast and shared-theme styles were corrected.
- New integration files pass ESLint; whitespace/diff checks pass.

Migration rollback records are retained under the ignored `vanna-credit-layer/deployments/backups/` directory. The approved legacy-state migration plan is saved in `vanna-credit-layer/deployments/legacy-state-migration.json`.

## October 10: stale Perena snapshot and Basis market sessions

Perena `7009 / StaleOracle` was caused by incomplete fork clock maintenance.
The existing keeper updated receipt NAV timestamps but left the separate consensus
oracle and underlying holding-price caches at the old snapshot time. A fresh NAV
alone does not make those other price caches fresh.

The hosted-fork adapter now validates the known Perena layouts and aligns:

- Receipt NAV timestamps (existing behavior).
- `VaultOracle.data.settled_nav_ts`: account byte 56.
- Active priced `Vault.holdings[i].last_update_ts`: byte `2256 + 184*i + 40`.

Offsets were checked against the published `@perena/vault-sdk` 1.0.56 IDL and
live account sizes/discriminators. Regression tests verify that prices, amounts,
signer reports and staleness limits do not change. Calls share one in-flight
refresh. This is exclusively a cloned-snapshot clock adapter for
`rpc-devnet.solana.vanna.finance`, **not a mainnet oracle update** and not evidence
that Perena's economic NAV is current. Real mainnet operation requires Perena's
normal oracle/keeper updates. No fork reset or market restriction changes occur.
If simulation still returns Perena's stale-oracle error, preview forces one
refresh/retry and then displays an actionable message without submitting funds.

Basis `6015 / MarketAfterHours` is an intentional deposit restriction. The app
reads Phoenix's after-hours and reopening flags, respects the vault's
`afterHoursDeposits` setting, and exposes `marketAfterHours` and
`depositBlockedReason` in the vault API. Closed deposits are disabled in the UI
and rejected before transaction-table setup/signing. A simulation-time session
change also produces a readable message. Withdrawals retain their existing
contract/liquidity checks; they are not disabled merely because deposits close.
The live fork confirmed TSLA/META closed while SOL/ETH/BTC were open.

GCP deployment remains the owner's responsibility; these changes were not deployed.

Validation for this fix: 630 tests passed, 18 optional tests skipped; TypeScript,
ESLint and production build passed. Isolated fork wallet
`6x7CRFDPzGj31iyDCSpmVVNXwFrEGPd7cUXL5q4WEkSP` completed both round trips:

| Vault | Deposit signature | Withdrawal signature | USDC returned from 10 USDC deposit |
| --- | --- | --- | ---: |
| USD* | `61QscFA7kfDSrQpZmMNUGDeGkV89X8HUTLTEg7ssksdEuxctCHzdFBED1LJyDgnK9r2EX5eM8Yvj4v5Aq2EXaRdV` | `5Hg4AFZuJRLVbnK13vfJBVbd1nXmKo9YtyVXRqKNxh5HPMV7Mxd3PY9xFC4sYttzWVeL2DqfPhLudMQW5QFdBtVt` | 9.994999 |
| Junior | `23UdLyZC4hYKo46n4mRXvtqb4mPFBvUJKbtDNFzUEgKXtjxwPJqqq9pFwDcXMF4d79ugEksvc9Y7QPaQQQ2kRcDG` | `3PmCb31o5wZuArAD1yGZhNdqs54NCmA2ykomMeCWgxY3RRyyJySVP4mPCJ8gF9FPou6CsCuubmZs3KYPbTqZnVGf` | 9.899999 |

An earlier test attempt hit the Surfpool upstream provider's HTTP 429 rate limit;
the subsequent attempt passed. These changes do not eliminate upstream provider
availability/rate limits. No existing user funds were used.
TSLA and META deposit previews were also exercised against the live fork with a
signer that throws if called: both returned the friendly market-session message
before any signing callback.

## October 11: SOL Basis deposits from margin

The SOL Basis deposit form now shows and spends **margin USDC**, like every other vault. One
transaction, one wallet approval (`prepareVaultAction` / `submitVaultAction` in
`lib/solana/vault-actions.ts`):

1. `user_withdraw_collateral`: the USDC amount from the margin account to the wallet's USDC
   account (created idempotently). With debt it is health-checked with the full position accounts
   (`buildHealthRemainingAccounts`, USDC's own group excluded), exactly as a normal collateral
   withdrawal.
2. The SOL Basis vault `deposit` from the wallet (`min_shares` = simulated shares − 0.5%).
3. `user_deposit_collateral`: vbSOL from the wallet into the margin account — wallet vbSOL already
   held + `min_shares`.

The transaction is atomic: if any leg fails, nothing moves. Before the signature the app simulates
legs 1–2 (shares minted, `CollateralWithdrawn` health factor) and `sendInstructions` simulates the
exact signed transaction again. Lookup tables are sized for the full transaction.

- **Health factor.** The USDC leaves the margin before the vbSOL returns, and the program checks the
  health factor at that point. A leveraged account can therefore be refused even though its final
  state would be healthy. The panel shows an estimated "Health factor while USDC moves" (collateral
  minus the deposit, over debt) with a warning at or below 1.10; a simulation refusal shows
  "SOL Basis moves this USDC out of your margin account before the vault deposit, and that would
  push your health factor to or below 1.10…" before any approval.
- **Leftover vbSOL.** Leg 3 must be sized before the transaction lands, so it moves the guaranteed
  minimum. Shares minted above it (about the 0.5% slippage allowance when the fill matches the
  simulation) stay in the wallet. The success message reports them; the "Move … vbSOL to margin"
  recovery button moves them, and the next SOL Basis deposit sweeps them automatically.
- Measured on the fork: ~783k CU of the 1.4M limit and 101 loaded accounts (13 static + 88 from
  lookup tables) for a margin with a USDC loan. Margins with many positions add health-check
  accounts; a transaction above the account limits fails in simulation without moving funds.

Validation: `E2E_VAULT_BORROW=1 node --env-file=.env.local --import tsx scripts/e2e-vaults.ts basis-sol basis-eth`
(the script now asserts margin USDC −10, wallet USDC unchanged, receipt in margin, a clear refusal
of an unhealthy 100 USDC SOL deposit, and deposit + withdraw history rows). Isolated fork wallet
`TAwvoc4G6sD4J6SepyicKiPRYUAPbqRLPvpXeMaDqw9` with a 20 USDC loan:

| Vault | Deposit signature | Withdrawal signature | USDC returned |
| --- | --- | --- | ---: |
| SOL Basis | `4Uh61JmFFroMMUHDTUyvrwSuBFQ12n8sKyBzErHVZ76S3H685sagLZ96ayiQ7mJfM1rYkCdPFv9tT9eKGYdNu6Eu` | `2v3FzQZfgV11R966JLdwpY6toXEt7czRb3tJMdtZMCBpquMgxp8pzuNGkMpYaJb1iRE6aUxXF6TPXMLzEnTecfug` | 9.934913 (for the 10.12349 vbSOL moved to margin; 0.050872 stayed in the wallet) |
| ETH Basis | `2h4kBjaHDq7o4EwDCe1EM4qRXLQ3ekhpczzV42mkdrVYVBsHgHPgYyA7c5s9BDN222H3Z5TGQbV42NzHA2YoxoNr` | `5HubSggN1UPKvRFb4g1Jsdbsd4QLEVyd4Tsj3ynVBJwUKwEatY1hAXhWHDqqe1R7f1pVi75QvjRUC3pMS4efc1Hk` | 10.027734 |

Not deployed; the application owner deploys.
