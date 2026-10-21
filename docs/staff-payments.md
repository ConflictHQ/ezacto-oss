# Monthly staff payment register

Administrators open **Payments** (`/payments`) from the main navigation or Team. **Reports → Payments report** opens `/payments/report`. It is available on the Worker and container, independently of payment-provider configuration.

## Monthly review

The register lists active people and archived people with records for the selected month. Use **Review payroll costs** to inspect the existing cost report before setting an amount owed. A computed cost is a proposal; an administrator records the agreed obligation, currency, optional due date and note.

- **In progress:** the work month has not ended and there is no completed payment.
- **Pending:** a completed month has an unrecorded or outstanding amount.
- **Partially paid:** recorded payments cover part of the amount owed.
- **Paid:** recorded payments cover the amount owed, or the recorded amount owed is zero.
- **Historically settled:** an administrator confirmed an opening settlement through a completed month; amounts and actual transaction dates are unspecified.
- **Overdue:** a completed, unsettled period has an explicit due date before the report date. No payment terms are inferred from the month alone.

Amounts remain separate by currency. Unspecified obligations and historical settlement amounts are excluded from monetary totals and explicitly counted. Destination readiness is checked separately for Wise and Deel. A ready destination means an attached account for that provider has been verified; it does not prove a transfer was sent or received.

## Provider settings

Expand **Payment provider settings** to choose an organization default: **Wise** or **Deel**. Wise is the initial default. Select a person to choose their **Preferred payment provider**: Wise, Deel, or **Use organization default**. Changing the organization default affects only people who inherit it. These preferences apply across months.

The preferred provider preselects the source when recording a payment. Each receipt keeps the provider actually used. One person can receive partial payments through both providers in the same month; balances remain per person, month and currency. Changing preferences never rewrites prior receipts.

Setting changes require an administrator session and a reason. They have immutable history, actor, timestamp, request ID, idempotency and version checks. **Provider settings history** shows changes across all dates. Monthly exports include current preferences and both providers’ readiness; audit exports include all provider-setting changes alongside the selected month's payment events.

The existing optional Deel adapter remains available for people/contract matching, timesheet submission and transfer-log deduplication. See [`packages/integrations`](../packages/integrations/README.md). Selecting Deel here does not configure credentials or confirm a payout. Once an organization sets `DEEL_TOKEN` and `DEEL_SYNC_START_DATE` (see [Integrations](integrations.md)), the daily sync submits one Deel timesheet per person-day of approved time for people whose provider is Deel, never twice for the same entry; an entry edited after it was sent is reported, not resent.

## Sorting tables

Click a column heading to sort ascending; click it again to sort descending. The monthly register, payment history and provider settings history each retain their own selection when refreshed or filtered. Sorting leaves open payment forms intact. Comments, notes and reasons are not sortable.

Dates sort chronologically, numbers numerically, and text naturally (including identifiers). Money sorts by currency and then the exact amount; unspecified values remain last in either direction. Arrow indicators and accessible header state identify the current ordering. CSV exports continue to include the complete selected month in their standard order.

## Recording confirmed payments

After confirming a payment in Wise or Deel, select the person and **Record confirmed payment**, choose the provider actually used, enter its actual date and transfer reference, and save. Partial payments are supported. This action records a confirmed payment; it does not initiate a transfer. The existing `payout_transfers` store and Wise webhook log remain provider evidence, and are not automatically interpreted as a recipient receiving money by this register.

For a mistaken payment record, **Void an incorrect payment record**, give a reason, then record the correct receipt. A void corrects this register; it does not reverse money at either provider. The original entry and correction remain in history.

## Opening history, including earlier Deel payments

Choose a completed month, expand **Record historical settlement through this month**, select the people whose earlier periods are confirmed settled, and enter the source and explanation. Choose a different cutoff for anyone with an unpaid exception. Each selected person's record is version checked and saved individually; if a batch stops, the screen reports how many saved and reloads before continuing.

An opening settlement covers earlier months without fabricating transaction amounts or payment dates. Explicit obligations and payments in an earlier month retain their balances. **Reopen historical settlement** overrides a cutoff for an individual month.

Exact historical transactions require evidence from the previous provider, such as a Deel export. To enter those receipts, reopen the applicable month's historical settlement, set the documented amount owed, and record each receipt with its actual provider (**Deel** or **Wise**), or **Other historical payment**, its original reference/date and source in the note. Existing historical entries remain unchanged. No historical receipts are fetched automatically.

## Reports and audit

**Export monthly report** exports the full selected month, including status, due date, currency, recorded amount, payments, balance, historical cutoff, Wise readiness and report date. **Export audit log** includes every monthly action and applicable opening cutoff, actor, timestamp, request ID, command ID, source, reference, note and void target. Display filters do not narrow these month-wide exports.

Each command is an immutable event. Repeating an identical command ID is idempotent; changing its payload is refused. Concurrent writes use an atomic per-person/month version check in SQLite and D1. Payments cannot exceed the balance, and a currency cannot change while recorded payments remain. Correction events replace deletion.

