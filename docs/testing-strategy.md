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

## The live Harvest suites

`packages/migrate/test/*.live.test.ts` sweep the real CONFLICT Harvest account —
they are the evidence the `[manual]`/`[api]` acceptance boxes are closed with, and
they are never mocked. They run only when asked:

```
EZACTO_LIVE_HARVEST=1 npm test -w ezacto-migrate
```

Nothing else turns them on. Credentials being present is not the same signal —
`.dev.vars` is the documented setup for ordinary CLI work, and `env.loadDevVars`
finds one anywhere above the checkout, so gating on the PAT put a plain `npm test`
into Harvest's 429 backoff against production. Asking for the sweep *without*
credentials still fails loudly rather than skipping, and a skipped live suite
prints the reason it skipped.

## CI failure ledger

A red `verify` job is compared against known causes before it is investigated
(issue 745). `scripts/ci-failure-ledger.mjs` does two things:

- `node scripts/ci-failure-ledger.mjs --repo OWNER/NAME --runs 50` lists failed
  job attempts of `ci.yml` and `deploy.yml` from the Actions REST API, with the
  run, attempt, failed step, cause class, and whether a re-run of that job went
  green. Jobs that failed with no steps (a billing outage) and cancelled jobs are
  left out. A log that matches nothing is reported as `unclassified`.
- In `verify`, a failed test job is annotated with the matched class and a link
  to the ledger issue.

| Class | Signature | Disposition |
|---|---|---|
| `miniflare-proxy-heap` | `proxy.worker.ts:150` | Upstream; the narrow retry in the migrate resume test covers it |
| `miniflare-fetch-sync` | `fetch-sync.ts:147` | Upstream; no retry, re-run the job and record it |
| `kdf-overload` | `PasswordDerivationOverloadedError` | Load on the runner queueing password derivations; the limiter caps are a memory decision, so rerun the test alone before touching them |
| `vitest-timeout` | `Test timed out in Nms`, `Hook timed out in Nms` | Budget against a loaded runner; compare the green duration before touching it |
| `request-abort-timeout` | `TimeoutError: The operation was aborted due to timeout` | A per-request AbortSignal budget lost to a cold runtime; size it for migrations if it recurs |
| `registry-reset` | `ECONNRESET` and similar network errors | Infrastructure; not ours, re-run the job |

Anything else is `unclassified`: investigate it, and add a row here and a
signature in the script if it recurs. A test keeps this table and the script
equal.

## Repeat under load

`.github/workflows/load-verify.yml` (manual dispatch only, never per PR)
repeats one shard (`migrate`, `web`, `worker`, `api-1`, `db-10`) N times with
one worker, pinned to one CPU beside a CPU burner, and writes a pass-rate table
to the job summary. `scripts/load-verify.mjs` classifies each failed repeat with
the ledger signatures above; only an `unclassified` failure fails the run, and a
known class lowers the pass rate, which is a finding. There is no retry in the
loop. The one retry in the suite stays the narrow miniflare proxy-heap case in
the migrate resume test.

The web `testTimeout: 15_000` CI override in `apps/web/vitest.config.ts` stays
until a recorded `web` baseline supports removing it.

## Standing rules

Red gate = fix, never bypass (PROCESS.md). A bug fix ships with the test that
would have caught it (E16). Tests assert slots/roles, never hex or copy that a
theme/brand may change (E4/F12).
