# GitHub read verification: contract

Issue: #1175 (story under #1008). The native store, App-authenticated reader, administrator API, and manifest
custody are implemented. Rollout still requires the coordinated migration,
administrator UI verification, and owned provider acceptance. No production
GitHub request has been made by the component tests. Plan context:
`work-item-integration-plan.md`.

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

## Native reader components

`packages/integrations/src/work-items/github-client.ts` signs RS256 App JWTs,
accepts GitHub-generated PKCS#1 and PKCS#8 PEM, and requests a short-lived token
restricted to exactly one immutable repository ID with Issues and Metadata read
permissions. Tokens are held only in memory. The HTTP boundary uses the fixed
GitHub API origin, refuses redirects, bounds decoded responses and deadlines,
and returns retry decisions instead of sleeping or repeating HTTP operations.
The current API version is `2026-03-10`.

`packages/db/src/github-read.ts` implements the reusable contract on actual
SQLite immediate transactions and D1 batches. `github-read-schema.ts` is an
internal, unregistered schema component pending the coordinated dense migration.
Each issue has its own bounded metadata record; aliases, resources, checkpoints,
cooldowns and delivery receipts are separate rows.

`github-runtime.ts` verifies the original raw bytes before UTF-8/JSON parsing,
binds the installation and approved immutable repository IDs, and journals only
the safe metadata projection. Pending effects remain durable after a failed
atomic apply. Application and the applied receipt commit together; a completed
exact signed replay can be acknowledged after revocation without a new write.
Pending effects retain their connection generation, so reconnection cannot admit
old provider work. The event header is not HMAC-covered: installation revocation
additionally requires the matching App ID and an installation-shaped body.

One reconciliation call fetches at most one page. It revalidates immutable
repository/account identity, retains aliases after verified renames, filters PRs,
and refuses malformed non-PR rows without advancing the checkpoint. Updated-order
REST pages are mutable offsets: editing or deleting an earlier-page issue can
shift an unseen old issue into an already-consumed offset. A completed sweep
therefore leaves its watermark null and retains a periodic full-rescan obligation;
the next sweep starts at page one without a `since` filter. This is eventual
reconciliation after changes settle, not a complete snapshot of a changing
repository. Versioned full-scan cursors resume bounded pages; older incremental
cursors restart once rather than mixing page scopes. Provider HTTP is outside
all SQL transactions. The scheduler persists a two-minute lease, a maximum of five failed attempts,
and provider cooldowns. Each minute tick handles one page outside the SQL
transaction. Administrator reconciliation resets retryable work while retaining
provider cooldowns. A disconnect fences all old leases and deliveries.

The native fixture suite executes both runtimes, including an injected SQLite
trigger failure inside D1/SQLite batches, reconstruction of pending deliveries,
page replay, immutable identity, alias ambiguity, cooldowns and generation fences.
The generated RSA keys and provider responses are invented fixtures, not owned
GitHub App/repository acceptance.

Official references: [installation tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app),
[manifest registration](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest),
[webhook validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries),
[repository issues](https://docs.github.com/en/rest/issues/issues).

## Administrator setup and custody

Set a dedicated `GITHUB_APP_ENCRYPTION_KEY` to canonical base64url for 32 random
bytes. The native administrator chooses a personal account or organization,
reviews a private App manifest, and submits it to GitHub. The App requests only
Issues and Metadata read access, subscribes to `issues` and `repository`, and
receives installation lifecycle events automatically. GitHub does not allow
manually subscribing to the installation events.

The one-hour setup state is random, persisted as a hash, and bound to the
initiating native user/session. The callback consumes it before the single
conversion request. The callback must still hold a current administrator
session when credentials are stored. The App private key and webhook secret
are encrypted with AES-GCM, authenticated to the deployment origin and App ID.
Neither appears in status, discovery, mapping, or callback responses. Lost or
ambiguous conversion attempts require a fresh setup attempt; no automatic
repeated conversion occurs.

Alternatively supply all three deployment secrets `GITHUB_APP_ID`,
`GITHUB_APP_PRIVATE_KEY`, and `GITHUB_APP_WEBHOOK_SECRET`; the PEM may use
escaped newlines. Direct deployment credentials take precedence over managed
setup. Neither path uses user sign-in credentials. Demo deployments disable
the reader. The encryption key is only for managed setup and must be retained
with encrypted database backups.

Administrators discover named installations and repositories in pages of at
most 100. Discovery mints a metadata-only token; subsequent issue reads mint a
token restricted to exactly the repository the administrator mapped to an
existing local project/task. Discovery does not create mappings. Read access
to stored issue metadata remains subject to current local permissions.

## Remaining rollout gates

- Register migration 0171 after the coordinated 0167–0170 sequence.
- Verify the native administrator UI and a real owned disposable App/repository.
- Prove backfill, signed delivery replay, rename, scope removal, and disconnect
  against that owned fixture before enabling production. Retain only IDs,
  counts, and sanitized outcomes as evidence; never payload bodies or secrets.

## Hosted-side asks

Defined from this repository only. Hosted needs to supply tenant-bound custody
of the App private key and webhook secret (one per tenant, never a shared root
credential) and route webhooks to the tenant's store by installation id.
