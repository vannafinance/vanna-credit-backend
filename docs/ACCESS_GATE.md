# Access gate

The whole site (https://test.solana.vanna.finance) sits behind an access code. Visitors without a
valid cookie get a V3-styled "Enter access code" page; API calls get `401`. The check runs on the
server, so it can't be skipped from the browser.

## How it works

| Piece | File | Role |
| --- | --- | --- |
| Proxy (Next 16's renamed middleware) | `proxy.ts` | Runs before every route. No valid `vanna_access` cookie means pages get the gate HTML (status 401, URL unchanged) and `/api/*` gets `401 {"error":"access_required"}`. |
| Code check | `app/api/access/route.ts` | `POST {code}` (JSON, or a form post when JS is off). It compares the code with `ACCESS_CODE` in constant time, rate limits per IP, and on success sets the cookie. |
| Token, compare, config | `lib/access-gate/token.ts` | Cookie value `v1.<expiresAtMs>.<HMAC-SHA256>`. The HMAC covers the expiry and a fingerprint of the current code. |
| Rate limit | `lib/access-gate/rate-limit.ts` | In memory, per instance: 10 attempts per IP and 300 in total, per 10 minutes, then `429`. |
| Gate page | `lib/access-gate/gate-page.ts` | A standalone HTML document (not an App Router page), so no wallet, RPC or app code loads before entry. The access code is never written into it. |
| Tests | `lib/access-gate/access-gate.test.ts` | Covers tokens, the proxy and the route. |

Cookie details:
- `HttpOnly`
- `SameSite=Lax`
- `Secure` when `NODE_ENV=production`
- `Path=/`
- Lasts 30 days.

Changing `ACCESS_CODE` or `ACCESS_COOKIE_SECRET` invalidates every existing cookie, so everyone has to enter the code again.

Always open without the cookie:
- `POST /api/access`
- `GET /api/copilot/health` (uptime probe)
- `/_next/static/*` and `/_next/image`
- `favicon.ico`
- Any non-API path with a static-file extension: files in `public/` such as `/logos/*` and `/coins/*`.

## Environment variables (server-only, never `NEXT_PUBLIC_`)

| Var | Default | Notes |
| --- | --- | --- |
| `ACCESS_CODE` | `2861` | The code users type. Leading and trailing spaces are ignored. |
| `ACCESS_COOKIE_SECRET` | derived from `ACCESS_CODE` | HMAC key with 32+ random characters. Set it in production. Without it, anyone who knows the code can mint a cookie, though they could also just log in. |

Set them on Cloud Run. This only changes env vars and keeps the image and other vars:

```bash
gcloud run services update vanna-credit-solana-test \
  --region=us-central1 --project=vanna-credit-solana-test \
  --update-env-vars=ACCESS_CODE=2861,ACCESS_COOKIE_SECRET=$(openssl rand -hex 32)
```

Keeping the secret in Secret Manager is preferable. For example:

```bash
printf '%s' "$(openssl rand -hex 32)" | gcloud secrets create access-cookie-secret \
  --project=vanna-credit-solana-test --data-file=-
gcloud run services update vanna-credit-solana-test \
  --region=us-central1 --project=vanna-credit-solana-test \
  --update-env-vars=ACCESS_CODE=2861 \
  --update-secrets=ACCESS_COOKIE_SECRET=access-cookie-secret:latest
```

The runtime service account needs `roles/secretmanager.secretAccessor` on that secret.

`cloudbuild.yaml` deploys with `--image` only, so these values survive later deploys.

## Server-to-server callers

No cron jobs, Cloud Scheduler jobs or other server-to-server callers exist today.
`docs/VAULT_INTEGRATION_STATUS.md` suggests an optional hourly `GET /api/farm/vaults` to sample vault NAV.

If you add that job, it will get `401` unless you do one of the following:
1. Add the path to `PUBLIC_API_PATHS` in `proxy.ts`. It is a read-only endpoint, so this is low risk.
2. Have the job send a `Cookie: vanna_access=<token>` header. Get a token from `POST /api/access`. It expires after 30 days.

## Limits

- The rate limit is per Cloud Run instance and resets on restart. A 4-digit code has only 10,000 possibilities. The global limit of 300 per 10 minutes per instance makes brute force slow but not impossible. Use a longer `ACCESS_CODE` if that matters.
- A visitor who is being rate limited can briefly block new logins for others on the same instance. It does not affect people who already have the cookie.
- The gate follows the OS light/dark setting (`prefers-color-scheme`), not the in-app theme toggle.
- There is no sign-out button. To force everyone to re-enter the code, rotate `ACCESS_COOKIE_SECRET`.
