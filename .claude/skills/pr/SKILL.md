---
name: pr
description: gh wrapper for the PR lifecycle on this repo — open a process-compliant PR (preflight gate, body template, reviewer notes), read CI output and diagnose a red check, and address review feedback. Use when opening a PR, when a check is red, or when responding to review comments. Skip for local-only commits with no PR intent, and for non-GitHub remotes. Multi-agent (mirrored at .codex/skills/pr/).
---

# /pr — PR lifecycle helper (gh wrapper)

Wraps `gh` for the three things a change needs here: open it, check it, answer
the review. Work reaches `main` through a pull request — `PROCESS.md` starts
every unit of work at an issue and ends it at a reviewed merge, and `ci.yml`
runs only on `pull_request`, so a change that never had a PR has never been
gated. The policy lives in `bootstrap.md` (Hard rules) and `PROCESS.md` (the
build cycle, the git conventions); this file is the runbook that enforces it,
and `.codex/sdlc-playbook.md` steps 9–11 are the same ceremony written for an
agent.

**Usage:** `/pr open [#issue] [@reviewer…]` · `/pr checks [#PR]` · `/pr feedback [#PR]`
(Default `#PR` = the PR for the current branch: `gh pr view --json number -q .number`.)

## Resolve the repo and the identity — read them, never hardcode

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
AUTHOR_EMAIL=$(git config user.email)     # set per-repo, never inherited from a global
```

Commit and comment as this checkout's configured identity. Never add
`Co-Authored-By`, a "generated with" line, or any other assistant attribution to
a commit, a PR body, or an issue comment — `PROCESS.md` § Git conventions makes
that a standing rule, and published history is not rewritten to take one back
out.

---

## `/pr open` — open a well-formed PR

**Preflight — block on any failure, fix before opening.**

1. **On a branch, not `main`.** Naming follows the history: `feat/<issue>-<slug>`,
   `fix/<issue>-<slug>`, `docs/<slug>`, `ci/<slug>`. The agentic path cuts the
   same branch inside a worktree (`git worktree add ../ez-wt-<id> -b feat/<id>`,
   `.codex/sdlc-playbook.md` step 4); the name is identical either way.

2. **Author and attribution on this branch's commits:**
   ```bash
   git log origin/main..HEAD --format='%h %ae %s' | grep -v " $AUTHOR_EMAIL " \
     && echo "STOP: a commit is not authored by $AUTHOR_EMAIL — fix git config, then new commits (no amend, no rebase)"
   git log origin/main..HEAD --format=%B | grep -qiE 'co-?authored-by:|generated with' \
     && echo "STOP: strip the attribution trailer"
   ```

3. **Clean tree.** Commit the outstanding work; a PR opened around uncommitted
   files describes a state nobody else has.

4. **Run the gates CI runs.** `npm run verify` is the whole chain in one
   command, and `verify.yml` is the same definition the merge gate and the
   deploy both call, so a green local run is the real answer:
   ```bash
   npm ci
   npm run verify   # contract:check → typecheck → lint → theme contrast → test → build
   ```
   Serially that run is long — `verify.yml` puts it near 34 minutes, tests
   dominating — which is why CI fans it out across runners. While iterating use
   `npm run check` (typecheck + lint) and `npm test -w <workspace>`, then spend
   the full `verify` once before you open.

   Two CI jobs are **not** part of `npm run verify` and have to be run
   deliberately:
   - `npm run test:container` — Docker first-run plus a physical backup and
     restore (the `container` job).
   - gitleaks over the branch's full history (the `secrets` job). It reads
     commits, not the working tree, so a secret added and later deleted on the
     same branch still fails.

5. **Prove the tests can fail.** `CONTRIBUTING.md` asks for this and it is not
   ceremony: revert the source change, keep the new test, confirm it goes red,
   then put the change back. A test that passes with and without the change is
   not evidence of anything.

**Compose and create.**

- **Issue:** from the `#issue` argument, else the branch name (`feat/<issue>-…`),
  else a `Closes:`/`Refs:` trailer in a commit. If there is none and the change
  is more than a typo, ask whether to file one first — `PROCESS.md` starts the
  cycle at the issue.
- **Title:** conventional, imperative, under 70 characters, matching the history
  — `<type>(<scope>): <summary>`, e.g. `fix(web): …`, `feat(reports): …`,
  `ci: …`. Say why, not what.
- **Body:**
  ```markdown
  ## Summary
  <1–3 sentences: what changed and why>

  ## Changes
  - <key change>

  ## Verified
  - <commands run, what they proved, which acceptance box each closes>

  Closes #<issue>      <!-- or "Refs: #<issue>" when it does not close it -->
  ```
