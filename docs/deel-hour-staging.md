# Stage approved hours in Deel

Administrators can use **Stage in Deel** beside a Deel-paid person in Payments, or
**Stage hours in Deel** to choose an explicit group. Review the dates, people,
matched Deel contracts, exact seconds, previously staged entries and any conflicts.
The confirmation sends approved hour entries. Deel's contract rate determines the
invoice; local payable amounts and cost rates do not replace that rate.

A successful result means **staged**, not paid. Open the fixed Deel application
link to inspect the invoice and finish payment. This flow does not create a
payment statement, submit an off-cycle amount, or mark a local payment settled.
Existing explicit receipt recording remains separate.

Payments automatically checks the saved Deel timesheet IDs and shows **Paid in
Deel** once Deel reports those hours paid. It shows partial payment when only
some submitted hours are paid, and retains warnings for changed or uncertain
entries. The page checks while open, and the worker also refreshes statuses on
its minute schedule, in bounded batches. The last successful check is shown; unavailable responses
retain the last confirmed status with a warning instead of implying payment.

These checks require `timesheets:read` on the existing Deel token and only make
read requests to Deel. They never submit hours, approve timesheets, or initiate
payment. Provider status describes the submitted hours, while **Recorded
payment** describes the local monetary ledger. No payment amount or date is
invented from a timesheet's status; explicit receipt records stay separate.
Migration `0166_deel_payment_status` adds the durable status cache and polling
leases; it is applied by the normal release migration gate.

The deployment needs `DEEL_TOKEN` and `DEEL_SYNC_START_DATE`. The start date is a
lower bound, and only completed days may be selected (up to 366 days and 100
explicit people per command). Preview refuses more than 1,000 eligible entries;
choose a smaller range. Demo deployments do not enable the flow. The accounting
switch for QuickBooks does not disable Deel hour staging.

The runtime uses the existing per-entry transfer log and intents, together with
the global Deel sync lease. Individual, group and automatic runs share these
records. Before each remote submission, the runtime rechecks the contract and
atomically verifies the current native administrator session, provider choice,
approval and exact reviewed time. Newly added entries require a fresh preview.
No rates, expenses or additional people are silently included.

If a response is lost, check status or retry the same retained command. A transfer
whose provider acceptance is uncertain keeps its intent and is not posted again.
The page explains when reconciliation in Deel is needed, including partially
staged work. Refreshing a preview cannot erase an uncertain transfer.

Normal release migration and readiness gates must complete before activation.
In particular, the existing `0160_managed_deel_connection` migration introduces
shared transfer intents; do not enable a new application version over an older
schema or manually create production tables. No new migration is introduced by
the selected-hour staging feature.

The integration uses Deel's existing `2026-01-01` timesheet contract. The
[create-timesheet reference](https://developer.deel.com/api/stable/endpoints/timesheets/create-timesheet)
requires `timesheets:write`; its `quantity` is work units and `date_submitted`
is the work date. No optional rate preset or auto-approval is supplied.
[Deel's workflow guide](https://developer.deel.com/api/stable/contractors/timesheets)
describes review and inclusion in the invoice cycle for supported time-based contracts.
