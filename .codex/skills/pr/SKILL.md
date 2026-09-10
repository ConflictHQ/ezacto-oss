---
name: pr
description: gh wrapper for the PR lifecycle on this repo — open a process-compliant PR (preflight gate, body template, reviewer notes), read CI output and diagnose a red check, and address review feedback. Use when opening a PR, when a check is red, or when responding to review comments. Skip for local-only commits with no PR intent, and for non-GitHub remotes.
---

# /pr — PR lifecycle helper (gh wrapper)

This skill mirrors [`.claude/skills/pr/SKILL.md`](../../../.claude/skills/pr/SKILL.md)
— read and follow that file for the full procedure (`open` / `checks` /
`feedback`, including the preflight gate, the body template, and the red-check
table). The content is kept in one place so the two runtimes cannot drift; the
**policy** it enforces lives in `bootstrap.md` (Hard rules) and `PROCESS.md`, and
the agent ceremony for the same steps is `.codex/sdlc-playbook.md` steps 9–11.

**Usage:** `/pr open [#issue] [@reviewer…]` · `/pr checks [#PR]` · `/pr feedback [#PR]`

Quick reference:

- Repo and identity are read, never hardcoded: `gh repo view --json nameWithOwner
  -q .nameWithOwner` and `git config user.email`.
- Green before you open: `npm run verify` — the same definition `verify.yml`
  runs for the merge and the deploy. `npm run test:container` and the gitleaks
  history scan are separate CI jobs and are not part of it.
- Checks surface as `verify / <job>`; `ci.yml` has no push trigger, so nothing
  runs until the PR exists.
- Merge with a merge commit or a squash — **never a rebase**; resolve conflicts
  with `git merge origin/main`.
- **No AI attribution** in commits, PR bodies, or comments. One PR per issue,
  surgical diff, no stubs, and a test that has been shown to fail without the
  change.
