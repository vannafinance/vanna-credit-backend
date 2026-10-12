# Liquidator bot

Finds Vanna margin accounts at or below the liquidation line (HF ≤ 1.10) and liquidates them with
`public_liquidate`, paying the debt from its own wallet and taking the collateral plus the bonus.

Liquidation rules come from the deployed program: `vannafinance/vanna-credit-layer`, branch
`feature/phoenix-titan` (not `main`), `instructions/account_manager/liquidate.rs`. The quote math and
the instruction builder are in `lib/solana/liquidate.ts`.

## What it can liquidate

Everything the deployed program can liquidate, each proven on the fork by `scripts/e2e-liquidate.ts`:

| Collateral | How | Strategy | e2e scenario |
|---|---|---|---|
| SPL tokens (USDC, USDT, SOL, LSTs, JupUSD) | seize from the margin vault | `token` | `usdc`, `sol-debt`, `sol-collateral`, `usdt-debt-lst` |
| Token-2022 xStocks (bonus 7%) | seize | `token` | `token2022-xstock` |
| Kamino receipts (cTokens) | seize the receipt | `token` | `kamino-receipt` |
| Vault receipts (Basis / Perena) | seize the receipt | `token` | `vault-receipt` |
| Phoenix perps (venue) | close every position + withdraw + seize phUSD, one instruction; phUSD unwrapped to USDC after | `phoenix` | `phoenix` |

The program only allows venue calls in a liquidation for Phoenix (close within the validator's
band around the index, and withdraw). Kamino, Basis, Perena, Jupiter and Titan positions sit in the
margin as receipt tokens, so they are seized like any token. Seized receipts stay in the liquidator
wallet (redeeming them is a treasury step; Basis / Perena withdrawals can be delayed).

Not the bot's job: bad debt (collateral ≤ $1 and below the debt) is cleared by the admin with
`admin_write_off`. Once an account is above HF 1.10 the program refuses further liquidation.

Partial liquidations: above HF 1 + bonus and with debt over $100, one call repays at most 50%. At an
HF close to 1 + bonus a partial call barely moves the HF, so an account can take several rounds
(each loop does up to `MAX_ROUNDS_PER_ACCOUNT`, the next loop continues).

## Run locally

```bash
LIQUIDATOR_KEYPAIR_PATH=./my-keypair.json npx tsx bot/liquidator/index.ts
```

It starts in dry-run mode: it logs what it would liquidate and sends nothing. `DRY_RUN=false` sends.

Fork e2e, every scenario (or name some: `usdc phoenix ...`):

```bash
npx tsx scripts/e2e-liquidate.ts
```

Test the running bot against a liquidatable account on the fork:

```bash
npx tsx scripts/e2e-liquidate.ts --setup-only <bot wallet address>
```

That leaves one liquidatable account and funds the bot wallet with every lendable token.

## Settings (environment)

