# Contributing

## Licence, in one paragraph

ezacto is licensed under the [GNU AGPL v3](LICENSE). If you run a modified
ezacto as a network service, you have to offer your users the source of your
modifications. Running it unmodified, self-hosting it, or using it inside your
own company costs you nothing and obliges you to nothing.

## Why there is a CLA

CONFLICT LLC holds the copyright and also offers ezacto under commercial terms
to people who do not want the AGPL's obligations. That is only possible while
one party can license the whole work. A contribution merged without a
contributor agreement stays yours, licensed to the project under the AGPL like
anyone else's — and from that moment the project cannot be offered commercially
without your individual permission.

So we ask for the agreement in [`CLA.md`](CLA.md) before merging. It does not
take your copyright away; it grants a licence alongside the rights you keep.
Sign it by adding one line to [`contributors.md`](contributors.md) in the same
pull request as your first contribution.

## Before you open a pull request

Read [`bootstrap.md`](bootstrap.md) — it is the entry point for the whole
repository, and covers the architecture, the conventions and the process.

The gates are lint, typecheck, test and build. Run them the way CI does:

```
npm ci
npm run check      # typecheck + lint
npm test
```

CI runs the same gates fanned out across runners in
[`.github/workflows/verify.yml`](.github/workflows/verify.yml), which the merge
and the deploy both call.

Tests are the argument that a change works. A test that passes with and without
your change proves nothing — before you open the pull request, revert your
source change while keeping the test and confirm it fails.

## What the runtime is

A Cloudflare Worker with exactly three bindings: **D1**, **Queues** and **R2**.
There is no Redis, no Postgres, no job runner and no frontend framework — the
shell is vanilla TypeScript in `apps/web`, server-rendered by the Worker.
Proposals that add a fourth dependency need to earn it in the issue first.

Migrations are a hand-maintained ledger in `packages/db/src/migrations`, applied
lazily. Adding one is a new file in that ledger, never an edit to a shipped one.

## Reporting a security issue

Do not open a public issue. Email <security@ezacto.com> with what you found and
how to reproduce it.
