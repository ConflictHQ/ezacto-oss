# Infrastructure (OSS)

Scaffolding decisions for hosting, domains, env, CI. Product code lands per
`PLAN.md`; this file is the ops contract it lands into.

## Domains (owned at Porkbun; see umbrella D1 record)

| Domain | Role | When |
| --- | --- | --- |
| `ezacto.com` | marketing site | at v1.0 launch |
| `ezacto.dev` | docs + self-host guides | v1.0 |
| `app.ezacto.dev` | OUR production instance (the dogfood deployment) | v0.5 |
| `portal.example.com` | the umbrella portal (private, behind Access) | anytime |

**Pending owner action:** Cloudflare Workers custom domains require the zones on
Cloudflare — add `ezacto.dev` (and later `ezacto.com`) as CF zones and point
Porkbun nameservers at them. Not done automatically; nameserver moves are an
owner call.

## Hosting

- Default target: **Cloudflare Workers + D1** (one database per org), Queues for
  jobs, R2 for receipts + logical exports. Workers **Paid** plan required (D1
  30-day Time Travel, higher limits).
- Second target: **single container** (Node 22 + SQLite file) — same codebase.
- Our instance deploys via `wrangler deploy` from CI on main once the worker
  entry exists; secrets via `wrangler secret put`, never in the repo.

## Backups (D3)

- Hosted: D1 Time Travel (30 d, per-minute, on by default) + **nightly logical
  export to R2** per org (cron Worker). Restore = operator action with
  confirmation; never automated.
- Container: SQLite file copy + the same logical export format.

## Env & secrets

Registry lives in `.dev.vars.example` (copy to `.dev.vars` locally). Rules:
secrets never in git; production secrets only via wrangler/CI secrets; every new
env var lands in `.dev.vars.example` in the same PR that reads it.

## CI (`.github/workflows/ci.yml`)

`verify` = typecheck + lint + test across workspaces (`--if-present`, so the
pipeline is green pre-code and picks packages up as they land). Merge gates per
`PROCESS.md`: lint, test, build, review — a red gate blocks merge.
