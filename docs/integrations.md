# Integrations: where the keys go

ezacto talks to three money systems, and none of them share a setup path:

| | What it does | Doorway | Guide |
| --- | --- | --- | --- |
| **QuickBooks Online** | mirrors every sent invoice and every payment into the books, and reads payments made there | OAuth: an administrator presses **Connect** | [QuickBooks setup](quickbooks-setup.md) |
| **BILL** | creates an opted-in client's invoices in BILL and closes them here when the client pays there | a developer key and a login, no connect step | [BILL setup](bill-setup.md) |
| **Wise** | pays contractors from the organisation's Wise account | an API token, no connect step | [Wise setup](wise-setup.md) |

Each guide says what to create at the vendor. This page is the part they share:
how the resulting values reach a deployment, and how to prove they did.

## The values

Every integration is configured by environment variables, all registered with
their meaning in `.dev.vars.example`. The names are the same for the Worker and
the container:

| Integration | Variables |
| --- | --- |
| QuickBooks | `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET`, `QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN`, `QUICKBOOKS_ENVIRONMENT` |
| BILL | `BILL_DEV_KEY`, `BILL_COMPANY_ID`, `BILL_USERNAME`, `BILL_PASSWORD`, optionally `BILL_REPLY_TO_USER_ID` and `BILL_ENVIRONMENT` |
| Wise | `WISE_TOKEN`, optionally `WISE_PROFILE_ID` and `WISE_WEBHOOK_PUBLIC_KEY` |

An integration whose values are absent is simply not there: its routes are not
mounted, the settings page says it is not configured, and nothing else changes.
There is no half-configured state that looks alive -- BILL with three of its
four values refuses to start rather than pretending.

## The Worker: GitHub environment secrets

The Cloudflare deployment is made by `deploy.yml`, and every secret it installs
comes from the **GitHub environment** it deploys: `dev` for the development
host and `prod` for the production one. The workflow converges the Worker's
secrets to what the environment holds on every deploy, so a value put on the
Worker by hand with `wrangler secret put` lasts until the next deploy and then
reverts. Put values in the environment, never on the Worker directly.

The values live in a local, gitignored `<vendor>.env` file and go up with the
GitHub CLI, one environment at a time. A dotenv-formatted file is accepted as
is:

```
grep -E '^BILL_' bill.env | gh secret set -f - --env prod -R <owner>/<repo>
```

Two things to know about that command. It sets exactly the names in the file,
so a value the vendor does not need is left out by leaving it out of the file.
And a value that contains `=` -- Sentry's org tokens do -- must be read with
`cut -d= -f2-`, not split on the first `=`, or the secret is silently truncated
and the vendor answers *invalid token* on every deploy.

Keep an integration to the environments that should have it. BILL is usually
production only; QuickBooks has a development key for the sandbox company and a
production key for the real one, and they must not cross.

## The container

The container reads the same names from its environment (`docker run -e`, a
compose file, or a systemd unit). See [Self-host in a container](self-host-container.md).

## Deploying, and proving it

A merge to `main` deploys **the development host only**. Production is a
manual dispatch of `deploy.yml` with `environment=prod`, and the deploy job's
log names the Worker it uploaded. A value added to the `prod` environment is
not on production until that dispatch has run.

After the deploy, each integration reports on itself without a browser:

| Integration | Route | Configured looks like |
| --- | --- | --- |
| QuickBooks | `GET /api/v1/integrations/quickbooks` | `configured: true`, and a `connection` naming the company and realm once an administrator has pressed Connect |
| BILL | `GET /api/v1/integrations/bill` | `configured: true`, the company id and `environment` |
| Wise | `GET /api/v1/integrations/wise` | `configured: true`, the paying profile's id and name, how many people it can pay, and whether webhooks can be verified |

**Settings → Integrations** and **Settings → Payouts** show the same facts, with
a Retry where a request failed and the request id the Worker log is searched by.

## Webhooks

The three inbound endpoints are on the site root, not under `/api/v1`, and each
verifies the vendor's signature before it reads anything:

```
https://<your-host>/webhooks/quickbooks
https://<your-host>/webhooks/wise
https://<your-host>/webhooks/stripe
```

Register a webhook at the vendor **after** the deployment carries its key:
vendors start delivering as soon as the subscription is saved, and deliveries
to an endpoint that is not mounted are retried and then dropped.
