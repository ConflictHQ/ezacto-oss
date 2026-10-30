# Contractor payment summary and upcoming payments

Issue 100. The own-subject view of the monthly staff payment register
([`staff-payments.md`](staff-payments.md)): what a person is owed, what has been
paid to them, and what is scheduled. It is read-only and shows a person only
their own figures.

## Decisions this follows

The owner decision of 2026-10-19 on issue 100:

1. The page is for anyone flagged `is_contractor` **or** holding a recorded
   obligation.
2. An amount owed appears only after an administrator has recorded the
   obligation for that month. Before then the person sees hours and "pending
   review".
3. Upcoming detail is limited to amount, currency, date and status.
4. The surface is gated by the existing `own_money` module setting (default off).

Anything not stated there is the narrowest reading, and is marked below as an
assumption.

## Who sees it

All three must hold, checked in this order so that a refusal never says more
than the one before it:

| Check | Refusal |
| --- | --- |
| The caller is a signed-in user session. | `403 session_required` for API tokens (assumption: see below); 401 when unauthenticated. |
| `own_money` is on for the instance. | `403 own_money_disabled` |
| The caller is flagged `is_contractor`, or has at least one recorded obligation (an `amount` event in the register, in any month). | `403 not_a_payee` |

Profile is irrelevant: a member, project manager, accounting user, executive
manager or administrator who meets the rules sees their own summary, and nothing
about the profile widens it. An administrator who is not a payee gets
`not_a_payee` here and uses the administrator Payments page instead.

`own_money` is the same switch that governs a person's own billable rate and
take-home (issues 520 and 535). It is read once per request and stamped on the
principal, as for those fields. An instance that upgrades into this feature
discloses nothing until an administrator turns the setting on.

## Isolation

The subject is never an input. The route takes no person, user id or customer
identifier; the store is called with the authenticated principal's user id and
nothing else. A `user_id`, `userId` or similar query parameter is ignored, not
honoured. There is no path parameter to tamper with. The administrator routes
(`/api/v1/staff-payments*`) are unchanged and still refuse everyone but an
administrator session.

## API

`GET /api/v1/me/payments?month=YYYY-MM` (default: the previous completed work
month, as for the administrator register). Always `Cache-Control: no-store`.
Session only: the operation is declared `sessionOnly` in the contract.

Assumption: API tokens are refused. A token scope for own payments would be a
new permission surface that the owner decision does not ask for. A token holder
gets `session_required`. A scope can be added later without changing the shape.

### Fields shown

```
data: {
  month:          "2026-09"            work month
  hours_seconds:  number               own tracked, rounded seconds in that month
  status:         pending_review | in_progress | pending | partial | paid | settled
  owed:           { amount_cents, currency } | null
  paid_cents:     number               recorded, unvoided payments for the month
  balance_cents:  number | null        owed minus paid; null while owed is null
  payments:       [{ amount_cents, currency, paid_on }]   unvoided receipts in the month
  upcoming:       [{ amount_cents, currency, scheduled_on, status }]  across all months
}
```

* `status`: `pending_review` when no obligation is recorded for the month and no
  historical settlement covers it. Otherwise the ledger status, with the same
  meaning as in the administrator register (`in_progress`, `pending`, `partial`,
  `paid`, `settled`). The administrator "overdue" flag and due date are not
  shown: they are an administrator's collection signal, not a figure the person
  asked for.
* `owed` is `null` unless an administrator recorded the amount. A computed
  payroll cost, a contractor-cost valuation of a historical settlement, or a
  proposal from the actuals review that was not confirmed is never shown as owed.
* `upcoming` lists the person's approved payment-run items that have not reached
  a terminal state, soonest first. `scheduled_on` is the calendar date of the
  scheduled instant in the timezone the run was scheduled in. `status` is
  `scheduled` (queued, not yet started) or `processing` (anything the provider
  has begun, or that an operator is reconciling). Failure, attention and retry
  detail is deliberately flattened to `processing`.

### Fields never shown

* Any other person: name, id, hours, amounts, receipts, preferences.
* Client or customer data: rates, commercial terms, invoices, project names.
* Billing rate, cost rate and source cost; Wise fees, quotes, estimated cost or
  arrival; transfer ids and provider references.
