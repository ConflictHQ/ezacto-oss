# Build Process & Quality Discipline

How work gets done in this repo — the build cycle, the quality gates, and the
git conventions that keep the default branch shippable. [README.md](README.md)
says what ezacto is; [bootstrap.md](bootstrap.md) says what it is for and what
the constraints are; this file is the discipline underneath both.

It applies to everything that lands here, whether a person or an agent runs it.
[CONTRIBUTING.md](CONTRIBUTING.md) is the shorter front door for a first patch.

## Core shape: plan top-down, build bottom-up

Two directions, deliberately opposite.

- **Plan top-down.** Decompose from the outcome down to executable units:
  `phase → epic → feature → story`. [PLAN.md](PLAN.md) carries that decomposition.
  The plan exists *before* the build; a story is the smallest unit an agent or person
  picks up and finishes in one cycle.
- **Build bottom-up.** Implement from the leaves up: data model and primitives before
  the feature that composes them, the feature before the screen that uses it.
  Integrate continuously — never leave a layer half-wired waiting on a layer above it.

The issue tracker is the live mirror of this: open issues show *what's planned*,
the build cycle below produces *what's done*, and the two should always agree.

## The build cycle: issue → branch → PR → review → merge

Every unit of work runs the same loop. No work lands outside it.

1. **Issue.** One issue per story/feature. It states the goal, the acceptance
   criteria, and how it will be verified. Issues map back to the plan. Follow the
   issue workflow: move it to **in-progress** when you start, update it as you go,
   and close the loop when done.
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
   see git conventions). Close the issue.

This is the same loop whether a person or an AI agent runs it; agents get the
acceptance criteria as their success condition and the quality gates as their stop
condition.

## No stubs, no placeholders

A story is **done** when it is real. Not when it compiles around a `TODO`.

- No stubbed functions, no `return null /* implement later */`, no mock data shipped
  as if it were real, no commented-out "will finish next sprint" blocks on the
  default branch.
- An empty state is fine *when it's a designed empty state*. A placeholder
  pretending to be a feature is not.
- If a story is too big to finish for real, split it in the plan — don't half-ship it.

**Done when:** every changed line traces to the issue, the feature works end to end,
and there is nothing left to "come back to."

## Quality gates

Nothing merges until all four pass. They run locally before the PR and in CI on the PR
(the project template wires the CI; you keep it green).

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

Use the **standard, boring toolchain per language** — the one the project template
already configured. Don't introduce a bespoke linter or formatter; match
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
- **One branch per issue**, merged via PR; the default branch is always shippable.
- **Submodules first.** Where a repo mounts another as a submodule, push the
  submodule before the parent, so the parent never points at an unpushed commit.

## Related

- [README.md](README.md) — what ezacto is and how to run it.
- [CONTRIBUTING.md](CONTRIBUTING.md) — the short path to a first patch, and the CLA.
- [bootstrap.md](bootstrap.md) — scope, constraints, and the decisions behind them.
- [PLAN.md](PLAN.md) — the top-down decomposition this cycle consumes.
- [docs/testing-strategy.md](docs/testing-strategy.md) — what the gates below actually run.
- [docs/architecture.md](docs/architecture.md) — the runtime the build targets.
