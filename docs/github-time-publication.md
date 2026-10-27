# GitHub time publication

Issue #1176 adds an optional Issues-write lane to the GitHub reader (#1175).
The reader's App manifest remains read-only. Hosted publication remains off
(D15). No provider permission is granted by this code or by enabling a local
setting. A GitHub administrator first reviews and grants Issues write on the
selected installation; eZacto then verifies that permission with an installation
token narrowed to exactly one mapped repository.

A native eZacto administrator enables the connection policy, previews a linked
entry's destination, date and duration, then opts that individual link in.
Unselected links remain unpublished. Publication sends only the date and duration
plus an opaque connection marker; it never sends notes, rates, invoice or payment
data. Local time remains authoritative and is never modified by publication.

The company Work tracking section shows pending, published, deferred, ambiguous,
conflicted, failed, adopted and retired work. One native scheduler invocation
handles one publication, with a shared dispatch lease and provider cooldown.
The per-entry lease serializes destinations. Moving a link first retires its
previous comment; an unresolved old comment blocks a new destination until an
administrator resolves or explicitly unlinks it.

A create attempt is durable before HTTP. A lost acknowledgement is reconciled
using both the authorized GitHub App/Bot identity and the opaque marker. Only a
complete listing after 60 seconds can prove absence. One automatic retry is
allowed; a second unacknowledged attempt remains held for explicit Retry (D20).
A truncated listing, multiple matching comments, missing permission, or unknown
outcome never justifies another blind POST. Reads are bounded to five 100-comment
pages; larger threads remain ambiguous until an operator resolves them.

A human edit or removal creates a conflict. **Unlink** is the safe default and
stops managing the remote comment without deleting it. **Adopt** preserves the
verified App-owned remote edit until a later local source change. **Restore**
requires confirmation, rereads the exact App-owned comment and overwrites only
that verified baseline, or recreates it after a confirmed 404. Every action is
version-fenced and audited. A comment without both the App identity and marker
cannot be overwritten or removed, even through Restore.

The transport verifies immutable repository and issue IDs before a mutation,
rejects redirects, and uses only api.github.com. Browser responses never include
App private keys, tokens or the opaque marker. Authority, connection generation,
source version, policy generation, lease and restore incarnation are checked
immediately before a mutation. A request already accepted by GitHub cannot be
recalled; its known receipt remains journaled after disconnect. A restored
instance cannot resume the old policy: restore rotates its publication
incarnation, retains remote receipts, and requires fresh administrator review.

## Acceptance status

Local native SQLite/D1, transport and browser fixtures are engineering evidence,
not proof of real GitHub permissions or delivery. The real owned GitHub App and
repository acceptance remains pending the separately requested security grant.
No App creation, permission grant or real GitHub comment was performed for this
implementation. Do not claim the real-provider acceptance gate complete until
that explicit owned test has passed.

Official API references: [GitHub issue comments](https://docs.github.com/en/rest/issues/comments)
and the [GitHub REST schema](https://github.com/github/rest-api-description),
including the nullable `performed_via_github_app` and comment `issue_url` fields.