| Variable | Default | Meaning |
|---|---|---|
| `LIQUIDATOR_KEYPAIR` / `LIQUIDATOR_KEYPAIR_PATH` | — | Keypair JSON (solana-keygen format) or base58, or a path to the file |
| `DRY_RUN` | `true` | Only `false` sends transactions |
| `POLL_MS` | `15000` | Pause between loops |
| `BOT_SHARD_INDEX` / `BOT_SHARD_COUNT` | `0` / `1` | Several bots: same count, different index. Each account belongs to one bot |
| `MIN_PROFIT_USD` | `1` | Skip liquidations whose bonus is below this |
| `SLIPPAGE_BPS` | `50` | `min_seized` allowance under the quoted seize |
| `VENUE_SLIPPAGE_BPS` | `200` | Same, when venue calls run first (a close realizes PnL at the fill) |
| `MAX_ROUNDS_PER_ACCOUNT` | `5` | Calls per account per loop (partial liquidations repay ≤ 50%) |
| `FAILURE_COOLDOWN_MS` | `120000` | After a failed send, leave the account alone this long |
| `FORK_PRICE_REFRESH` | `true` | Fork only: rewrite fork prices before liquidating |
| `MIN_SOL_BALANCE` | `0.05` | Warn below this SOL balance |
| `STRATEGIES` | all | Comma-separated strategy names |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_BOT_TOKEN_PATH` | — | Telegram bot token, or a file holding it (on the VM: secret `liquidator-telegram-token`) |
| `TELEGRAM_CHAT_ID` | — | Group to alert. Without token + chat ID, no alerts are sent |
| `TELEGRAM_ALLOWED_CHATS` | — | Extra chat ids (comma-separated) allowed to use the read-only commands |
| `SKIP_COOLDOWN_MS` | `60000` | After a round with nothing worth doing (dust, dry run), re-plan the account after this long |
| `FORK_AUTO_FAUCET` | `false` | **Fork only.** Refill every borrowable token from the fork's cheatcodes when it runs low. Never on mainnet |
| `FORK_FAUCET_MIN` / `FORK_FAUCET_TARGET` | `100000` / `1000000` | Refill a token under MIN units up to TARGET units |

## Scale

A loop does not read every account. Prices are read once; every tracked account is re-valued in
memory at those prices; only accounts that are due are read from chain (`scheduler.ts`): new ones,
liquidatable ones and HF ≤ 1.15 every loop, HF ≤ 1.3 every 30 s, ≤ 1.6 every 2 min, ≤ 3 every
5 min, the rest every 15 min, Phoenix holders at least every minute, and any account the moment
its in-memory estimate drops to 1.15. This is safe because an account cannot make itself
liquidatable (borrow, withdraw and margin_execute are health-checked): only prices and interest
move it below the line. Discovery is the analytics registry (recent program transactions); for
tens of thousands of accounts on mainnet, discover with `getProgramAccounts` on a provider that
allows it.

## Telegram commands (read-only)

`/stats`, `/risky [n]`, `/liquidatable`, `/top [n]`, `/account <address>`, `/wallet`, `/help`,
answered from the last loop, only to allowed chats. Shard 0 polls (one poller per bot token).

## Telegram alerts

Send-only: the bot takes no commands from Telegram. It posts when it comes online or stops, every
landed liquidation (with a transaction link), and once a day a summary. It also posts problems,
each subject at most once an hour: an account it cannot repay (wallet has none of the debt token),
an account no strategy can act on, a failed liquidation, a failing loop, a low wallet. In dry run,
"would liquidate" messages are tagged `[DRY RUN]`. Heartbeats stay in the logs.

If the bot or its VM dies it cannot report that itself: a Cloud Monitoring alert on missing
heartbeat logs covers it.

The wallet must hold every borrowable token (SOL, USDC, USDT): a debt in a token the wallet does
not hold cannot be repaid. The heartbeat warns about missing tokens, and an account the bot cannot
repay is logged as an `ERROR`.

## Extending

- **New venue** (the program adds liquidation calls for another integration): add a strategy in
  `strategies/` like `phoenix.ts` that returns a `LiquidationAction` with the unwind calls in
  `request.venue` (`VenueUnwind` in `lib/solana/liquidate.ts`), list it in `strategies/index.ts`,
  and add an e2e scenario. The bot runs the most profitable action any strategy proposes.
- **Work after a liquidation** (swap or redeem seized collateral, notify a channel): add a hook to
  `HOOKS` in `hooks.ts` (today: `unwrap-phusd`, `telegram`).

The per-account logic is `engine.ts`, shared by the bot loop and the e2e. Neither changes for a
new strategy or hook.

## Deploy (GCE VM, runs 24/7)

Project `vanna-credit-solana-test`, zone `us-central1-a` (same zone as the fork VM
`vanna-surfpool-devnet` in project `solana-defi`).

| Piece | Name |
|---|---|
| Image | `us-central1-docker.pkg.dev/vanna-credit-solana-test/vanna-credit/liquidator:<tag>` |
| VM | `liquidator-bot` (e2-small, Debian 12) |
| Service account | `liquidator-bot@…` (log writer, image reader, reads its own secret) |
| Keypair | Secret Manager `liquidator-keypair` |

On every boot, `deploy/startup.sh` installs Docker, copies the keypair from Secret Manager into
tmpfs, pulls the image and runs it with `--restart=always`. Logs go to Cloud Logging.

Build a new image:

```bash
gcloud builds submit . --project=vanna-credit-solana-test --region=us-central1 --config=bot/liquidator/deploy/cloudbuild.yaml --service-account=projects/vanna-credit-solana-test/serviceAccounts/vanna-credit-builder@vanna-credit-solana-test.iam.gserviceaccount.com --substitutions=_TAG=<tag>
```

Change the image or settings, then reboot to apply. `liquidator-env` is a file of `KEY=VALUE` lines:

```bash
gcloud compute instances add-metadata liquidator-bot --project=vanna-credit-solana-test --zone=us-central1-a --metadata=liquidator-image=<image> --metadata-from-file=liquidator-env=bot.env
```

```bash
gcloud compute instances reset liquidator-bot --project=vanna-credit-solana-test --zone=us-central1-a
```

Logs:

```bash
gcloud logging read "resource.type=gce_instance AND jsonPayload.container.name=/liquidator" --project=vanna-credit-solana-test --freshness=1h --limit=50 --format="value(timestamp,jsonPayload.message)"
```
