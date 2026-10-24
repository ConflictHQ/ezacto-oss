# Jira Cloud worklog contract

Issue: #1178, parent #1008. Contract only. Nothing here calls Jira, stores a
credential or changes a schema; it settles the interface a real adapter must meet
so the adapter can be built once #1175 and #1176 land. Types and pure rules live in
`packages/integrations/src/work-items/jira.ts`. The provider checks are a suite,
`runJiraProviderContract(name, factory)` in
`packages/integrations/test/fixtures/jira-provider-contract.ts`; a real adapter supplies a
harness factory and runs the same suite the fake does
(`test/fixtures/fake-jira-provider.ts`, run from `test/jira-worklog-contract.test.ts`).

## Why a separate command

`WorkItemTimeNote` carries a day and seconds, which suits a comment. A Jira worklog
needs a start instant with offset, an author and `timeSpentSeconds`, so
`JiraWorklogInput` is its own command. The shared journal (#1176) keys, serializes and
fences publications; this contract does not redefine it.

## Invariants

1. Scopes: reading needs `read:jira-work` only. Worklog writes add `write:jira-work` under
   a separate consent. `offline_access` is requested only for refresh custody. No
   escalation without a new administrator consent.
2. Binding: cloud id, site and project allowlist come from the credential at
   connection time. No method accepts them, and webhook bodies are never trusted for them.
3. An issue outside the allowlist is "not found". Identity is the immutable issue id,
   not the key. A stale event (not strictly newer `updatedAt`) cannot restore old state
   (`applyJiraIssueEvent`).
4. `started` is never invented. A duration-only entry is held (`missing_start`,
   `missing_offset`). The caller resolves the UTC offset, including DST, and the wire
   value is rendered in that offset. `startedAt` must carry `Z` or an explicit offset; a
   date-only or zone-less string is held (`invalid_start`) because it would parse in the host
   timezone. `utcOffsetMinutesAt(instant, zone)` derives the offset for a caller.
5. Authorship: only the consenting account's own entries are written. An unmapped or
   different account is held, never published through an administrator.
6. Seconds map to `timeSpentSeconds`. The body has no estimate field, so remaining
   estimates cannot change.
7. Replay: one idempotency key resolves to one worklog, found by a marker bound to the cloud id and
   the issue (`jiraMarker`); a same-key worklog from another connection or issue is never adopted. On `ambiguous`, list worklogs and match the marker before any retry; if
   absence cannot be shown, hold for an operator.
8. Remote edit, delete or a foreign record is a visible conflict
   (`classifyJiraWorklog`). It never rewrites local actuals or the remote record.
9. Failures are sanitized codes: `scope_missing`, `unauthorized`, `forbidden`,
   `not_found`, `rate_limited` (with Retry-After seconds), `ambiguous`.
10. Listing is bounded and cursor-based; the checkpoint advances only after a whole
    page is applied (`syncJiraWorklogs`).

## Left to the adapter (not settled here)

Wire shape of the marker (worklog property or comment text), the exact webhook
signature and replay window for the registered app, token refresh and rotation,
rate-limit numbers, and the owned disposable Jira Cloud acceptance run. The fake's
`x-hub-signature` check is a stand-in, not Atlassian's documented scheme.
