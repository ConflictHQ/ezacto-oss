# Account closure data inventory

Related: [operator policy and request lifecycle](account-erasure-retention.md).
This inventory describes local closure, not a claim of complete erasure or legal
compliance. Operators decide the actual basis, period/release condition and
review target for each retained category. A selected law is not that basis.

| Data | Local closure handling | Residual review |
| --- | --- | --- |
| `users` telephone, employee ID, avatar URL, imported user ID, preferences, grants, capacity and access flags | Clear optional fields; disable access and privileged roles irreversibly | Stable internal user ID remains for referential integrity and closure evidence |
| First and last name | Keep only when reviewed work or billing relationships require identified attribution; otherwise replace with “Closed account” | Retained names must be reviewed alongside the actual work/payment records |
| Password hashes, sessions, API tokens, email verification/reset tokens, staff magic links, app handoff codes, MFA challenges, TOTP secrets, recovery codes | Delete, including expired/revoked rows; refuse subsequent inserts/updates tied to the closed user | No local bearer or password credential is retained as a deletion tracking credential |
| Email directory and linked provider identities | Delete raw address/subject rows | Instance-specific HMACs of verified addresses and provider subjects prevent stale callbacks from automatically provisioning a replacement; these are pseudonymous security records, not anonymous data |
| Calendar proposals (`calendar_proposals`: meeting titles and times offered as time, issue 428) | Delete. A meeting title is personal data and is not time worked; the time entry an accepted proposal became is retained under the time attribution row below | A title the person kept as the entry's note is time-entry text and follows that row |
| Planned allocations (`allocations`: planned hours per week for a person on a project, issue 1007) | Delete. A plan for someone who has left is moot and is not time worked | None; the activity-log events that recorded the plan follow the audit rules below |
| Work item connections and links (`work_item_connections`, `work_item_links`: which administrator connected a tracker and who linked an item, issue 1008) | Preserve the user ids as attribution; the rows hold no credential, only the name of a deployment secret | A link follows the time entry or project it is attached to |
| CSV import ledger (`csv_import_runs`, `csv_import_entries`: the mapping a file was applied through, which holds source email addresses, and one source key per imported row, issue 1012) | Retain. Keys are hashes and carry no personal data; the stored mapping is import provenance, and this slice has no tool to erase it | A source email in a stored mapping stays until an operator edits `csv_import_runs.mapping_json`; the time entries are retained under the time attribution row below |
| Roles, departments, teammate links, notification preferences, personal saved reports/pins/shares and pending QuickBooks authorization state | Delete | Shared report definitions owned by the deleted person are removed; other people's definitions remain |
| Time entries, dates, project/user assignments, historical billable/cost rates, timesheet approvals and locks | Preserve only under the operator's documented time/worker attribution decision | Preserve who performed which hours when and invoice linkage. Stop running timers before closure; closed users cannot start new timers |
| Expenses, invoice/estimate authorship, recorded invoice payments, payout destinations, staff payment events/runs, accounting integration linkage | Preserve reviewed financial relationships and necessary names | Payment destination details, copied names and invoice/payment JSON need record-specific retention review; closure does not cancel or initiate a payment |
| Command receipts, immutable event outbox/activity records, policy publication attribution and other user foreign keys | Enumerate concrete rows; require an actual audit/security retention decision | JSON snapshots may contain copied personal fields. Foreign-key counts are not a semantic scan of free text or proof that all such copies were found |
| Attachments and brand assets | Inventory uploader references; keep business-document ownership and shared file references intact | Inspect expense/invoice/project content, metadata and storage objects. Do not remove a shared object while another retained attachment references it |
| Email queue/log/provider copies, and the notification ledger (`notification_deliveries`) | Cancel queued deliveries addressed/copied to the closed account before removing its directory address; retain log evidence for review. The ledger rows (budget alerts, time reminders) are delivery evidence of the same kind: they keep the recipient address and message text, are surfaced by the inventory as user-linked rows, and nothing re-sends from them once the log row has ended | A multi-recipient queued message may need reissuing without that address. A provider call already in flight cannot be recalled; provider copies, sender snapshots and immutable message contents require review |
| External integrations and exports | No false claim of remote deletion | Operator identifies processors/exports and records actual cleanup or necessary retention evidence |
| Backups and restore | Published operator backup handling remains part of the disclosure | Reapply closure/revocation evidence before restored service accepts traffic; isolated restore testing must never resurrect real credentials |
| Sign in with Apple | Capture each known obligation, then delete local identity and credentials; retain pseudonymous grant and immutable revocation evidence | Verify exact request/origin/subject/grant/generation service evidence for every identity and channel. Missing historical custody remains actionable; see [Apple credential lifecycle](apple-credential-lifecycle.md) |

The review enumerates current direct references to `users` (both restrictive and
nullable foreign keys) and known email/outbox records. New user-linked tables are
therefore surfaced automatically. Operators must additionally inspect unstructured
notes, document contents, imported payloads and external systems. Categories with
actual rows need explicit policy coverage; a generic “legal hold” checkbox does
not silently cover every category.

A closure receipt stores the acting administrator, request, reviewed current
policy, concrete inventory, timestamp and pseudonymous replay protection. The
original request disclosure remains immutable even if a newer policy applies to
the operator's fulfilment decision. Closing access leaves the deletion request
in **Action required** until remaining cleanup and lawful residual retention have
been reviewed. Do not describe this step as “all data deleted.”

Closure is a single guarded database statement with atomic triggers on both
SQLite and D1. It checks request/policy versions, live administrator authority,
owner succession, running timers, the credential snapshot and inventory again at
the write. A failed guard leaves credentials intact and requires a fresh review.
The current owner uses the existing ownership-transfer operation first. The
last-administrator invariant is unchanged.

HMAC replay protection uses a random instance-local secret that stays in the
server database and its protected backups, never in API responses. Retaining the
secret alongside its digests is necessary for checking future assertions. This
control prevents automatic reuse; intentional new account enrollment requires an
operator-reviewed process and must never reactivate the closed internal user ID.

The preview supplies an opaque review token bound to the displayed inventory,
request/policy versions, person version and linked credential directory. The
operator submits that token with the checkbox acknowledgment. Changes after the
preview require another review rather than silently retaining newly added rows.
This count-based inventory does not substitute for inspecting document contents.

## Following a request after sign-in access closes

Request creation or an authenticated repeat returns a separate status capability.
Clients store it securely and send it only in the JSON body of the instance's
request-specific status endpoint; never put it in a URL, logs or analytics. The
server stores only its digest. It grants read access to the request's public
status, original disclosure, actual retained-category review dates, operator
contact and eventual completion confirmation, not workspace access or internal
review notes. Status responses use `Cache-Control: no-store`.

Tracking lasts 90 days from issuance, capped at 30 days after completion. These
are engineering recovery windows, not legal retention periods or deletion
promises. The newest five capabilities per request remain valid; requesting a
replacement does not change the original request or reviewed policy. The server
enforces expiration on every read and clears expired digests during tracking
housekeeping. Requests are body-size limited and the instance permits at most
600 tracking reads per minute. An unavailable or expired capability does **not**
mean erasure completed. Keep the request reference and contact the operator if
tracking expires; only an explicit completion confirmation establishes the
reported outcome.
