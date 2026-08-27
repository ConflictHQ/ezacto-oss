# Infrastructure (OSS)

Scaffolding decisions for hosting, domains, env, CI. Product code lands per
`PLAN.md`; this file is the ops contract it lands into.

## Domains (owned at Porkbun, all five zones live on Cloudflare; see umbrella D1 record)

| Host | Role | When |
| --- | --- | --- |
| `app.example.com` | **OUR production instance** — the dogfood deployment, and the OSS gate | now |
| `ezacto.io` | **the dev deployment**, on the apex; becomes the public demo | now |
| `ezacto.dev` | developer site for the OSS project — docs + self-host guides, GitHub Pages (the `planopticon.dev` pattern: apex CNAME → `conflicthq.github.io`, proxied) | v1.0 |
| `portal.example.com` | the umbrella portal (private, behind Access) | live |
| `ezacto.com` | marketing site. Also carries Google Workspace MX and the Mailgun `go.` sending subdomain — **do not point an app at it** | v1.0 launch |
| `ezacto.ai`, `ezacto.net` | parked | — |

Two deployments, and only two. Per-branch preview Workers are how an account
grows forty of them; targets here are hosts we own and name. `app.ezacto.dev` —
the earlier plan for our instance — is dropped in favour of `app.example.com`.

## Hosting

- Default target: **Cloudflare Workers + D1** (one database per org), Queues for
  jobs, R2 for receipts + logical exports. Workers **Paid** plan required (D1
  30-day Time Travel, higher limits).
- Second target: **single container** (Node 22 + SQLite file) — same codebase.
- The Worker entry is `entries/worker`: thin Hono, an instance-identity page, and
  `/healthz` reporting the environment and the commit actually running.
- `workers_dev` is **false in every environment**. The default `*.workers.dev`
  subdomain serves the same Worker with nothing in front of it — a side door
  around whatever gates the custom domain.
- D1/R2/Queues bindings land in `wrangler.jsonc` with the stories that use them.
  A binding nothing reads is a lie about what the Worker needs.

## Backups (D3)

- Hosted: D1 Time Travel (30 d, per-minute, on by default) + **nightly logical
  export to R2** per org (cron Worker). Restore = operator action with
  confirmation; never automated.
- Container: SQLite file copy + the same logical export format.

## Env & secrets

Registry lives in `.dev.vars.example` (copy to `.dev.vars` locally). Rules:
secrets never in git; production secrets only via `wrangler secret put` or CI
secrets; every new env var lands in `.dev.vars.example` in the same PR that
reads it.

CI holds exactly two repo secrets, both consumed only by `deploy.yml`:

| Secret | What |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | scoped deploy token — account: Workers Scripts Write, Workers Observability Write, Account Settings Read; zone: Zone Read, Workers Routes Write, DNS Write, **limited to `example.com` and `ezacto.io`** |
| `CLOUDFLARE_ACCOUNT_ID` | CONFLICT LLC account id (not secret; a secret only to keep it out of the tracked config) |

The token cannot touch any other zone, and cannot create zones. Rotate by
issuing a new token and replacing the secret; revoke the old one after the first
green deploy.

## CI (`.github/workflows/ci.yml`)

`verify` = typecheck + lint + test + build across workspaces (`--if-present`, so
the pipeline is green pre-code and picks packages up as they land), plus the
gitleaks gate with its own self-test. Merge gates per `PROCESS.md`: lint, test,
build, review — a red gate blocks merge.

## CD (`.github/workflows/deploy.yml`)

| Trigger | Target |
| --- | --- |
| push to `main` | **dev** — `ezacto.io` |
| manual dispatch, `environment: prod`, only from `main` | **prod** — `app.example.com` |

Prod is never automatic. "It merged" and "we are ready to move a real book of work
onto it" are different questions, and only one is answered by a push event.

The run re-runs `verify` rather than trusting that `ci.yml` did, deploys with
`--var RELEASE:$GITHUB_SHA`, and then **polls the live host's `/healthz` until it
reports that SHA**. A wrangler exit code says the upload was accepted — not that
the domain resolves, the certificate is up, or the route is bound. The target
host is read out of `wrangler.jsonc`, never repeated in the workflow.
