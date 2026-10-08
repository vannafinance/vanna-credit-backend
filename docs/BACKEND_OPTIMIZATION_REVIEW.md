# Backend reliability and performance review

Date: 2026-10-08

Changes are local to `vanna-credit-backend`; the deployed Cloud Run service and Surfpool VM were not modified. The review focused on API reads, browser data loading, shared Solana services, transaction submission/confirmation, fork keepers, and the Copilot build path. Relevant credit-layer freshness/health checks were consulted; this is not a full Rust security audit.

## Findings and fixes

| Finding | Change | Main files |
| --- | --- | --- |
| RPC calls could wait indefinitely; account reads multiplied transport retries by another four attempts | Bounded RPC transport, at most two read retries, removed the nested account retry loop; writes are not automatically replayed | `lib/solana/connection.ts`, `lib/async.ts` |
| Browser wallet-provider connection bypassed the custom RPC transport | Both connection paths use the same timeout/retry policy; stable provider config | `contexts/solana-provider.tsx` |
| Confirmation's outer 60-second loop did not bound an individual stalled RPC | Deadline covers status and height reads; transient errors remain pending; processed transactions are not declared expired solely because their blockhash expired | `lib/solana/confirmation.ts` |
| A lost broadcast response could be shown as a failed transaction even if it landed | Recover using the signature already present in the signed bytes; no replacement transaction is sent | `lib/solana/broadcast.ts` |
| Simulation/healing consumed blockhash validity before the wallet opened | Replace the simulation blockhash and fetch a fresh signing lifetime afterwards, including Jupiter and Titan wallet swaps | `lib/solana/tx.ts`, `swap.ts`, `titan.ts` |
| An unresponsive wallet extension could leave the action pending forever | Two-minute signing deadline; wallet identity/disconnection checks during unlock recovery; late signatures do not continue broadcasting | `lib/solana/wallet-bridge.ts` |
| Spot swaps did not propagate transaction stages to the progress popup | Wire simulation/signing/sending/confirmation callbacks through aggregator executors | `components/spot/spot-nonorderbook/SwapCard.tsx` |
| A previous success timer could close the next action's popup | Cancel outdated completion timers, reset completion state, preserve the network start time | `lib/tx-progress.tsx` |
| Post-confirmation refreshes kept mutations pending and could overwrite success with a read error | Refresh balances and queries in the background after confirmed success | Earn, Margin, Farm, Perps hooks and account creation store |
| Pools, asset configuration, clock, wallet and margin reads were repeated concurrently | Share only in-flight reads, scoped by connection or wallet; settled financial state is not retained by these helpers | `protocol-state.ts`, `connection.ts`, `balances.ts`, `margin.ts` |
| Root hydration fetched account state independently of page queries and wallet hooks | Hydrate wallet/margin stores from the shared account query; remove redundant connect-time prefetch/direct reads | `components/margin-account-hydrator.tsx`, `hooks/use-wallet.ts`, `use-account-snapshot.ts` |
| Perps had both a six-second poll and ledger-tick invalidations | Keep one polling schedule; periodic invalidations elsewhere do not cancel/restart an active read | `hooks/use-perps.ts`, Earn/Margin/account/price hooks |
| Slow slot fallback polls could overlap | Allow one HTTP slot poll at a time | `contexts/ledger-subscriber.tsx` |
| History scanned up to 200 transaction bodies on every refresh | Cache finalized transaction logs for five minutes, maximum 1,000 entries; concurrent scans share work; missing transactions remain retryable and mark history incomplete | `lib/solana/history.ts` |
| Every browser mount could rewrite all fork oracle accounts | Share refresh work per server process and reuse successful refreshes for 30 seconds; skip hidden-tab keeper calls | Price refresh route and provider |
| Fork refresh failures could leave already-started writes unobserved | Build write tasks after prerequisites; at most four price tasks at a time; wait for started work before releasing refresh locks | `lib/solana/server/fork-prices.ts`, price refresh route |
| Phoenix book refresh cached its timestamp before succeeding and let concurrent callers skip unfinished work | Share refreshes per endpoint/market and record success only after both reset requests settle | `lib/solana/server/perps-keeper.ts` |
| DEX healing counted failed HTTP/JSON-RPC responses as successful resets | Count only successful reset responses | `lib/solana/fork-heal.ts` |
| Jupiter/Titan proxies, transaction prerequisites and browser API reads lacked deadlines | Add bounded fetches; preserve existing explicit shorter timeouts | API proxies and Solana services |
| Build tracer included the whole repository through a development journal path | Exclude the runtime-only development data path from Turbopack asset tracing | `lib/copilot/store.ts` |

