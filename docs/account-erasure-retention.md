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