All register API routes require an administrator session; API tokens and other roles are refused, matching the payroll cost report's confidentiality boundary. API server failures follow the existing Worker log and Sentry request-ID reporting path when Sentry is configured.

## Payment runs and the Payments page

**Payments** (`/payments`) combines the existing obligation ledger with Wise payment runs. Administrators select people and amounts from the chosen work month, then **Review selected payments**. Partial payments are allowed up to the unreserved balance. Only people whose preferred provider is Wise and who have a verified Wise destination can be selected; existing manual Wise/Deel receipts remain available in the ledger.

Review shows the work period, Wise's recipient name and resolved destination, recipient amount, estimated fee, estimated source cost, estimated arrival, and an editable maximum source cost per payment. Funding uses the organization's Wise balance in the selected source currency. **Send** or **Schedule** on this separate confirmation screen authorizes the payments. Viewing a quote alone never authorizes a transfer. Reviews expire after 30 minutes. The schedule is saved as a UTC instant alongside the browser's IANA timezone; the screen labels its local timezone. The scheduled instant is the start of processing, not a guaranteed arrival time.

Approval atomically reserves each recipient amount against its person/month obligation. A competing run, manual payment, currency change, or reduction in the amount owed cannot consume those reservations. If any selected balance or destination changed, the entire approval rolls back. A run may contain up to 100 payments. Source costs and fees are additional company expenses and do not reduce the agreed recipient amount.

The Worker checks due payments every minute; the container processes them on its existing scheduler tick. Each tick advances up to ten due payments, at most three durable stages apiece. Runs are processed individually through Wise's quote, transfer and balance-funding APIs. This implementation does not use Wise batch groups; scheduling and the common run history belong to ezacto. Individual outcomes are retained when part of a run succeeds.

Execution refreshes the quote, checks the source profile, recipient and approved cost ceiling, and pauses a payment that no longer matches. It saves the execution quote and stable transaction UUID before creating a transfer. Retries of an uncertain creation reuse the same payload and UUID. Funding is marked before the request: a lost response causes status reconciliation, never an automatic second funding attempt. Authentication, insufficient funds and other unresolved funding failures retain their reservations and direct the operator to the existing transfer in Wise. HTTP 429 delays subsequent attempts using Retry-After and bounded backoff. Creation recovery is bounded; **Check status** can request another reconciliation with the original transaction identity.

**Cancel unsent payments** releases only items that have never entered transfer creation. Payments already creating, funding or processing must be reconciled/cancelled at Wise. Changing a destination does not redirect an approved payment. The original destination remains in the run's review and audit history.

Wise's `outgoing_payment_sent` status records a payment in the immutable register exactly once and releases its reservation. This means Wise confirmed dispatch; it is not an assertion of final bank receipt. Where a verified webhook supplies the event time, its UTC date is used; otherwise the observed confirmation date is recorded and identified in the note. Confirmed refunds append a void event and restore the outstanding balance. Paid transfers are polled for 90 days; later verified webhook deliveries can request reconciliation too. Operators cannot manually void these provider-created receipts. The original receipt and any refund remain visible in the ledger audit.

Run approvals, cancellation requests, reconciliation requests and processing transitions have a durable audit in `payment_run_audit`. No test or migration initiates a transfer. API funding availability depends on the Wise account and currency route; a route must offer balance funding before it can be reviewed.

## Payments report

**Reports → Payments report**, or `/payments/report`, shows up to twelve work months. It includes balances by person/month, individual transfer progress, and recorded receipts with actual provider/reference and payment or confirmation date. Filter by person, currency and status; **Export filtered CSV** exports those same filtered rows. Amounts owed, paid, reserved, and available to pay are summed separately by currency. Unspecified historical amounts are counted but excluded from monetary totals. Transfer costs are labelled as review estimates or execution quotes, not bank-statement expenses.

The report describes the current ledger for the selected work months, not a historical “as of” snapshot. Its receipt section includes manual payments from Wise, Deel and historical providers as well as new automatic Wise payments, excluding voided receipts.

## Work months and actuals review

The work month is the period the earnings belong to. August work paid in
September stays in the August ledger; its receipt separately records the real
September payment date. Payments and the payment report default to the previous
completed month. September earnings can be confirmed from October 1 in the
organization's timezone. Manual entries remain available for reasoned overrides.

In **Payments → Review actuals**, load the selected work month and choose a
contractor. The review uses the contractor report's captured rounded seconds and
captured cost rates, priced per entry with the same rounding. It includes tracked
time regardless of timesheet approval. Select projects or change included hours
on individual entries. Missing selected rates must be resolved before confirmation.

**Confirm earnings** saves an immutable snapshot and sets the month's total owed;
it never adds the total twice and never transfers money. Revisions show the
existing balance and cannot reduce earnings below paid or reserved funds. Changed
source entries or concurrent ledger edits require a fresh review. Excluded hours
are not added to the balance; return to the review to include them later. To make
a partial payment against the whole month's earnings, confirm all hours and
change the payment amount at the separate **Pay now → review → send/schedule** step.

Historical settlements block actuals imports until explicitly reopened. Contractor
invoices and advance credits are separate follow-up capabilities; importing actuals
does not generate invoices or record deposits.

