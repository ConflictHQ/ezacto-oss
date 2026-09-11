---
name: Technology Stack
description: The technology behind the product — language and workspace layout, the two runtime targets, data and storage, the API contract chain, and the toolchain the gates run. Deep detail lives in docs/architecture.md.
metadata:
  type: reference
---

# Technology Stack

A map of what the product is built from, at the level a newcomer needs before
reading code. It is deliberately shallow: for how the pieces fit together and
why, read [`docs/architecture.md`](../docs/architecture.md), and for the entities
and their invariants read [`docs/domain-model.md`](../docs/domain-model.md).

List only what is actually in use. A row here that nothing imports is worse than
no row at all.

## Language and layout

| Component | Technology | Notes |
|-----------|-----------|-------|
| Language | TypeScript | One codebase, two runtimes. |
| Runtime | Node | Pinned in `.nvmrc`; `engines` requires ≥ 22. CI also runs a compatibility job on the next major so a runtime break is caught before it ships. |
| Workspaces | npm workspaces | `packages/*` (libraries), `entries/*` (deployment targets), `apps/*` (surfaces). |

`packages/core` is pure domain logic with no I/O; `packages/db` owns the schema;
`packages/api` is the HTTP chassis; `packages/client` is generated from the API
contract; `packages/cli` and `packages/mcp` are consumers of that client;
`packages/migrate` is the standalone import path; `packages/mailer` is the email
seam; `packages/integrations` holds outbound adapters.

## Runtime targets

| Target | What it is |
|--------|------------|
| `entries/worker` | The default: a Cloudflare Worker with **exactly three bindings — D1, Queues, R2**. There is no Redis, no Postgres, no job runner. A proposal that adds a fourth dependency has to earn it in the issue first. |
| `entries/container` | A single Node process over a local SQLite file, for self-hosting without Cloudflare. Same API, same schema. |

Tenancy is **one organization, one database** — there are no `org_id` columns to
forget.

## Data

| Component | Technology | Notes |
|-----------|-----------|-------|
| Schema / query | Drizzle ORM, SQLite dialect | One schema serving both D1 and the container's file. |
| Migrations | Hand-maintained ledger in `packages/db/src/migrations` | Applied lazily. Adding one is a **new file**; a shipped migration is never edited. |
| Attachments | R2 (Worker) — see `docs/attachment-storage.md`. |
| Email | Queues plus a pluggable `Mailer` seam | HTTP-first, because a Worker cannot speak SMTP; every send is a queued job with a retry policy. |
| Identity | A pluggable `Identity` seam | The implementation behind it is the part still moving — check `docs/architecture.md` before assuming which one is live. |

## API and its consumers

The HTTP API is Hono, and the versioned OpenAPI document at
`openapi/ezacto-v1.openapi.json` is **generated from the code**, not written by
hand: `npm run contract:generate` emits it and `npm run contract:check` fails the
build when the committed copy drifts. The TypeScript client, the `ez` CLI, and
the read-only MCP server are all downstream of that one document.

## Web surface

`apps/web` is vanilla TypeScript server-rendered by the entry — no frontend
framework, and a design system carried in the repo rather than borrowed. Theme
tokens are compiled into a generated module that is committed and checked
(`theme:check`), and the palette has to meet WCAG AA in CI.

## Toolchain

| Concern | Tool | Command |
|---------|------|---------|
| Typecheck | TypeScript | `npm run typecheck` |
| Lint | ESLint (typescript-eslint) | `npm run lint` |
| Test | Vitest, with Miniflare for D1-backed suites | `npm test` |
| Browser acceptance | Playwright | `npm test -w @ezacto/web` |
| Container drill | Docker | `npm run test:container` |
| Everything, in the CI order | | `npm run verify` |
| CI | GitHub Actions | `.github/workflows/verify.yml`, called by both the merge gate and the deploy |
| Secret scanning | gitleaks | The `secrets` job, over the branch's full history |

## Not in the stack

_(Keep this list current — a "no" that stops being true is how a dependency
sneaks in.)_

- No Redis, no Postgres, no external job runner, no frontend framework.
- No billing code, columns, or gates in this repo. See `bootstrap.md` § Hard
  rules for why that boundary exists.
- _(fill in: anything else deliberately rejected, with the issue that rejected it)_.