- ```bash
  git push -u origin "$(git branch --show-current)"
  gh pr create --repo "$REPO" --base main --title "<title>" --body "<body>"
  ```
  `ci.yml` has no push trigger — nothing runs on the branch until the PR exists.
  Opening it is what starts the gate.
- **Reviewers:** tag by GitHub **login** (not display name) in a comment so the
  notification actually fires: `gh pr comment <#> --repo "$REPO" --body "@<login> …"`.
  Report the URL. If the change touches money, auth, migration or invariants,
  say so — those labels raise the review tier in `agents/sdlc-routing.json`.

## `/pr checks` — read CI and diagnose

```bash
gh pr checks <#> --repo "$REPO"
gh pr view <#> --repo "$REPO" --json mergeable,mergeStateStatus -q '{mergeable,state:.mergeStateStatus}'
```

Checks appear as **`verify / <job>`**: `ci.yml` holds a single `verify` job that
calls the reusable `verify.yml`, so every gate is namespaced under it. Open the
run and read only the failed step:

```bash
rid=$(gh run list --repo "$REPO" --branch "$(gh pr view <#> --repo "$REPO" --json headRefName -q .headRefName)" -L1 --json databaseId -q '.[0].databaseId')
gh run view "$rid" --repo "$REPO" --log-failed | grep -iE 'error|fail|drift|✗' | head
```

**Red check → fix:**

- **`verify / build`, step "contract is what the code emits"** — the committed
  OpenAPI no longer matches the code. `npm run contract:generate`, commit
  `openapi/ezacto-v1.openapi.json`. Never hand-edit the artifact; the generator
  owns it.
- **`theme:check` failing** (it guards `typecheck`, `build` and the web suite
  alike, so it can redden any of them) — theme tokens changed without
  regenerating. `npm run theme:generate -w @ezacto/web`, then commit
  `apps/web/src/generated/theme-manifest.ts`.
- **`verify / lint`, step "theme tokens meet WCAG AA"** — a palette pair is below
  AA. Fix the token; the check is the requirement, not the obstacle.
- **`verify / test (db N)`** — reproduce the one shard rather than the suite:
  `npm test -w @ezacto/db -- --shard=N/12`.
- **`verify / test (web)`** — the browser suite. `npx playwright install
  --with-deps --only-shell chromium` once locally, then `npm test -w @ezacto/web`.
- **`verify / web-runtime-compatibility (22|25)`** — green on one Node and red on
  the other is a runtime difference, not a flake. Fix it in the source, not by
  narrowing the matrix.
- **`verify / secrets`** — gitleaks. If it is a real credential, rotate it first,
  then remove it; rotation is the fix and deletion is the cleanup. If it is a
  reviewed false positive, add one `commit:path:rule:line` fingerprint plus its
  reason to `.gitleaksignore` — never a path glob, and never quote the offending
  value in the comment.
- **`verify / container`** — Docker first-run or the backup/restore drill:
  `npm run test:container` locally.
- **A new workspace's tests never ran** — the `test` matrix names its workspaces
  explicitly, so a new package is invisible to CI until it is added there.
- **Merge conflict / `DIRTY`** — `git merge origin/main`, resolve, push. Never a
  rebase; the history is full of back-merges of `main` into the branch and that
  is the intended shape.

## `/pr feedback` — address review comments

```bash
gh pr view <#> --repo "$REPO" --comments     # issue-level comments
gh api "repos/$REPO/pulls/<#>/reviews"       # review summaries
gh api "repos/$REPO/pulls/<#>/comments"      # inline threads, with path + line
```

For each comment: state the ask, make the change on the branch, commit, push,
then reply on the thread saying what you did (`gh pr comment <#> --repo "$REPO"
--body "…"`, or the review-comment reply API for an inline thread). Re-run
`/pr checks` until green. Keep replies specific, and do not report as addressed
anything you only partly did.

## After the merge

`deploy.yml` runs on every push to `main`: the same `verify.yml`, then the dev
deployment. Prod is a manual dispatch and only ever from `main`. So a merge
ships something — read the deploy run, not just the merge. Then close the issue
with the same what / why / verified summary, per `.codex/sdlc-playbook.md`
step 11.

---

## Conventions (`bootstrap.md` § Hard rules, `PROCESS.md`)

- A PR and a green `verify` to merge. Merge commit or squash — **never a
  rebase**, and no force-push to `main`.
- One PR per issue. Small enough to read in one sitting; a PR that is not is two
  PRs. Surgical diffs — no adjacent refactors riding along.
- No stubs. A story is done when it is real.
- No AI or co-author attribution anywhere.
- New behaviour ships with tests; a bug fix ships with the test that would have
  caught it. A red gate is fixed, never bypassed.

This skill is mirrored at `.codex/skills/pr/SKILL.md` (a thin pointer back here,
so the procedure lives in one place).
