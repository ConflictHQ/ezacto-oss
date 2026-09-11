# Calliope — ezacto
<!-- Agent shim for https://github.com/calliopeai/calliope-cli -->

Read [`bootstrap.md`](bootstrap.md) first — it is the canonical entry point for
this repo: identity, scope, hard rules, plan, and process. [`PROCESS.md`](PROCESS.md)
is the build discipline underneath it.

---

## Project-specific notes

- npm workspaces on Node 22 (`.nvmrc`). Three groups: `packages/*` (core, db, api,
  client, cli, mcp, mailer, migrate, integrations), `entries/*` (worker, container),
  `apps/web`.
- Two runtimes from one codebase: a Cloudflare Worker and a single container. Exactly
  three Worker bindings — **D1**, **Queues**, **R2**. No Redis, no Postgres.
- `apps/web` is vanilla TypeScript server-rendered by the entry; there is no React
  or Next.js here.
- Migrations are a hand-maintained ledger in `packages/db/src/migrations`, applied
  lazily on first data request or by the cron. Never edit an applied migration;
  add the next one.
- `npm run verify` is the gate and runs in this order: contract check, typecheck,
  lint, theme contrast, tests, build. Run it before opening a pull request.
- The OpenAPI contract is generated, not written. If `contract:check` fails, run
  `npm run contract:generate` and commit `openapi/ezacto-v1.openapi.json`.
- `npm run test:container` is a separate Docker drill and is not part of `verify`.
- Fixtures and docs use an invented cast throughout — Kestrel Environmental,
  Northpeak, Halcyon Biolabs, Ridgeline IT — plus `example.com`, `example.test` and
  `example.invalid`. Never put a real client, person, hostname, account number or
  money figure into code, comments, fixtures or commit messages.
- No rebases. No AI attribution in commits or pull requests.
