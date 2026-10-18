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
| BILL | `BILL_DEV_KEY`, `BILL_COMPANY_ID`, `BILL_USERNAME`, `BILL_PASSWORD`, optional `BILL_REPLY_TO_USER_ID`; runtime `BILL_ENVIRONMENT` | [BILL](bill-setup.md) |
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

Not every runtime setting is wired to the stock workflow. In particular, the current Worker runtime accepts `BILL_ENVIRONMENT`, but `deploy.yml` and the secret renderer do not pass it through. A GitHub secret with that name alone does not select BILL sandbox. Add and review an explicit deployment configuration path before using BILL sandbox on a Worker, or use the container's supported environment setting. Do not silently use production as a sandbox substitute.

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
| Identity methods | **Settings → Company → Ways in** | Configured and enabled state; then a real controlled login |
| Sentry | Sentry project and CI upload result | Correct event environment/release and readable stack |

The UI settings pages are the easiest authenticated checks. A bare unauthenticated API request is not a provider health check. Record a successful read separately from a verified webhook, delivered email, successful login or authorized payment.

## Public callbacks and webhooks

Use the exact canonical HTTPS host and route from each provider guide. Register callbacks before attempting OAuth and deploy verification credentials before enabling webhook deliveries. Webhooks must reach their signed handler without an interactive login/Access page; do not make the rest of the application public merely to expose a webhook.

The payment webhook paths are `/webhooks/quickbooks`, `/webhooks/wise` and `/webhooks/stripe`, all at the site root. They are not OAuth callbacks and are not under `/api/v1`. Keep raw bodies intact for signature verification. Provider acceptance of a URL is not evidence that its event was processed; check both delivery results and application state.
