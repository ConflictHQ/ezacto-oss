# Stripe refunds and disputes

Issue #102, owner decision D26: a verified provider report never changes an
invoice receipt or balance automatically. PayPal remains deferred (D27).

The existing raw-body Stripe signature check precedes parsing. Supported reports
are `charge.refunded` and `charge.dispute.created`, `updated`, `closed`,
`funds_withdrawn`, and `funds_reinstated`. Configure these events on the existing
endpoint if the instance wants refund/dispute alerts. No additional provider
write permission or API call is required.

Reports match the original Stripe receipt by `payment_intent`, the configured
single-account identity, and currency. Unknown receipts, mismatched currencies,
and amounts greater than that original receipt are ignored. A refund amount is
Stripe's **cumulative charge refund amount**, not a delta to add to another
report. Dispute amounts are the amount reported for that dispute. History rows
must never be summed into accounting totals.

The database stores minimal immutable event evidence keyed by Stripe event ID,
not customer, card, address, dispute evidence, or the raw webhook. Delivery
replay preserves one report. Out-of-order deliveries remain visible as history,
ordered by provider occurrence time; they never replace a later report or
change money. Each report produces an idempotent administrator notification via
the existing durable mail ledger; the minute scheduler repairs interrupted
queue delivery. Instances without outgoing mail still retain visible reports.

The invoice page shows unresolved reports and reviewed history. A native-session
administrator may mark a report **Reviewed**; the first reviewer and timestamp
are retained. This acknowledges review, not loss recognition, refund execution,
or accounting settlement. A later provider report is unresolved independently.
The existing **Write off** command remains available only for an open invoice
with a positive amount due. A paid invoice has no balance to write off under
this unchanged ledger policy.

No call here captures, refunds, contests, accepts or closes a Stripe dispute.
Operators complete provider actions in Stripe and make any manual accounting
adjustments through existing authorized workflows.

Public reference evidence reviewed 2026-10-26:

- [Stripe event types](https://docs.stripe.com/api/events/types)
- [Charge amount_refunded and payment_intent](https://docs.stripe.com/api/charges/object)
- [Dispute amount, status and payment_intent](https://docs.stripe.com/api/disputes/object)

Acceptance uses synthetic signed webhook payloads against native SQLite and
Miniflare D1. It makes no external provider or production financial writes.
