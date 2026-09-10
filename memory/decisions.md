---
name: Decisions Log
description: The running log of significant project decisions — what was decided, when, why, and who was involved. Each decision has a stable ID (d-001, …). (Replace the example blocks with real decisions.)
metadata:
  type: decision
---

# Decisions Log

> Placeholder. Replace the example blocks with real decisions.

Record a decision here when it changes scope, architecture, process, or a
commitment — the kind of choice a future contributor will otherwise re-litigate
because the reason was never written down. Routine implementation choices belong
in the commit message, not here.

## Convention

- Each decision is a block with a **stable ID** (`d-001`, `d-002`, …). Never
  renumber and never reuse an ID. To reverse a decision, write a new one that
  supersedes it and mark the old one **Superseded by d-NNN**.
- Newest at the top.
- Capture **what** was decided, **when**, **why** (rationale and the alternatives
  that lost), and **who** was involved.
- If the decision is one a reader has to obey while writing code, the decision
  also has to land in `docs/` or `bootstrap.md`. This log explains it; those
  files enforce it.
- `d-NNN` is deliberately distinct from the `D<n>` architecture decisions and the
  `DV-<n>` model deviations already cited across `docs/`. Do not mix the series.

## Decisions

### d-002 — [Decision title] _(fill in)_

- **Date:** _(fill in: YYYY-MM-DD)_
- **Decision:** _(fill in: what was decided, in a sentence or two)_
- **Context / rationale:** _(fill in: the problem it solves, and what it costs)_
- **Alternatives considered:** _(fill in, or "none")_
- **Owner / participants:** _(fill in)_
- **Where it is enforced:** _(fill in: the doc, gate, or test that makes it real — or "nowhere yet")_
- **Status:** _(fill in: Adopted / Superseded by d-NNN)_

### d-001 — [Earlier decision] _(fill in)_

- **Date:** _(fill in: YYYY-MM-DD)_
- **Decision:** _(fill in)_
- **Context / rationale:** _(fill in)_
- **Alternatives considered:** _(fill in, or "none")_
- **Owner / participants:** _(fill in)_
- **Where it is enforced:** _(fill in)_
- **Status:** _(fill in)_
