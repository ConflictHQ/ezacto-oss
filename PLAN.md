# ezacto-oss — build plan

Mirror of the umbrella roadmap, scoped to this repo. Umbrella `specs/` tree is the
source of truth; stories are authored there (S4) and executed here.

## v0 — Prove the data model  ← START HERE
| Order | Epic | Done when |
| --- | --- | --- |
| 1 | `packages/migrate`: auth + extract + verify (M1–M2) | Raw resumable snapshot of the live CONFLICT account; manifest counts match UI spot-checks |
| 2 | `packages/db` + `packages/core`: schema, resolver, state machines | Invariants 1–13 pass as tests |
| 3 | load + reconcile (M3–M4) | **GATE: zero unexplained deltas.** M3 failing = domain-model bug first |

## v0.5 — The working system
api-contract → web-ui → invoicing → email → auth(Access seam) → cli+mcp →
deploys+backups. **GATE: CONFLICT runs on it; Harvest read-only via `migrate sync`.**

## v1.0 — Public
Licence (D8) → hygiene sweep → flip public → native auth → self-host docs →
migrate launch ("leave Harvest in one command").

## v1.x — demand-ordered
Payments (checkout + Mercury reconciliation — blocked on API verification) ·
webhooks · contractor surfaces · portal polish · agent REPL · mobile · extension.

## Build order rule
Bottom-up, no stubs: db → core → api → surfaces. The migration is the test
harness for the model and is built alongside it, not after it.
