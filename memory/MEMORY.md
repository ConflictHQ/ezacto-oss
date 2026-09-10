---
name: Memory Index
description: Index of the durable project-memory files — one line per file with its category. Read this first to know what memory exists and where it lives.
metadata:
  type: process
---

# Memory Index

`memory/` is the durable, hand-curated context for this repo — the small set of
always-true things a newcomer (human or agent) reads first. Every file below
carries YAML frontmatter (`name`, `description`, `metadata.type`), and the
`type` sorts it into one of four categories:

- **reference** — settled facts (the glossary, the technology stack).
- **decision** — the running decision log, with stable IDs (`d-001`, …).
- **question** — open questions, tracked Active / Answered / Closed (`q-001`, …).
- **process** — how the memory system itself works (this index, the README).

What is still moving lives in the GitHub issue; what a reader has to obey lives
in `docs/`. A fact graduates into `memory/` once it is settled. See
[`README.md`](README.md) for the full convention.

## Files

| File | Type | Purpose |
|------|------|---------|
| [`glossary.md`](glossary.md) | reference | One-line definitions of the product, domain, and role terms used here. |
| [`tech-stack.md`](tech-stack.md) | reference | The technology behind the product — runtime, data, surfaces, toolchain. |
| [`decisions.md`](decisions.md) | decision | The running log of significant decisions (`d-001`, …) and their rationale. |
| [`open-questions.md`](open-questions.md) | question | Open questions tracked Active / Answered / Closed (`q-001`, …). |

> `README.md` and this `MEMORY.md` are process docs, not memory. Keep this table
> in sync when you add or remove a memory file.
