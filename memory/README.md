---
name: Memory README
description: How the memory/ system works — what belongs in it, the MEMORY.md index, the YAML frontmatter convention, and the four memory categories.
metadata:
  type: process
---

# Memory

**Durable project memory** — the small, curated set of things about this project
that are settled and true, and that a newcomer (human or agent) should read
before touching anything. It is deliberately short. If it grows past a screenful
per file, something in it belongs somewhere else.

## What belongs here, and what does not

The repo already has three other places that carry state, and memory is not a
fourth copy of any of them:

| Surface | Holds | Example |
|---------|-------|---------|
| `docs/` | the specification — how the product is supposed to behave | `docs/domain-model.md` |
| GitHub issues | the work — what is being built, by whom, against what acceptance | one issue per story |
| git history | what changed, when, and why | the commit message |
| `memory/` | the settled context none of the above states outright | why a choice was made, what a word means here |

A fact **graduates into** `memory/` once it stops moving. Something still being
argued belongs in the issue; something a reader has to obey belongs in `docs/`.
Keep entries terse and link out to the relevant `docs/` page rather than
restating it here — a duplicated spec is a spec that goes stale.

## Index

`MEMORY.md` is the index — one line per file with its category. Keep it in sync
when you add or remove a file. `MEMORY.md` is not itself a memory file; it is
the table of contents.

## Frontmatter convention

Every file here, this README and `MEMORY.md` included, opens with YAML
frontmatter:

```yaml
---
name: Short, human title
description: One or two sentences describing what this file covers, written for
  a reader who has not opened it.
metadata:
  type: reference   # one of: reference | decision | question | process
---
```

`metadata.type` sorts the file into one of four categories:

| type | What it holds |
|------|---------------|
| `reference` | Settled facts — the glossary, the technology stack. |
| `decision` | The decision log; each entry has a stable ID (`d-001`, …). |
| `question` | Open questions, tracked Active / Answered / Closed (`q-001`, …). |
| `process` | How the memory system itself works — this README and `MEMORY.md`. |

## Conventions

- **Stable IDs, never reused.** A decision or question keeps its ID for life. To
  reverse a decision, write a new one that supersedes it; do not edit the old
  one into something it never said.
- **Do not collide with the existing ID series.** `docs/` already cites
  architecture decisions as `D<n>`, model deviations as `DV-<n>`, and invariants
  as `inv-<nn>`. Memory uses lowercase `d-NNN` and `q-NNN` precisely so a reader
  can tell the two apart at a glance.
- **Dates are absolute.** `2026-01-31`, never "last Thursday".
- **No secrets, no credentials, no personal contact details.** The `secrets` job
  in `.github/workflows/verify.yml` scans the full history, and it is right to.
- The files committed here are **skeletons**: every section is a placeholder
  marked `(fill in)`. Replace the guidance with real content; do not ship the
  example wording as though it were a fact.
