# Bank feed contract (issue 101)

Contract only. No ingest service, route, UI, provider client or migration exists
yet; this fixes the seam so the Mercury and Wise adapters and the review queue
can be built against it independently.

## Neutral deposit

`NeutralDeposit` in `packages/core/src/bank-deposit-matching.ts` maps one to one
onto a `bank_deposits` row: `provider_transaction_id`, `currency` (upper-case
ISO), `posted_at` (canonical UTC), `amount_cents` (positive), `memo`,
`counterparty`. Only memo and counterparty are kept; never an account number.

## Feed

`BankFeed.poll(cursor)` returns credits and an opaque cursor. Invariants every
adapter must pass (`bankFeedContract` in `packages/core/test`):

- Credits only. Our own outbound payouts on the same balance are never returned
  (Wise balances mix both directions).
- Replay-safe: the same cursor returns the same deposits with the same ids.
- A cursor resumes without repeating earlier deposits.
- The store dedupes on `(provider_account_id, provider_transaction_id)`; the
  feed does not have to.

## Matcher

`matchDeposit(deposit, candidates)` is pure and only suggests. Ranks: 1 token and
exact amount, 2 token alone, 3 exact amount within 90 days after the invoice
issue date. The best rank wins; a tie at it leaves the deposit `unmatched`.
Invoices of another currency are never candidates. A suggestion creates no
payment; confirmation is explicit and creates exactly one (domain-model 2.16).

## Delivery still required

Storage-side behaviour (idempotent ingest, atomic confirm, audit rows, a
rejected/ignored state, `/api/v1/bank-deposits`), provider adapters and the review
UI remain unimplemented. The [Mercury feasibility spike](mercury-bank-feed-spike.md)
identifies its read API and the sandbox evidence still needed.

The owner decisions recorded in #101 on 2026-10-24 are: pursue Wise and Mercury
in parallel (D23); one deposit to one invoice in v1, with multi-invoice detection
left for later (D24); leave cross-currency deposits unmatched (D25). Wise must
exclude our own outgoing payouts. These decisions do not constitute provider
acceptance or permission to move money.
