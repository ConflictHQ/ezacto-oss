# QuickBooks reconciliation boundary — 2026-10-23

Issue #1013 is a scoping and acceptance request, not permission for universal
bidirectional accounting writes. This audit supersedes its 2026-10-19 tracker
comment. The working baseline is `944d848e`; the original reconciliation report
shipped in #1042, and payment recovery/divergence work shipped in #1098
(`1c514417`). The safety corrections described below extend that existing work.

## Implemented boundary

| Subject | Current behavior and source of truth |
| --- | --- |
| Invoice facts | eZacto owns its invoice number, total and currency. The outbound mirror creates or adopts an agreeing QuickBooks document; disagreements are reported, not overwritten. |
| Tax and accounts | Totals must agree to the cent. Tax components, chart of accounts and account mapping are not synchronized independently. |
| External receipts | Payments received in QuickBooks can become receipts against mirrored invoices. Each linked invoice share is handled separately; partial payments remain partial. Amounts exceeding the remaining balance are skipped for review. |
| Dates and currency | Inbound payments retain the provider transaction date. Reconciliation compares stated currencies and totals; it does not perform foreign-exchange conversion or reinterpret amounts. |
| Replay | Webhooks and CDC share delivery claims and provider payment references. A payment already received or mirrored from an `ez-` receipt is not recorded twice. |
| Reversals and edits | Payment void/delete facts are flagged for review without deleting a receipt or changing either ledger. Arbitrary edits are compared, not automatically resolved. |
| Expenses | No independent QuickBooks expense flow exists. Billable pass-through expenses may already be represented by invoice totals; that does not establish expense ownership or an expense-sync direction. |
| Access and custody | Existing OAuth custody and accounting scope are reused. Reconciliation is visible to administrators/accounting through the API and in administrator Accounting settings. Disconnect removes the active connection; history remains. No payment-processing scope is requested. |

The implementation lives in `packages/integrations/src/quickbooks/`,
`packages/db/src/quickbooks.ts`, `packages/db/src/quickbooks-source.ts`, and
`packages/api/src/quickbooks.ts`. Migration `0133_quickbooks_recovery` already
provides CDC cursors and payment-divergence records. The Worker hourly cron
already calls catch-up; the container has no automatic catch-up scheduler.

## Recovery safety

Catch-up starts from a stored company cursor with a five-minute overlap. Its
first run establishes a cursor without importing older history. A failed window
retains the cursor; already recorded shares can be replayed without duplicating
money. Gaps approaching the provider's 30-day horizon require reconciliation.

Intuit documents a 1,000-object CDC ceiling and returns deleted objects after
active objects. A full response therefore cannot establish complete coverage by
its newest timestamp. The safety correction refuses to apply or advance past
such a response and records `full_reconcile_needed`, rather than inventing a
continuation cursor. See [Intuit's CDC guide](https://medium.com/intuitdev/building-smarter-with-intuit-stay-in-sync-with-cdc-171f8094dd37).

A 429 stores a private `retry_not_before` value (migration
`0154_quickbooks_retry`) while preserving the CDC cursor. Background catch-up
uses a valid delta-seconds/HTTP-date `Retry-After`, otherwise 60 seconds, and
returns without sleeping. A later run, including after process restart, waits
until that time before provider I/O. A concurrent shorter delay cannot erase a
longer one. This is catch-up scheduling, not a new retry policy for interactive
mirror/report requests. See [Intuit's throttling policy](https://static.developer.intuit.com/output_html/qbo/docs/learn/limits-and-throttles.html).

## Remaining acceptance and scope

The fixtures are invented data following documented shapes, not recordings from
an owned live company. Local SQLite/D1 checks prove recovery storage, replay,
partial-payment handling, divergence reporting and read-only comparison; they do
not prove Intuit sandbox delivery or production compatibility.

At the audited baseline, one concrete provider-compatibility gap remains: the
webhook parser accepts the legacy `eventNotifications` object and rejects CloudEvents arrays.
Intuit's [mandatory format migration announcement](https://medium.com/intuitdev/upcoming-change-to-webhooks-payload-structure-2a87dab642d0)
states an extended deadline of July 31, 2026. Supporting signed CloudEvents is a
separate buildable slice; deployment registration and an owned-company round trip
must then verify the active format. Existing HMAC verification, company routing
and replay guards must remain in force.

Before claiming full #1013 acceptance:

- Verify the owned sandbox round trip for an agreeing invoice, an externally
  received partial payment, replay/missed delivery, and void/delete payloads.
  Record sanitized evidence without credentials or customer data.
- Decide whether any independent expense flow is wanted, its direction and
  ownership per field, including tax, currency, dates, accounts and reversals.
  Until then, no expense-sync implementation or additional scope is implied.
- Confirm the documented invoice/receipt ownership boundary. Differences remain
  operator decisions; no automatic conflict resolution, payment movement or
  new accounting write follows from this audit.

The read-only report portion and implemented payment-recovery paths have local
coverage; the unresolved provider evidence and policy decisions keep the
parent issue open. Hosted entitlement remains ezacto-hosted#234.
