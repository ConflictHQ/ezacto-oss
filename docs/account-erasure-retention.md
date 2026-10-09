# Operator account erasure and retention policy

Each self-hosted instance's operator is responsible for its processing of workspace
records and for assessing applicable laws. The mobile app connects to that
operator's server. A checkbox is a record of the operator's assessment, not a
certification, user consent, waiver of rights, or permission to keep all records.

## Configure the policy

An active administrator signs into the web app, then opens **Settings → Company
→ Erasure and retention** (`#erasure`). Review and publish:

1. Applicable frameworks: GDPR, all 50 US states and the District of Columbia,
   applicable US/Florida recordkeeping duties, and other laws or jurisdictions.
   Search the state list to find a law; filtering does not clear selections.
   The [dated state reference](us-state-privacy-reference.md) distinguishes
   current laws, enacted future laws, sector-specific examples and entries
   requiring an operator assessment. No framework is
   selected automatically. An empty selection does not establish an exemption.
2. Categories that actually require retention: time and worker attribution;
   invoices, expenses and payments; audit and security; specific legal holds.
   Each checked category requires its **actual purpose and basis**, a **retention
   period and starting event or release condition**, and a **review interval**.
   The interval is a follow-up target, not an automatic deletion job. An unchecked
   category does not delete data.
3. An operator contact email and initial response target. The target does not
   extend legal deadlines. Assess the applicable request, acknowledgement,
   extension, appeal and completion requirements independently.
4. A user disclosure explaining what the operator will erase, any identified
   records retained, why and for how long, request handling and contact/appeal
   routes where applicable. Describe the real process; do not promise immediate
   or automatic erasure that your deployment does not perform.
5. Actual backup expiry, access restrictions, deletion and restore handling.
   External mail, accounting systems, object storage, exports and backup copies
   require their own assessment and action. Reapply completed closures before
   restored data is made available. See [RESTORE.md](../RESTORE.md) and
   [security.md](security.md); do not assume a universal backup expiry.
6. A fresh acknowledgement that the operator reviewed applicability, necessity,
   periods and disclosures. Publication is refused without it.

Two administrators cannot silently overwrite each other's version. A stale save
returns a conflict; preserve your draft, reload the policy, and reconcile changes.
Previous policy versions remain available in `account_retention_policies` for
explaining prior disclosures. Avoid putting unnecessary personal data in policy
text. Limit access to the database and include this policy history in your own
retention review.

## What this setting does

Publication stores a validated, versioned policy on the server and makes it
available to authenticated staff and the mobile client's read scope. It does
**not** fulfil an account-deletion request, schedule erasure, revoke credentials,
notify recipients, remove attachments, or clean external services and backups.
The account closure fulfilment work is tracked separately in issue #967. Existing
account archival is not proof of completed erasure. Never tell a requester their
account has been deleted based only on publishing this policy or recording a
request.

When retaining identified time records is necessary and justified, preserve who
performed which hours, the dates, and links to invoices and payments. Minimize
unrelated profile information and restrict retained records to the permitted
purpose. A generic accounting or legal-hold checkbox is not a justification for
indefinite retention of all personal information.

## API and deployment

Both Worker/D1 and container/SQLite runtimes compose the same policy service.
Migration `0101_account_retention_policy` adds versioned storage; existing
instances start with **no published policy**, with no inferred retention choice.

- `GET /api/v1/profile/retention-policy`: staff session or API token with
  `time_entries:read`; `data: null` means unpublished. Returns policy, version and
  publication time, with `Cache-Control: no-store`.
- `POST /api/v1/admin/retention-policy`: active administrator session, normal
  same-origin protections. Body: `expected_version` (0 for first publication)
  and `policy`. The generated OpenAPI/client defines all fields and limits.
  Server supplies publisher and timestamp; the database checks authority and
  version in the same insert. A stale version returns 409; malformed policy 422.
- The shared public demo refuses policy publication.

## Deletion requests and operator queue

Both runtimes store requests in `account_deletion_requests` independently of email.
In **Settings → Company → Erasure and retention**, administrators can inspect the
queue, read the captured disclosure, record progress and any required user action,
and retry unavailable or failed administrator notification. These actions do not
close access or erase personal information. Completion is not a dropdown choice;
actual fulfilment remains a separate operation tracked by #972.

- `POST /api/v1/profile/deletion-request` accepts optional
  `expected_policy_version` (the reviewed version, or `null` when unpublished).
  A version changed before the write returns 409. Retrying an existing request
  returns its original snapshot; submitting again cannot replace its terms.
- Older clients can submit an empty JSON object or no body. The server captures
  the policy but sets `policy_reviewed: false`. This is not consent or evidence
  that the client displayed the policy. New clients should always submit the
  reviewed version. An unpublished policy does not block a request or limit user rights.
