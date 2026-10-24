# GitHub read verification: contract

Issue: #1175 (story under #1008). **Contract only.** This settles the interface
and invariants for the GitHub read slice so the plumbing can land later without
renegotiating them. Nothing here talks to GitHub, holds a credential, changes a
schema or advertises availability. Plan context: `work-item-integration-plan.md`.

## What exists in this slice

| Piece                                                                                             | File                                                             |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Pure rules: reference parsing, issue mapping, merge, signature check, event shape, retry decision | `packages/integrations/src/work-items/github-read.ts`            |
| Store port (`GithubReadStore`) any SQLite/D1 implementation must satisfy                          | same file                                                        |
| In-memory reference store                                                                         | `packages/integrations/test/fixtures/fake-github-read-store.ts`  |
| Reusable store acceptance suite                                                                   | `packages/integrations/test/fixtures/github-read-store-suite.ts` |
| Tests for the rules and the fake                                                                  | `packages/integrations/test/github-read.test.ts`                 |

A real store runs `describeGithubReadStore(name, make, crashOnBatchItem)` against
its SQLite and D1 backings. The same suite must pass on both.

## Invariants

1. **Fixed origin.** Requests go to `https://api.github.com` only. A user-supplied
   reference is parsed into an alias (`owner/repo#n`); a URL on any other host,
   scheme, port or with userinfo is rejected. A response whose `html_url` is not
   `github.com`, whose number differs, or which names a repository other than the
   approved one, is discarded, not stored. A renamed or transferred repository is
   accepted only when the caller lists its new name for that repository id.
2. **Immutable identity.** An item is keyed by connection and GitHub issue id.
   Names are aliases that only grow, so rename, case change and transfer cannot
   duplicate or reinterpret a link. Lookup by alias is per connection.
3. **Pull requests are never items.** Any object with `pull_request` is dropped.
4. **Metadata only.** Stored: id, number, canonical URL, title (capped at 1024),
   open/closed, GitHub `updated_at`, aliases, visibility. No body, comments,
   labels, users. No field touches seconds, rates, invoices or project billing.
5. **One merge rule** for backfill and webhooks: a strictly newer `updated_at`
   wins; older, or equal-but-different, is `stale` and changes nothing. An
   `unavailable` row is revived by any visible revision at least as new (a
   successful read after restored access, undelete or transfer back). Restoring
   a resource to `active` alone does not revive items; a read does.
6. **Webhook order of operations:** size bound, then HMAC-SHA256 over the raw
   bytes (`X-Hub-Signature-256`, constant-time `crypto.subtle.verify`), then
   parse, then bind installation and repository to the connection allowlist
   (caller), then `recordDelivery(connection, deliveryId)`, then apply. A
   duplicate id applies nothing. Cap: 1 MiB.
7. **Backfill is all-or-nothing per page.** `applyBatch` applies the page and
   advances the checkpoint in one transaction guarded by `expectedVersion`.
   A crash applies nothing and leaves the cursor; a stale version is `conflict`.
   Completeness is never inferred from the newest item of a truncated response.
8. **Provider I/O never inside a SQL transaction.** Every store method is one
   transaction; fetching happens before `applyBatch`.
9. **Durable cooldowns.** `decideGithubRetry` returns an epoch-ms `notBefore`
   (`retry-after`, else drained `x-ratelimit-reset`, else exponential backoff,
   jitter at most +25 percent, 5 attempts). `setCooldown` persists it and never
   shortens it. 401 stops as `invalid_credentials`, other 403 as `lost_scope`,
   404/410 marks the item `unavailable`.
10. **Fence before revoke.** `fence` makes every later delivery, item and batch
    throw `GithubStoreFencedError`, as do resource-state, rename and cooldown
    writes; it is idempotent and per connection and is checked before any
    version. Items, links and local time are retained.
11. **Explicit states, not silent failure.** Resource: `active`, `renamed`,
    `transferred`, `deleted`, `access_lost`. Connection: `active`,
    `disconnecting`, `disconnected`, `revoked`. `reconciliation()` returns these,
    counts, `deferredUntil` and closed-vocabulary failure codes only; never
    provider text, tokens or issue bodies.
12. **Scoping.** A batch holds only items of its own connection and repository.
    An alias shared by items of more than one repository (a reused name) is
    ambiguous and resolves to nothing. `installation_repositories` removal yields
    one `repositories_lost` effect listing every repository. `unsuspend` and
    `added` are ignored; recovery comes from the next successful read.
13. **Visibility.** The store holds provider facts for the connection. Whether a
    member may see an item's title stays decided by local project permissions at
    the API layer, independent of this port.

## Not in this PR (the plumbing)

- A migration for remote-item, alias, delivery-journal, checkpoint, resource and
  cooldown tables, and the SQLite/D1 `GithubReadStore`.
- A real `fetch` client using the GitHub App installation token, and the App
  JWT/token minting with the private key.
- `GITHUB_APP_*` secrets in the stock Worker and container configuration, the
  inbound webhook route, the scheduler, and the administrator reconciliation UI.
- API contract entries and OpenAPI for resource mapping and reconciliation.
- Owned disposable GitHub App/repository acceptance, which fakes cannot satisfy.

## Hosted-side asks

Defined from this repository only. Hosted needs to supply tenant-bound custody
of the App private key and webhook secret (one per tenant, never a shared root
credential) and route webhooks to the tenant's store by installation id.