* Recipient account, destination, bank or Wise/Deel readiness detail.
* Provider choice (Wise or Deel), receipt references and notes, the administrator
  who recorded anything, request ids, version numbers, due dates, reservations.
* Payment-run names and the work month of an upcoming item.
* Failure text of a payment.

The serializer builds each object from an explicit list of fields; it does not
spread a ledger row, so a field added to the ledger later does not leak.

## Display rules

* **Unconfirmed month.** Hours and "pending review". No owed, paid or balance.
  The page says the amount appears after an administrator records it.
* **Historical settlement.** `settled` with `owed` null: shown as "Settled
  (historical)" with no figure, because the register records neither an amount
  nor a date for it.
* **Voided receipt.** A void removes the receipt from `payments` and from
  `paid_cents`, and restores the balance, exactly as the ledger does. The void
  itself is not shown.
* **Refund.** A confirmed refund appends a void event in the ledger, so it reads
  as a voided receipt. The person sees the payment disappear and the balance
  return.
* **Multi-currency.** Each figure carries its own currency and nothing is summed
  across currencies. An obligation has one currency per month; `upcoming` may
  mix currencies and is displayed one row per payment.
* **Months.** The page shows one work month at a time with a month picker.
  `upcoming` is not filtered by the month because it is about what is next.

## The page

`/my-payments`, "My payments", inside the application shell. It loads
`GET /api/v1/me/payments` for the chosen month and renders the summary, the
receipts and the upcoming table. States: loading; `own_money_disabled` ("Your
organization has not enabled this view"); `not_a_payee` ("No payments are
recorded for you"); error with retry. It shows no administrator navigation of its
own, and its data is cleared from the page on sign-out. The page is rendered
inside the shell, so it falls under the existing `shell-*` brand-surface rows.

## Denial matrix

Every row maps to a passing test. `API` is `packages/api/test/my-payments.test.ts`; `DB` is `packages/db/test/my-payments.test.ts` (its two
cases, container SQLite and Worker D1, run the same scenario).

| Caller | `own_money` | Result | Test |
| --- | --- | --- | --- |
| Unauthenticated | any | 401 | API: `refuses an unauthenticated caller with 401 and never reads the store` |
| Contractor, session | on | 200, own figures only | API: `serves every profile its own figures and asks the store only about the caller`; DB: `reconciles to the ledger and never discloses another person` (flagged contractor, other person's figures absent) |
| Contractor, session | off | 403 `own_money_disabled` | API: `is off until own_money is on, before it reveals whether the caller is a payee`; `follows the own_money setting live` (off, on, off again through the real authentication layer) |
| Member holding an obligation, session | on | 200, own figures only | API: `serves every profile ...`; DB: `reconciles to the ledger ...` (unflagged holder of an obligation is a payee) |
| Member, not a payee | on | 403 `not_a_payee` | API: `refuses a caller who is not a payee`; DB: `reconciles to the ledger ...` (no obligation, unknown user: null) |
| Project manager, accounting, executive manager, administrator who is a payee | on | 200, own figures only | API: `serves every profile ...` |
| Same four profiles, not payees | on | 403 `not_a_payee` | API: `refuses a caller who is not a payee` (loops all five profiles) |
| Any API token | any | 403 `session_required` | API: `refuses API tokens, even for a payee with own_money on` |
| Any caller passing another person's id | on | 200 with the caller's own figures; the id is ignored | API: `ignores any attempt to name another person` (query parameters ignored; person-in-path is 404) |
| Anyone but an administrator session on `/api/v1/staff-payments*` | any | 403, unchanged | API: `leaves the administrator register closed to everyone but an administrator session` |

## Data

No migration. The summary is a read model over `staff_payment_effective_events`
(the same view the administrator register reads, so period moves and voids
apply identically), `time_entries`, `users.is_contractor`, and
`payment_run_items` joined to `payment_runs`. No table is added, so the account
closure inventory is unchanged. The numbers are computed by the same
`summarizeStaffPayments` function as the register, and tests reconcile the two
for the same person and month.

## Out of scope

Contractor invoices, advances and per-hour allocation views (issues 899 to 902),
editing or disputing from the contractor side, notifications, API token access,
a navigation entry that appears only for payees, and any money movement.
