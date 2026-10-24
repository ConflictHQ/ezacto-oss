# Work-item integrations: buildable plan

Issue: #1008. Audited 2026-10-23. This is the implementation boundary, not a
claim that provider synchronization is available. The first provider is GitHub;
Linear and Jira Cloud remain separate follow-on stories.

## Existing implementation

| Boundary | Source | What exists |
| --- | --- | --- |
| Provider identity and input rules | `packages/core/src/work-item.ts` | GitHub is the only registered provider; bounded printable item IDs and HTTP(S) links. |
| Connection/link persistence | `packages/db/src/work-items.ts` | One connection per provider, administrator owner, server-selected deployment credential reference, disconnect retaining links, scoped immutable links. A time entry has one item per connection; an item can have many entries. |
| Authenticated API | `packages/api/src/work-items.ts` | Native administrator sessions manage connections. Entry-link authorization and API scopes are enforced independently. Credentials are never returned. |
| Provider seam | `packages/integrations/src/work-items/provider.ts` | Types for verified deliveries, item snapshots and idempotent time notes; only a fake provider implements them. This does not prove real provider replay safety. |
| Runtime configuration | `entries/worker/src/runtime.ts`, `entries/container/src/runtime.ts`, `entries/container/src/config.ts` | `GITHUB_WORK_ITEMS_CREDENTIAL` presence enables connection setup. No provider HTTP calls, sync scheduler or inbound issue webhook. The stock Worker deployment does not install this secret yet. |
| Existing references | `time_entries.external_ref`; Chrome `src/adapters.ts` in ezacto-chrome | Browser URL-derived work-item metadata. It remains unverified input until the connected provider confirms it. |
| Identity | `packages/api/src/github.ts` | GitHub sign-in, not repository authorization or an installation credential. |

The existing core, database, API and fake-provider tests cover this foundation.
Do not rebuild these tables, reuse sign-in credentials, or advertise the fake as
an adapter. The missing pieces are real provider verification, canonical remote
identity, scoped mappings, delivery/checkpoint journals and visible reconciliation.

## Provider comparison and selected direction

| Provider | First supported entities and credential | Local/remote ownership and time representation |
| --- | --- | --- |
| GitHub | Selected installation repositories and issues; GitHub App with repository Metadata read and Issues read. Filter pull requests returned by issue-list endpoints. Add Issues write only for the separately enabled comment slice. | GitHub owns immutable issue ID, title, open/closed state and canonical URL. An administrator maps a repository to an existing local project and default task. eZacto owns entries, seconds, spent date, approval, rates and invoice state. Optional time publication is an app-owned issue comment, never a claim of a native worklog. |
| Linear | Selected workspace/teams and issues through OAuth, initially `read`; enable comment-write scope only for the later opt-in writer. Workspace webhook administration requires an administrator or OAuth `admin`, so manual administrator webhook setup is supported without silently escalating a read connection. | Linear owns issue ID, title, workflow state and URL. Preserve the full remote state separately; the common open/closed projection must document its exact state-type mapping. Local time stays authoritative; optional publication is a comment. |
| Jira Cloud | Selected cloud/site and projects/issues via a registered OAuth 2.0 (3LO) app. First read scope `read:jira-work`; a worklog writer additionally requires `write:jira-work`, with refresh custody when `offline_access` is requested. No Jira Server/Data Center parity. | Jira owns issue ID/key, status and native worklog ID. Map `timeSpentSeconds` from local seconds and `started` from the explicitly selected timestamp/offset. Initial writes cover only entries belonging to the consenting remote author; never impersonate another staff member through an administrator token. Worklog import and estimates/remaining-estimate changes are excluded. |

These are selected engineering defaults for the plan. Comment publication is off
by default and requires a separate administrator enablement plus per-link opt-in.
No provider event creates, bills, approves or changes local time automatically.
The Jira writer must extend the typed command for its required start timestamp,
UTC offset and remote author mapping: the current day/seconds comment interface
cannot express those fields. Duration-only entries without an explicit start time
are held for input rather than given an invented timestamp.
Remote title/state changes update metadata only, not the project's billing or
local task state. A remote edit of an app-owned time note is a visible conflict,
not permission to change actual time or overwrite a human's edit.

