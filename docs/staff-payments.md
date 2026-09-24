# Monthly staff payment register

Administrators open **Team → Staff payments** (`/payments`). The same register is linked from Reports. It is available on the Worker and container, independently of payment-provider configuration.

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

The existing optional Deel adapter remains available for people/contract matching, timesheet submission and transfer-log deduplication. See [`packages/integrations`](../packages/integrations/README.md). Selecting Deel here does not configure credentials, submit timesheets or confirm a payout automatically; organizations configure that integration separately.

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
