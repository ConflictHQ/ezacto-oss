# ezacto-oss — bootstrap

**This repo is the whole ezacto product.** Open-source time tracking & invoicing —
the Harvest replacement. Single org, free, no billing, no telemetry. Private now;
**public at the OSS gate** (CONFLICT's real books running on ezacto).

**Current state: knowledge + specs only. No code yet, deliberately.** The build
starts here in its own sessions, bottom-up, per `PLAN.md`. The umbrella brain
(`ezacto` (the umbrella)) holds the full research corpus and decision records; this repo
carries localized copies of everything needed to build.

## What gets built here (D2, D7)

One workspace, planned packages — created only when their build story starts:

```
packages/core       domain logic: rate resolver, three-axis state, state machines
packages/db         Drizzle schema + migrations (SQLite dialect: D1 + file)
packages/api        Hono: /api/v1 + /harvest/v2 shim; publishes OpenAPI
packages/migrate    the wedge: auth·extract·verify·load·reconcile·sync (standalone CLI)
packages/cli        ez — generated client over the OpenAPI
packages/mcp        MCP server (read tools first)
apps/web            main UI (full-width week grid first)
apps/portal         client dashboard (harvest-dash lineage)
entries/worker      Cloudflare Worker entry (default target)
entries/container   single-container entry (SQLite file)
```

Stack: **TypeScript + Hono + Drizzle**. Two runtimes, one codebase.
Tenancy: **one organization = one database**; no `org_id` columns exist.

## Read in this order

1. `PLAN.md` — the build plan and gates for this repo.
2. `docs/domain-model.md` — the entity catalog, invariants, deviations (DV-1…13).
3. `docs/migration-spec.md` — the wedge; M3/M4 are the acceptance test for the model.
4. `docs/architecture.md` — runtime, data, seams, compat strategy.
5. `PROCESS.md` — the build discipline (issue → branch → PR → review → merge).

## Hard rules

- **No billing code, columns, or gates. Ever, in this repo.** Payments features
  (users getting paid) yes; billing (charging anyone) belongs to ezacto-platform.
- **`client` = the billable party** — reserved domain word. Tenant = organization.
- **Open-core direction:** this repo is upstream. ezacto-platform consumes it as a
  versioned package; anything platform needs must land here as public API first.
- **No stubs.** A story is done when it is real (PROCESS.md).
- Licence: **undecided (D8)** — repo stays private until chosen at the v1.0 flip.
- Git: no rebases; no AI attribution in commits.
- Compat quirks (locale times, decimal hours, silent drops) live **only in the
  `/harvest/v2` serializer** — storage stays canonical (docs/domain-model.md §7).
