# ezacto-oss — bootstrap

**This repo is the whole ezacto product.** Open-source time tracking & invoicing —
the Harvest replacement. Single org, free, no billing, no telemetry. Private now;
**public at the OSS gate** (CONFLICT's real books running on ezacto).

**Current state: active private pre-release build.** The database, native API,
Worker entry, and generated API client now exist; remaining product lanes build
bottom-up per `PLAN.md`. The umbrella brain
(`ezacto` (the umbrella)) holds the full research corpus and decision records; this repo
carries localized copies of everything needed to build.

## The thesis

**ezacto is a Harvest replacement.** Harvest shipped a new navigation and put the
previous one behind a toggle, with a banner saying the legacy look is no longer
maintained. People who preferred it — including this account's owner — are being
moved off something they chose. That is the opening.

"Match Harvest" is unbounded and always trailing. "Be the old Harvest" is
bounded and testable: the reference implementation exists, is captured in
screenshot inventories, and is frozen because its vendor stopped developing it.
The spec cannot move underneath us.

It also settles what `packages/migrate` is for. It is not a nice-to-have import
path, it is the product's front door — someone who wants the old Harvest back
needs their thirteen years of data to come with them, which is what D7 already
says.

Two consequences that the build has since decided rather than assumed:

- **Fidelity is the interaction model, not the visuals.** Where things live, how
  many clicks, what the week grid does under your hands. The shell carries its
  own design system rather than copying a vendor's; `apps/web/src/shell` and the
  theme tokens are the answer to "how far does fidelity go".
- **Where the old look and the new look disagree, the old wins by default.**
  Departures are deliberate and listed — the DV deviations in
  `docs/domain-model.md` are the record of which legacy behaviours were bad
  enough not to carry forward.

Still open: where this sits relative to the licence and public-flip work, which
#95 tracks.

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
- Licence: **undecided (D8)** — repo stays private until chosen at the v1.0 flip.
- Git: no rebases; no AI attribution in commits.
- Compat quirks (locale times, decimal hours, silent drops) live **only in the
  `/harvest/v2` serializer** — storage stays canonical (docs/domain-model.md §7).
