# Harvest invoice read compatibility

The optional `/harvest/v2/invoices` and `/harvest/v2/invoices/:id` routes use the
same native invoice store and `invoices:read` profile/token ceiling. Operator
`INVOICES_ENABLED=false` also refuses the shim paths. They perform no mutations.

Lists use Harvest offset pagination (default 100, maximum 2000) and issue-date
order, newest first, with deterministic ID ties. Accepted filters are `client_id`,
`project_id`, `state`, `updated_since`, `from`, `to`, `page`, and `per_page`.
Project matching includes invoice header projects and line-item projects.
Counts, headers, lines and project references are read in one D1 batch or one
SQLite transaction. Native cursor pagination is unchanged.

The serializer maps native integer cents and percentage units into decimal
Harvest amounts, preserves invoice-item category names and case, and uses the
six documented payment-term spellings. The reference is the
[Harvest invoice API](https://help.getharvest.com/api-v2/invoices-api/invoices/invoices/).
Only known native card/PayPal checkout options are represented; other payment
rails are not advertised as ACH without proof of equivalence. Recorded golden
inputs use synthetic native gateway values to exercise the corresponding
card/PayPal representation; live reads use current native configuration and do
not restore old source payment links.

Explicit limitations:

- Public invoice-link secrets (`client_key`/`reference_token`) are omitted.
- An unresolved native creator stays null. The serializer does not restore a
  person's source identity from migration metadata to match an old response.
- Twenty represented, anonymized invoice objects extend the golden corpus.
  The source snapshot's 143 unresolved/deleted-creator invoices are not claimed
  byte-equivalent. The complete matrix is in the
  [corpus provenance](evidence/16-harvest-corpus-provenance.json).
- Invoice writes and the shim-only locked-expense update behavior remain
  outside this read slice.

Verification includes scoped/profile-denied requests, module disablement,
filters/paging and monetary/reference rendering on real SQLite and D1 stores.
The container proof creates a blank invoice, adds a line through native session
HTTP routes, then reads it through a separate read-only Harvest bearer token:
2.5 × 12.34 gives 30.85, with no public-link secret in the response.
