# Integrations: where the keys go

This is the shared deployment procedure for the [operator guides](operator-guide.md). Provider setup, application policy and deployment are separate steps: a credential saved in GitHub has no effect on a running instance until its deployment installs it.

## Configuration inventory

| Integration | Runtime configuration | Provider guide |
| --- | --- | --- |
| Native Apple identity | `APPLE_CLIENT_ID` | [Apple](apple-setup.md); browser setup has separate availability constraints |
| Google identity | `OIDC_GOOGLE_CLIENT_ID`, `OIDC_GOOGLE_CLIENT_SECRET`, Worker `OIDC_REDIRECT_ORIGIN` / container `APP_BASE_URL` | [Google](google-sign-in-setup.md) |
| Worker error reporting | `SENTRY_DSN` | [Sentry](sentry-setup.md), including separate CI source-map credentials |
| QuickBooks Online | `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET`, `QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN`, `QUICKBOOKS_ENVIRONMENT` | [QuickBooks](quickbooks-setup.md) |
| Wise | `WISE_TOKEN`, `WISE_PROFILE_ID`, `WISE_WEBHOOK_PUBLIC_KEY` | [Wise](wise-setup.md) |
| Deel time sync | `DEEL_TOKEN`, `DEEL_SYNC_START_DATE` (ISO date, required), rendered on every deploy from the GitHub prod secret `DEEL_TOKEN` and the prod variable `DEEL_SYNC_START_DATE` (`deploy.yml`, `scripts/render-deploy-secrets.mjs`). A value set by hand with `wrangler secret put` is deleted by the next deploy, because `secret bulk` replaces the whole set. Manual by default: nothing is sent until an administrator previews the entries on the staff payments screen, ticks the review box and sends them. An administrator can instead set the sync to automatic and choose a daily time (organization timezone); the hourly cron runs it once a day at that time. Only people whose payment provider is Deel and only approved time from the start date. Runs are recorded in `deel_sync_runs`, transfers in `deel_transfer_log`. Does nothing, and calls nothing, unless both are set | [`packages/integrations`](../packages/integrations/README.md) |
| BILL | `BILL_DEV_KEY`, `BILL_COMPANY_ID`, `BILL_USERNAME`, `BILL_PASSWORD`, optional `BILL_REPLY_TO_USER_ID`; runtime `BILL_ENVIRONMENT` | [BILL](bill-setup.md) |
| Issue tracker links (GitHub) | `GITHUB_WORK_ITEMS_CREDENTIAL`, set directly with `wrangler secret put`; not yet in `deploy.yml`, which waits for the first slice that uses the credential (issue 1008) | Administrators connect it under `/api/v1/settings/work-item-connections`; no provider is called yet |
| Invoice Stripe | `STRIPE_API_KEY`, `STRIPE_WEBHOOK_SECRET` | [Stripe](stripe-setup.md) |
| Worker email / container SMTP | Transport-specific variables | [Email](email-setup.md) |

Use the exact values and completeness rules in the guide for your provider. For example, a partial BILL credential set is rejected, a missing Wise token leaves its routes unmounted, and a provider being configured does not automatically grant a user permission to operate it.

## Worker: authoritative GitHub environments

The application workflow `.github/workflows/deploy.yml` installs secrets from its selected GitHub environment: `dev` or `prod`. Update that store through the organization's approved credential process; do not depend on a manual Worker secret surviving the next deployment. `scripts/render-deploy-secrets.mjs` renders managed names, including null values for removal.

For a single secret already saved in a private file outside the checkout:

```sh
gh secret set WISE_TOKEN --env prod --repo YOUR_ORG/YOUR_REPO < /secure/path/wise-token
```

The input file contains only that value. For a PEM public key, preserve newlines:

```sh
gh secret set WISE_WEBHOOK_PUBLIC_KEY --env prod --repo YOUR_ORG/YOUR_REPO < /secure/path/wise-public-key.pem
```

Use a trusted local secret manager or protected files; never paste values into issues, logs or shell command arguments. Keep embedded `=` characters intact. Check secret **names** and update times with `gh secret list`, rather than printing values. A repository or environment secret can override an organization secret of the same name; verify which source your selected deployment resolves.

`BILL_ENVIRONMENT` reaches the Worker the same way `QUICKBOOKS_ENVIRONMENT` does: set a GitHub secret of that name to `sandbox` and redeploy. Anything else, including leaving it unset, is BILL's real book, so confirm the environment on `GET /api/v1/integrations/bill` after deploying. Not every other runtime setting is wired to the stock workflow; check `deploy.yml` before assuming one is.

## Container

Pass supported runtime names through the private container environment and redeploy/restart it. The container configuration parser is `entries/container/src/config.ts`; see [container installation](self-host-container.md). The container uses SMTP, and currently has no Sentry wrapper. Worker-specific deployment settings do not imply container support.

## Deploy and verify

A main-branch application deployment targets development. Production is the reviewed manual dispatch of `deploy.yml` with `environment=prod`; observe all gates in your deployment. Do not bypass failed tests to install a credential. Infrastructure changes use the deployment's infrastructure workflow separately.

After deployment, sign in with the appropriate administrator/accounting privileges and inspect:

| Provider | Read-only status | Evidence |
| --- | --- | --- |
| QuickBooks | `GET /api/v1/integrations/quickbooks` | `data.configured` and the intended company/realm in `data.connection` after OAuth |
| BILL | `GET /api/v1/integrations/bill` | Configured state, company and selected environment |
| Wise | `GET /api/v1/integrations/wise` | Payer profile and webhook-verification configuration |
| Issue tracker links | `GET /api/v1/settings/work-item-connections` | `credential_configured` per provider; the credential is never returned |
| Identity methods | **Settings → Company → Ways in** | Configured and enabled state; then a real controlled login |
| Sentry | Sentry project and CI upload result | Correct event environment/release and readable stack |

