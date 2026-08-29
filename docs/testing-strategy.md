# Testing strategy

The pyramid, the fixtures, and the E2E scaffolding contract. Specs only — test
code arrives with its stories (each Acceptance box carries its mechanism tag).

## The pyramid

| Layer | What | Named by | Runs |
|---|---|---|---|
| **Unit** | domain invariants (`inv-01…14` — citable names, E8), rate resolver table, state machines, token compiler, matchers | `[unit]` tags | every commit, both runtimes |
| **API/contract** | /api/v1 behavior, permission×money redaction matrix, `/harvest/v2` **golden files from the real (anonymized) snapshot**, OpenAPI drift | `[api]` tags | every commit |
| **E2E** | the 15 journeys (`umbrella knowledge/docs/user-journeys.md`) as Playwright specs | `[e2e:<id>]` tags | PR + nightly |
| **Manual/UAT** | gate ceremonies (M4 run, restore drill review, fresh-eyes install) | `[manual]` tags | at gates |

## E2E scaffolding contract

- Location: `e2e/journeys/<id>.spec.ts` — ids exactly from user-journeys.md; a
  story citing `[e2e:x]` is not done until that spec exercises its boxes.
- Runner: Playwright; projects for desktop (1440×900) and phone (390×844) —
  `phone-week` runs the phone project; every journey asserts zero console errors.
- App under test: the **container entry** (deterministic, no cloud deps);
  worker-target smoke runs the same specs against a preview deploy nightly.

## Fixtures

- **The cast** (matches the anonymized gallery): org "Halcyon Studio"; clients
  Ridgeline IT → Kestrel Environmental (two builds) [3-level tree], Northpeak,
  Lakefield Analytics, Harborview (retainer $18k); users Ana (owner), Byron
  (contractor, rate change on the 15th), contact Cleo.
- One seeder builds it all (`e2e/fixtures/seed.ts` when built): deterministic,
  idempotent, used by unit + api + e2e alike; clock injectable (no real `now` in
  assertions).
- **The real snapshot** (CONFLICT extract) is used ONLY for shim golden files and
  reconciliation tests, gitignored, never in fixtures.

## Standing rules

Red gate = fix, never bypass (PROCESS.md). A bug fix ships with the test that
would have caught it (E16). Tests assert slots/roles, never hex or copy that a
theme/brand may change (E4/F12).