- `GET /api/v1/profile/deletion-request` returns the authenticated user's request,
  or `data: null`. Read/write scopes are `time_entries:read`/`time_entries:write`.
  There is no route for a requester to look up somebody else's request by ID.
- Administrator session routes: `GET /api/v1/admin/deletion-requests` (50 rows,
  follow `links.next`), `GET`/`PATCH /api/v1/admin/deletion-requests/:id`, and
  `POST /api/v1/admin/deletion-requests/:id/notification` to retry notification.
  Updates require `expected_version`, a progress status, user-visible `message`,
  and nullable `expected_completion_at`. Database authority/version checks and
  normal same-origin protection apply. An action-required status needs a message.
- States: `pending`, `in_progress`, `action_required`, `completed`. The first
  three describe handling only. Completion requires a separate fulfilment path
  with an actual timestamp and confirmation; this queue cannot assert it.
- `response_target_at` comes from the immutable policy's initial-response target.
  It is **not** a completion deadline. An operator may separately communicate
  `expected_completion_at`; neither setting changes applicable legal deadlines.
- `notification` records pending/sending/queued/failed/unavailable. Queued is not
  delivered. `notification_delivery_id` links to the existing email log; later
  failed/bounced/complained deliveries show failed. Failed/bounced messages can
  be retried after fixing delivery. Complaints remain subject to suppression.
  A claim prevents concurrent attempts; an interrupted sending attempt may be
  retried after 15 minutes. A crash between enqueue and recording its outcome
  can produce a duplicate notice on retry; it cannot duplicate the request.
- Migration `0102_account_deletion_requests` imports earlier activity-only asks
  using their first request time and no invented historical policy. Their email
  outcome is unknown (`unavailable`); an administrator can retry it.

Request records store an existing user ID, not copied names or contact addresses.
Names and primary addresses used for mail are read from the existing directory.
Request snapshots/progress history document how a right was handled; restrict
access to the requester and active administrators, and keep messages free of
unnecessary personal details. Email logs/queues contain recipients and must be
included in the operator's own retention assessment. There is no built-in expiry
for request history or mail logs: document the actual evidence-retention period
and starting event under your audit/security category, review it when closure is
completed, and remove records when that purpose ends. Do not promise automatic
expiry from a review interval. Retention-review automation is tracked by #973.

## Legal references and applicability

References reviewed 2026-10-09. These are configuration guidance, not a legal
opinion about a particular operator. Assess territorial scope, entity thresholds,
record context, exemptions and current amendments for your deployment.

| Framework | What to assess | Official reference |
| --- | --- | --- |
| EU/EEA GDPR | Articles 3 (scope), 5 (minimization/storage limitation), 12 (request handling), 17 (erasure and specific exceptions), 19 (recipient notification where required). Article 17(3)(b) concerns Union/Member State law; US/Florida law alone does not establish it. Article 17(3)(e) concerns necessary legal claims. | [GDPR text](https://eur-lex.europa.eu/eli/reg/2016/679/oj) |
| California CCPA, amended by CPRA | Covered-business criteria, deletion rights/exceptions, required notices and limits on retention. Employment data is not generally excluded. A user cannot waive statutory rights by accepting a disclaimer. | [California Attorney General](https://oag.ca.gov/privacy/ccpa) |
| Texas TDPSA | Chapter 541: consumer definition excludes employment/commercial contexts; scope and exemptions still need assessment. Sections 541.051–.053 address rights and requests; .201–.202 describe exceptions; .204 limits exempt processing by necessity, proportionality and purpose. | [Texas statute](https://tcss.legis.texas.gov/resources/BC/htm/BC.541.htm) |
| Colorado CPA | Coverage thresholds and general consumer definition, which excludes employment and commercial contexts. Assess other applicable obligations separately; exclusion from this definition does not mean all employee information is unprotected. | [Colorado Attorney General](https://coag.gov/resources/colorado-privacy-act/) |
| Applicable US/Florida duties | Identify the specific tax, accounting, employment or other obligation and its record scope, period and starting event. Florida incorporation or an EU trader listing does not establish privacy-law compliance or erase other jurisdictions' requirements. | [Florida statutes](https://www.leg.state.fl.us/statutes/), [IRS recordkeeping](https://www.irs.gov/businesses/small-businesses-self-employed/recordkeeping) |
| Other applicable laws | Other states and countries have distinct scope, rights and retention rules. Use the other-laws option and describe the actual jurisdiction and basis; the framework list is not exhaustive. | [NCSL privacy guide](https://www.ncsl.org/in-dc/task-forces/task-force-on-artificial-intelligence-cybersecurity-and-privacy/legislator-privacy-guide-and-glossary-of-privacy-terms) |

State laws provide overlapping consumer rights but are not interchangeable with
GDPR. Colorado and Texas's employment-context exclusions are particularly
relevant to timesheets; California and GDPR require their own analysis.