The UI settings pages are the easiest authenticated checks. A bare unauthenticated API request is not a provider health check. Record a successful read separately from a verified webhook, delivered email, successful login or authorized payment.

## Public callbacks and webhooks

Use the exact canonical HTTPS host and route from each provider guide. Register callbacks before attempting OAuth and deploy verification credentials before enabling webhook deliveries. Webhooks must reach their signed handler without an interactive login/Access page; do not make the rest of the application public merely to expose a webhook.

The payment webhook paths are `/webhooks/quickbooks`, `/webhooks/wise` and `/webhooks/stripe`, all at the site root. They are not OAuth callbacks and are not under `/api/v1`. Keep raw bodies intact for signature verification. Provider acceptance of a URL is not evidence that its event was processed; check both delivery results and application state.

## Outbound webhooks

Administrators manage endpoints at **Settings → Company → Webhooks**. Management requires a native administrator session; API tokens and other profiles are refused. Create an endpoint with a public HTTPS URL and selected event types. URLs and event selections are immutable: create a replacement endpoint to change them. Pause stops new event fanout and skips pending delivery work; resume permits pending work again. Deleting an endpoint stops pending work and clears its signing keys. A delivery already claimed may finish while a pause or deletion is being applied; a request already sent cannot be recalled. A pause observed before sending returns that claimed delivery to pending without consuming its retry budget.

Set `WEBHOOK_ENCRYPTION_KEY` to a dedicated, canonical base64url value encoding 32 random bytes. Generate it in your secret manager, or privately with `openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'`. Save it in the selected GitHub environment for the stock Worker deployment, or in the private container environment. Keep it with your recovery material: database backups contain sealed signing keys and require the original deployment key. Do not reuse cursor, backup, or API credentials. Replacing this deployment key does not rotate receiver keys; losing it requires deleting/recreating affected endpoints or rotating each endpoint with zero overlap. Missing configuration leaves listing, pause and deletion available but refuses creation, resume, rotation and replay. Public demo outbound delivery is disabled even if a key is present.

The create and rotate responses show the receiver signing secret **once**. Store it at the receiver before closing the dialog; list and log endpoints never return it. Secret issuance uses the HTTP idempotency claim but never stores its response. If the response is lost, refresh the endpoint list and rotate the secret rather than retrying creation blindly. Rotation defaults to a 900-second overlap, supports 0–86400 seconds, and emits signatures under both valid keys during overlap. Record the displayed `previous_valid_until` at the receiver and reject that retiring key after its deadline, even when the HMAC is otherwise valid. A second overlapping rotation is refused; zero overlap permits emergency replacement.

Only events emitted after an active subscription is created are fanned out. Supported events are enumerated by `GET /api/v1/webhook-subscriptions` in `configuration.event_types`: invoice creation/lifecycle, payment recorded/updated/deleted, and administrator time-entry changes on behalf of another person. Ordinary own-time edits and client/project/expense events are not currently emitted. Payloads contain `schema_version`, `event_id`, `event_type`, `occurred_at`, `resource` (type, ID, sequence) and a relative `links.resource`; amounts, notes, actor identities and source event payloads are omitted. Fetch resource details separately with your receiver's own authorized API credential. That credential is never sent with the webhook.

Delivery is at least once. A minute sweep claims at most ten deliveries, runs at most three concurrently, gives each HTTP request five seconds, and never follows redirects. Each delivery has five attempts, retrying network/timeouts, HTTP 408/425/429 and 5xx after 60, 300, 900 and 3600 seconds. Other 4xx and redirects fail permanently. A subscription failure does not prevent another endpoint's attempt. HTTP response bodies are ignored, and logs retain only status codes and controlled error codes. Logs are purged in bounded sweeps after 30 days. Administrators can replay a settled delivery created within seven days; replay retains the original event ID and exact body, with a new timestamp/signature. Receivers must deduplicate by event ID, not by signature or delivery attempt.

Every POST has these headers:

- `Content-Type: application/json`
- `X-Ezacto-Event-Id`: the body event ID
- `X-Ezacto-Timestamp`: canonical integer Unix seconds
- `X-Ezacto-Signature`: comma-separated `v1=<lowercase SHA-256 HMAC hex>` signatures

Verify the **raw request bytes** before JSON parsing. Compute HMAC-SHA256 using the literal `ezwh_…` secret over the UTF-8 timestamp, a period, and raw body bytes. Require a timestamp within five minutes of your clock, use a timing-safe comparison, check the header event ID against the verified body, then atomically record/deduplicate that ID with your receiver's work before acknowledging success. Do not reserialize JSON for verification. Keep receiver clocks synchronized. The core's `verifyWebhookSignature` supports active keys and retiring keys with an explicit Unix-second `validUntil`.

For delivery logs and replay from a terminal, pipe a private JSON object containing the HTTPS `base_url` and complete `__Host-ezacto_session=…` cookie into the CLI. Use an existing native administrator session and keep this file/pipe private. The CLI never saves the session or accepts it in argv, does not use the stored API token, and refuses HTTP/redirects:

```sh
secret-manager-read ezacto-webhook-session | ez webhooks log
secret-manager-read ezacto-webhook-session | ez webhooks log SUBSCRIPTION_UUID
secret-manager-read ezacto-webhook-session | ez webhooks replay DELIVERY_ID
```

Here `secret-manager-read` stands for your own secret manager's command; its JSON output has exactly `base_url` and `session_cookie`. Log output is one JSON delivery per line. Replay prints the queued delivery, preserving its original event ID. Browser Settings offers the same log and replay actions without exporting a session cookie.