New submissions check the recent signature cache first, using historical lookup during recovery. This follows the [Solana getSignatureStatuses API](https://solana.com/docs/rpc/http/getsignaturestatuses). Confirmation timeout means the outcome is unknown, not that funds definitely did not move; the error retains the signature and tells the user to check before retrying.

## Verification

- `npm test -- --reporter=dot`: **587 passed, 18 skipped**. Forty new tests cover transport retries, deadlines, confirmation races, ambiguous broadcasts, wallet errors, blockhash refresh, history work, refresh locking and popup timers. Live Copilot tests require its external MCP service and were skipped.
- `npx tsc --noEmit`: passed; production build also completed TypeScript checking.
- `npm run lint`: **0 errors, 114 warnings** (existing unused-variable/typing/image patterns remain).
- `npm run build`: passed. The whole-project tracing warning is resolved. The native bigint binding is unavailable locally, so its supported JS fallback is used.
- `git diff --check`: passed.
- History regression: two scans of 200 finalized signatures fetch transaction bodies **200 times total**, instead of 400; a subsequent warm scan still fetches the latest signature list.
- RPC account-read retries: previously up to 5 transport attempts × 4 account-helper attempts; now at most **3 transport attempts**, before any separate React Query retry.

Read-only observations (single samples, not a load test or before/after benchmark):

| Target | Result | Time |
| --- | --- | --- |
| Hosted RPC `getHealth` | HTTP 200, no JSON-RPC error | 0.90 s |
| Deployed `/api/pools` | HTTP 200; 10 registry rows, 3 initialized pools | 0.74 s |
| Deployed `/api/prices` | HTTP 200; 10 prices, none marked stale | 0.51 s |
| Updated local production `/api/pools`, using hosted fork | HTTP 200 | 1.32 s |
| Updated local production `/api/prices`, using hosted fork | HTTP 200; no stale entries | 1.71 s |
| Updated local `/api/account/<system-program-address>` | HTTP 200; no margin account | 8.96 s first request, 1.76 s repeat |

The synthetic no-margin account test is useful for missing-account behavior, not a substitute for an active customer's portfolio. The first/repeat difference is consistent with cold fork/upstream work; VM logs are required to establish its cause. A separate concurrent read-only probe measured wallet 0.96 s, pools 1.21 s, margin 1.74 s, prices 2.26 s.

## Configuration and operational limits

- Local environment has Jupiter/Titan keys and a mainnet RPC configured. Public and server fork RPC hosts match the supplied hosted fork. Secret values were neither printed nor changed. Hosted runtime configuration was not accessed.
- No signed transactions, faucet calls, oracle writes, Phoenix resets, deployments, or VM changes were executed during verification. Confirmation and wallet failure paths were tested with mocks.
- In-flight sharing, refresh throttling and history caches are per process/browser, not distributed locks. Multiple Cloud Run instances can still run keepers independently. Higher traffic needs a dedicated keeper or distributed coordination and VM-side measurement.
- Fork resets, upstream rate limits, wallet delays, changing liquidity, slippage and on-chain health checks can still reject legitimate transactions. These changes do not guarantee zero errors or establish maximum supported load.
- Existing fork-only price fallback/restamping and cheatcode mechanisms remain. They are test-fork infrastructure, not production oracle behavior.
- Before release, verify actual wallet flows for supply/redeem, collateral/borrow/repay, Jupiter/Titan swaps and Phoenix/Kamino actions with representative funded accounts. No automated UI/wallet end-to-end claim is made here.

## Repeat the read-only diagnosis

```sh
npm test
npm run lint
npm run build
npx tsx scripts/diagnose-backend.ts
# Optional: inspect an actual wallet's read latency without signing anything.
npx tsx scripts/diagnose-backend.ts <public-wallet-address>
```

The diagnostic loads the local environment, prints only the RPC hostname and operation timings, and never signs transactions or changes fork state.