Provider documentation reviewed: [GitHub issues](https://docs.github.com/en/rest/issues/issues),
[GitHub permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens),
[App permission selection](https://docs.github.com/en/apps/creating-github-apps/setting-up-a-github-app/choosing-permissions-for-a-github-app),
[Linear OAuth](https://linear.app/developers/oauth-2-0-authentication),
[Linear webhooks](https://linear.app/developers/webhooks), and
[Jira worklogs](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-worklogs/).
The exact required permission set must be pinned to the operations used by each
adapter; requesting write permissions is not part of connecting a reader.

## Connection, custody and isolation

Reuse the current native administrator-session management and audit events. Extend
the connection with a server-verified installation/workspace/cloud ID and an
administrator-selected resource allowlist. A provider callback cannot choose a
local organization, project, credential reference or secret name. In the
single-organization core every database and its deployment credential belong to
one organization; hosted must supply distinct tenant-bound custody, not a shared
root credential.

For GitHub, the deployment holds the App private key and webhook signing secret;
store installation identity, not an installation access token, in the database.
Mint short-lived installation tokens server-side for the approved repositories.
Wire the required secret names through both stock deployment rendering and the
container configuration when the real adapter lands. Rotation invalidates cached
access tokens and verifies the replacement before resuming work. Secrets, raw
provider errors, private issue bodies and webhook payloads do not enter telemetry.

Disconnect first fences new jobs and inbound updates, then drops local credential
references/cached tokens and offers provider-side revocation instructions. Remote
revocation, uninstall or scope reduction also stops jobs and appears in the
reconciliation report. A request already sent cannot be recalled. Keep the
minimal delivery/remote-ID audit needed to explain completed work; disconnect does
not delete previously posted provider content or local financial history.

Terms boundaries reviewed: [GitHub API terms](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service#h-api-terms)
apply to API use and abusive/excessive requests; [Linear terms](https://linear.app/terms)
cover authorized service use and customer submissions; [Atlassian developer terms](https://developer.atlassian.com/platform/marketplace/atlassian-developer-terms/)
and [Cloud security guidance](https://developer.atlassian.com/cloud/jira/platform/security-overview/)
cover the selected app/consent model. Use the official API and an explicitly
consenting owned organization for acceptance; no scraping, customer API-key
collection or unapproved data redistribution is part of this plan. Recheck terms
and app distribution requirements when registering each real integration.

## Canonical mapping and delivery contract

Add a remote-item record keyed by connection and immutable provider object ID.
Keep the current opaque link IDs as aliases so repository renames, case changes
and issue-key changes cannot duplicate links or reinterpret historical references.
Store canonical URL, title, remote state, last verified revision and visibility
status. Fetch only from fixed provider API origins and verify that the returned
object belongs to the approved installation/resource. Untrusted `external_ref`
and URLs never become fetch targets or credential destinations.

GitHub is read-only first: verify an explicitly linked issue, refresh title/state,
process signed issue/repository/installation events, and resume bounded backfill.
Do not import issue bodies, comments, attachments, provider users or whole projects.
A missing/forbidden remote item marks the reference unavailable; preserve local
time and do not leak its title to a person who lacks local project access.

Webhook handlers verify signatures over bounded raw bytes before parsing and
journal `(connection, provider delivery ID)` before applying metadata. GitHub uses
`X-Hub-Signature-256`; other providers implement their own documented verification
and replay window. Remote versions/updated times plus authoritative refetch prevent
out-of-order events from restoring stale state. Delivery IDs are not proof that
all events arrived: bounded backfill and an explicit full reconcile remain needed.
See [GitHub verification](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).

Persist backfill scope, provider pagination token and overlap watermark per
connection/resource. Advance only after a whole bounded batch is durably applied;
never infer completeness from the newest object in a truncated response. Provider
calls run outside database transactions. Persist rate-limit reset/Retry-After
cooldowns; use bounded jitter for retryable reads, and stop for invalid credentials
or lost scope. Do not sleep through a UI request. A successful reconnect resumes
only after its identity and resource mapping are revalidated. Follow
[GitHub retry guidance](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api),
[Linear limits](https://linear.app/developers/rate-limiting), and
[Jira limits](https://developer.atlassian.com/cloud/jira/platform/rate-limiting/).

The later writer extends the current fetch/post provider seam with explicit
update, delete and reconciliation commands; those operations are not implemented
by the present interface. It adds a durable local publication journal keyed by connection,
entry and destination. Serialize writes for that key, retain remote ID and last
published version, and record the exact seconds/date being published. The current
`idempotencyKey` interface is an obligation for the adapter, not a promise that a
provider POST accepts an idempotency header. For comments, verify both the app
author and an unguessable connection-bound marker before treating a remote note
as ours. After an ambiguous timeout, reconcile remote state before any retry;
if absence cannot be established, hold for an operator instead of risking a
second note/worklog. Date/item moves reconcile the old publication explicitly.
Edits/deletions affect only a verified app-owned remote record and require the
link's publication policy; remote human edits or deletions pause and surface a
conflict rather than being silently recreated. Never erase local actuals.

## Verification, visibility and ordered stories

Administrator reconciliation shows provider, connection/resource, last successful
checkpoint, pending/deferred count, next retry time, revoked scope, item-not-found,
ambiguous publication and unresolved edit/delete conflicts. Show sanitized failure
codes and a retry/reconcile action; no token, issue body or provider error dump.
Members can inspect only their authorized link's verified/unavailable state.

Before availability claims, sanitized fixtures cover signature rejection, replay,
out-of-order events, repository transfer/rename, pagination boundary/crash recovery,
429 cooldown, timeout-after-write, simultaneous publication, changed date/item,
human edits/deletes, disconnect during a claim, revoked scope, cross-organization
binding and ordinary member restrictions. SQLite and D1 enforce the same journal
uniqueness/fences. An owned disposable provider organization then proves that
replaying a delivered event or an acknowledged/ambiguous time publication creates
no duplicate local time or remote note/worklog. Record redacted IDs/counts and
cleanup results; fake-provider tests alone cannot satisfy this acceptance.

Implementation order is GitHub verification/backfill, then its separately opt-in
writer. Linear and Jira have independent stories depending on the tested shared
journal/mapping contract; their provider-specific authorization and native worklog
authorship must be verified before enabling writes. Story links are recorded below
once filed. No feature is marketed as universal or bidirectional time sync.

Ordered implementation stories: [GitHub read verification #1175](https://github.com/ConflictHQ/ezacto-pvt/issues/1175),
[GitHub opt-in publication #1176](https://github.com/ConflictHQ/ezacto-pvt/issues/1176),
[Linear #1177](https://github.com/ConflictHQ/ezacto-pvt/issues/1177), and
[Jira Cloud #1178](https://github.com/ConflictHQ/ezacto-pvt/issues/1178).
