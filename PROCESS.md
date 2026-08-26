# Build Process & Quality Discipline

The discipline layer for running an engagement with this kit. The portal
([README](README.md)) is the knowledge surface; this file is *how the work gets
done underneath it* — the build cycle, the quality gates, and the git conventions
that keep a delivery shippable.

It applies to **Tier 2 — Full Engagement** (portal + product build + infra) and
**Tier 3 — Managed Project** (running an existing/ongoing build through the portal's
project surfaces). Tier 1 (portal only) doesn't need it. The process is generic and
reusable across engagements, languages, and teams.

> **Rides on Boilerworks, doesn't reinvent it.** The product and platform repos are
> scaffolded with **[Boilerworks](https://boilerworks.ai)** (`pip install
> boilerworks`; docs at [boilerworks.dev](https://boilerworks.dev)). Its 26 templates
> already ship the toolchain: auth, billing, jobs, email, Docker, **CI/CD**, design
> system, and Terraform IaC, plus AI-agent shims. So most of the quality scaffolding
> below already exists in the repo from day one. This process is the *human/agent
> discipline* that runs on top of that scaffolding — not a second copy of it.

## Core shape: plan top-down, build bottom-up

Two directions, deliberately opposite.

- **Plan top-down.** Decompose from the outcome down to executable units:
  `phase → epic → feature → story`. This is exactly the structured plan the portal
  already renders (`specs/` tree + Plan page — see
  [docs/patterns/information-architecture.md](docs/patterns/information-architecture.md)).
  The plan exists *before* the build; a story is the smallest unit an agent or person
  picks up and finishes in one cycle.
- **Build bottom-up.** Implement from the leaves up: data model and primitives before
  the feature that composes them, the feature before the screen that uses it.
  Integrate continuously — never leave a layer half-wired waiting on a layer above it.

The portal's project surfaces are the live mirror of this: the plan, roadmap,
deliverables, and trackers show *what's planned*; the build cycle below produces *what's
done*; the two should always agree.

## The build cycle: issue → branch → PR → review → merge

Every unit of work runs the same loop. No work lands outside it.

1. **Issue.** One issue per story/feature. It states the goal, the acceptance
   criteria, and how it will be verified. Issues map back to the plan. Follow the
   issue workflow: move it to **in-progress** when you start, update it as you go,
   close the loop when done — including in Tier 3, where the issue tracker *is* the
   management surface.
2. **Branch.** Cut a branch off the default branch, named for the issue
   (e.g. `feat/<id>-short-slug`, `fix/<id>-short-slug`). Never commit features
   directly to the default branch.
3. **Implement.** Build bottom-up. Keep the diff surgical — touch only what the
   issue needs; don't refactor adjacent code in the same change.
4. **PR.** Open a pull request that links the issue. Keep PRs small and reviewable;
   a PR that can't be read in one sitting is two PRs. The PR description says what
   changed and how it was verified.
5. **Review.** At least one review before merge. Review checks correctness against
   the acceptance criteria, then reuse/simplicity. CI must be green (next section).
6. **Merge.** Merge to the default branch (squash or merge commit — **never rebase**,
   see git conventions). Close the issue. The deliverable/tracker on the portal moves
   to done.

This is the same loop whether a person or an AI agent runs it; agents get the
acceptance criteria as their success condition and the quality gates as their stop
condition.

## No stubs, no placeholders

A story is **done** when it is real. Not when it compiles around a `TODO`.

- No stubbed functions, no `return null /* implement later */`, no mock data shipped
  as if it were real, no commented-out "will finish next sprint" blocks on the
  default branch.
- An empty state is fine *when it's a designed empty state* (the portal does this
  deliberately — see
  [docs/practices/filling-in-a-new-engagement.md](docs/practices/filling-in-a-new-engagement.md)).
  A placeholder pretending to be a feature is not.
- If a story is too big to finish for real, split it in the plan — don't half-ship it.

**Done when:** every changed line traces to the issue, the feature works end to end,
and there is nothing left to "come back to."

## Quality gates

Nothing merges until all four pass. They run locally before the PR and in CI on the PR
(Boilerworks templates wire the CI; you keep it green).

| Gate | What it proves | Where it runs |
| --- | --- | --- |
| **Lint** | Style + static checks pass, no dead/unused code introduced | pre-commit + CI |
| **Test** | New behavior is covered; existing behavior still passes | local + CI |
| **Build** | The thing actually builds/compiles/bundles | local + CI |
| **Review** | A second set of eyes signed off against acceptance criteria | PR |

Rules of thumb: new behavior ships with tests; a bug fix ships with the test that
would have caught it; a red gate blocks the merge — you fix the gate, you don't
bypass it. CI failures are debugged in the CI environment's context (missing deps,
shell/YAML/path differences), not assumed away because it works locally.

## Per-language toolchains

Use the **standard, boring toolchain per language** — the one Boilerworks already
configured for that template. Don't introduce a bespoke linter or formatter; match
what the scaffold ships. Typical defaults:

| Language | Format / Lint | Test | Build |
| --- | --- | --- | --- |
| Python | `ruff` (+ `black`) | `pytest` | `uv` / `pip` build |
| TypeScript / JS | `eslint` + `prettier` | `vitest` / `jest` | framework build (Vite/Next/etc.) |
| Go | `gofmt` + `go vet` | `go test` | `go build` |
| Rust | `rustfmt` + `clippy` | `cargo test` | `cargo build` |
| Ruby | `rubocop` | `rspec` | `bundle` |
| Elixir | `mix format` + `credo` | `mix test` | `mix compile` |

If a repo's scaffold disagrees with this table, **the scaffold wins** — it reflects the
chosen template. Pin versions; format-on-save; never argue style in review when a
formatter can settle it.

## Git conventions

- **No rebases. Ever.** Integrate with merges. History is append-only.
- **No AI co-author attribution** in commits, PRs, issues, or anywhere — no
  "Generated with" or `Co-Authored-By` trailers for an assistant.
- **Meaningful commits.** Each commit is a coherent step with a message that says
  *why*, not just *what*. No `wip`/`fix`/`asdf` noise on the default branch.
- **Private repos.** Engagement code, infra, and the portal are private by default.
- **One branch per issue**, merged via PR; the default branch is always shippable.
- **Submodules first.** If the workspace mounts product repos as submodules (see
  [docs/patterns/workspace-metarepo.md](docs/patterns/workspace-metarepo.md)), push
  submodule changes before the parent repo so the parent never points at an unpushed
  commit.

## How the process feeds the portal

The discipline above isn't separate from the knowledge surface — it produces it.

- Each closed issue is a **deliverable** and a tracker update on the portal.
- The **plan** (`specs/` tree) is the top-down decomposition the build cycle consumes.
- Code context for agents working the build comes from
  **[Navegador](https://navegador.dev)** (see
  [docs/practices/code-context-navegador.md](docs/practices/code-context-navegador.md)).
- Meeting decisions that change the plan come in through
  **[PlanOpticon](https://planopticon.dev)** (see
  [docs/practices/recording-pipeline.md](docs/practices/recording-pipeline.md)) and
  surface as action items and decisions.

The point of the whole kit: template + Boilerworks scaffolding + this process +
agents = skip months of setup and toolchain wiring, and start the loop on features
on day one.

## Related

- [README.md](README.md) — the portal and the kit overview.
- [docs/practices/adversarial-review-and-acceptance.md](docs/practices/adversarial-review-and-acceptance.md)
  — break your own claims before the PR; acceptance means the running system.
- [docs/patterns/information-architecture.md](docs/patterns/information-architecture.md)
  — the plan/deliverables/tracker surfaces this process drives.
- [docs/patterns/workspace-metarepo.md](docs/patterns/workspace-metarepo.md) — product
  repos as submodules under the portal.
- [docs/practices/code-context-navegador.md](docs/practices/code-context-navegador.md)
  — structured code context for build agents.
- [docs/practices/deployment.md](docs/practices/deployment.md) — shipping the portal.
