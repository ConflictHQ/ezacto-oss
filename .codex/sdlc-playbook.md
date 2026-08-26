# Agentic SDLC — Codex adapter

Same contract as the umbrella's `knowledge/docs/agentic-sdlc.md`; same routing
source `agents/sdlc-routing.json`. Codex has no Workflow orchestrator, so the
pipeline runs as **sequential tasks**, one per stage, each opened with the
stage's tier model per the routing JSON (OpenAI column).

For each groomed story (a `specs/**/NN-*.md` with `## Acceptance` + `estimate`):

1. **Triage** (MENIAL): verify story-standard conformance + deps done; extract
   estimate/labels/issue. Not ready → stop, report blockers.
2. **Research** (STANDARD): context pack — files to touch, constraints (DV-1..13,
   invariants), prior art. No code.
3. **Plan** (by estimate): file-level plan; every acceptance checkbox mapped to
   a planned test.
4. **Build** (by estimate): `git worktree add ../ez-wt-<id> -b feat/<id>`; ALL
   work in that worktree; no stubs; lint+typecheck green; surgical commits.
5. **Unit test** (STANDARD): a test per acceptance checkbox; suite green.
6. **Adversarial** (HARD; CRITICAL if labels ∩ {money,auth,migration,invariants}):
   three refutation passes — correctness / security / edges+invariants. On
   OpenAI, CRITICAL = run a **second independent pass**, not a bigger model.
7. **Review** (HARD/CRITICAL): AC satisfaction, line-traceability to the story,
   reuse/simplicity. approve | request_changes.
8. Failures at 5–7: fix in the SAME worktree; after 2 failed rounds escalate one
   tier once; a third failure parks the story (blocked + open question).
9. **Ship** (MENIAL): push; ONE PR per story; body = what/why/verified +
   `Closes #<issue>`; **no AI attribution of any kind**.
10. **Merge** (checkpoint): only with explicit auto-merge instruction AND CI
    green AND approval — merge commit/squash, **never rebase**; remove worktree.
11. **Validate** (STANDARD) then **Close** (MENIAL): suite on main; close the
    issue with a what/why/verified summary.

Standing rules ride along: no rebases · no AI attribution · surgical diffs ·
red gates get fixed, never bypassed · secrets never in git · submodules push
before parents.