### Correcting a work-month allocation

A completed register can be reassigned to an empty work month through a targeted
operator insert into `staff_payment_period_moves`. This is an operational data
correction, never deployment seed data. Verify the person, source and destination,
latest source version, receipts and all payment-run states before writing. The
insert must specify its actor, request ID, timestamp and reason. The database
rejects a changed source, an occupied destination or active payment runs.

Original event rows and receipt dates remain immutable. The effective ledger
projects those entries into the corrected period and leaves correction notes in
the original period; payment-run items and audit history record the new work month.
Future refunds reconcile against that corrected month. After the correction,
verify balances, receipt reference and date, run history, and both monthly reports.
Historical settlement entries should be recorded separately after those checks.

### Historical amounts from contractor costs

A settled month without an exact ledger amount displays the selected work month's
current contractor cost, using the same captured rounded seconds, captured cost
rates, and per-entry rounding as the contractor cost report. The API identifies
this amount with `amount_basis: contractor_cost`; exact ledger amounts use
`amount_basis: ledger` and always take precedence. Missing rates, absent entries,
and non-contractors remain unspecified. This is a live report valuation, not a
frozen historical receipt: editing the source time entries changes the displayed
cost. The settlement cutoff and original audit records remain unchanged.

Balances, the payments report, and CSV label the amount basis. Historical costs
have a separate total from recorded payments; they do not create payable balances,
receipts, dates, or transfers. Reopening a month removes this fallback so its exact
earnings can be reviewed normally. This reporting change requires no data repair or
schema migration.

### Hide empty people

Payments and the payments report default to people with hours or payment activity
in the selected work month. Enable **Show people with no hours or payments** to
include everyone. Nonzero captured hours remain visible even without rates or
confirmed earnings; amounts, reservations and payment history also keep a person
visible. A blanket historical settlement by itself does not count as activity.
Monthly and filtered report exports follow this checkbox; the full audit export
keeps all records. The filter changes visibility only, not ledger records.

## Payment allocations

An allocation links part of one payment to the earnings it pays. It is an
additive layer: monthly totals, payments and payment runs are unchanged, and
existing monthly payments stay unallocated until an administrator allocates them
explicitly. Hour splits are never inferred.

- **Payment**: a recorded payment, or a payment run item (reserved while
  scheduled or processing, applied once paid).
- **Target**: the whole work month (amount only, the reconciliation path for
  existing payments), a project, or one reviewed time entry with optional hours.
  Hours are valued at the rate captured in the confirmed actuals review; the
  allocation taking the last hours takes the remaining cents. An explicit amount
  needs the reason every allocation carries.
- **Invariants** (database triggers, identical on SQLite and D1): same person,
  month and currency as the payment; never more than the payment, the month's
  earnings, the project's or the entry's reviewed earnings or hours.
- **History**: rows are append-only. A reversal (with a reason), a void of the
  payment, or a failed or cancelled run item releases the allocation; nothing is
  deleted. Allocations snapshot the review, and the report flags entries whose
  source time no longer matches (`source_changed`) or that are over-allocated
  after a later review, for explicit reversal and re-allocation. On the
  Allocations tab a flagged entry offers "Review change": reviewed against
  current hours and rate, then one action that reverses the entry's
  allocations, confirms the person's earnings again from the current hours
  (selection never rises above what was reviewed) and allocates again. Each step
  carries an identifier derived from one adjustment identifier, so a retry
  after a failed step repeats nothing.
- **API**: `GET /api/v1/staff-payments/allocations?month=` reconciles earned,
  paid, reserved and remaining by person, project and entry, and lists
  unallocated payments; `POST .../allocations/preview`, `POST .../allocations`
  and `POST .../allocations/reversals` (administrator sessions only).
- **Screen**: the Allocations tab on Payments loads the report for the work
  month. Choosing a payment, target and hours or amount and selecting **Review
  allocation** calls the preview endpoint and shows the selected hours, captured
  rate, amount, what is already allocated and what remains on the payment and
  the earnings. **Confirm allocation** appears only for the reviewed command and
  sends that same command; changing any input withdraws the review.
  **Reconcile to month** on an unallocated payment prefills a whole-month,
  amount-only allocation of its unallocated cents, which is the explicit path
  for existing monthly payments. Neither step moves money.
- **Payments report** (`/payments/report`) and **Export filtered CSV** include
  earned, allocated paid, allocated reserved and remaining amounts for each
  reviewed project and time entry. They use the same person, currency, status
  and work-month filters as balances. Source-change and over-allocation flags
  travel with entry rows. Project totals include entry allocations; the two
  levels must not be added together. Monthly payments remain unassigned until
  explicitly reconciled, and project payments are never inferred onto entries.
  CSV allocation rows identify their level, person/project/entry IDs and
  selected/remaining seconds; all money columns are integer cents.
- A work-month correction is refused while allocations are live; reverse them
  first.

People see only their own figures, read-only, at `/my-payments` (`GET /api/v1/me/payments`) when the `own_money` setting is on; see [`contractor-payments.md`](contractor-payments.md). These administrator routes are unchanged.
