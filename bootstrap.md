# ezacto-oss — bootstrap

**This repo is the whole ezacto product.** Open-source time tracking & invoicing,
built as a Harvest replacement. Single org, free, no billing, no telemetry.
Private now; **public at the OSS gate**, which is the maintainers running their
own books on it.

**Current state: active private pre-release build.** The database, native API,
Worker entry, and generated API client now exist; remaining product lanes build
bottom-up per `PLAN.md`. The umbrella brain
(`ezacto` (the umbrella)) holds the full research corpus and decision records; this repo
carries localized copies of everything needed to build.

## The thesis

Time tracking and invoicing is settled work. People know the shape of it: start
a timer, tag it to a project, bill the month, chase what is owed. What they do
not want is that shape changing underneath them, or the price moving with the
value of the invoices they send.

So the target is not novelty. It is a tool that behaves the way experienced
users already expect, stays still, and costs the same next year. Where the
established workflow is good we keep it. Where it is bad we say so and depart:
the DV deviations in `docs/domain-model.md` are that record.

It also settles what `packages/migrate` is for. It is not a nice-to-have import
path, it is the product's front door. Nobody moves years of clients, projects,
time and invoices by hand, so the importer has to be as trustworthy as the
ledger it writes into, which is what D7 already says.

Two consequences the build has decided rather than assumed:

- **Familiarity is the interaction model, not the visuals.** Where things live,
  how many clicks, what the week grid does under your hands. The shell carries
  its own design system rather than borrowing anyone's; `apps/web/src/shell` and
  the theme tokens are the answer to how far that goes.
- **Departures are deliberate and listed.** A behaviour is carried forward
  because it earns its place, not because somebody is used to it.

The licence and the public flip are settled: AGPL-3.0-only, with the source
public. #95 tracks what remains of the release checklist.

## What gets built here (D2, D7)

One workspace, planned packages — created only when their build story starts:

```
packages/core       domain logic: rate resolver, three-axis state, state machines
packages/db         Drizzle schema + migrations (SQLite dialect: D1 + file)
packages/api        Hono: /api/v1 + /harvest/v2 shim; publishes OpenAPI
packages/mailer     provider-neutral queued email seam + retry policy
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
6. `.claude/workflows/story-sdlc.js` + `build-wave.js` — the **agentic SDLC
   scaffolding**: triage → research → plan → build → test → adversarial →
   review → PR → (merge → validate → close). Model-routed (haiku ceremony,
   sonnet standard, opus hard, xhigh on money/auth/migration labels; fable
   never auto-routed). Contract: umbrella `knowledge/docs/agentic-sdlc.md`. Provider-neutral
   routing: `agents/sdlc-routing.json` (Claude + OpenAI/Codex columns);
   Codex adapter: `.codex/sdlc-playbook.md` — the flow is harness-portable.
   Fires only on groomed stories — acceptance checkboxes are the success
   condition.

## Hard rules

- **No billing code, columns, or gates. Ever, in this repo.** Payments features
  (users getting paid) yes; billing (charging anyone) belongs to ezacto-platform.
- **`client` = the billable party** — reserved domain word. Tenant = organization.
- **Open-core direction:** this repo is upstream. ezacto-platform consumes it as a
  versioned package; anything platform needs must land here as public API first.
- **No stubs.** A story is done when it is real (PROCESS.md).
- Licence: **AGPL-3.0-only** (D8). See LICENSE and NOTICE; CONFLICT LLC holds the
  copyright and also offers ezacto under separate commercial terms.
- Git: no rebases; no AI attribution in commits.
- Compat quirks (locale times, decimal hours, silent drops) live **only in the
  `/harvest/v2` serializer** — storage stays canonical (docs/domain-model.md §7).
