# Bank feed contract (issue 101)

The provider-neutral seam is implemented by the Mercury and Wise read adapters,
the durable staging/review service, and the native review UI. See
[setup, safety boundaries and recovery](bank-deposit-review.md). Provider acceptance
still requires operator verification; synthetic fixtures do not prove live accounts.

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

## Provider observations

A page may carry observations for IDs omitted from its deposit list. The store
applies these to previously staged rows so a later rejection or internal-transfer
classification cannot leave stale confirmation eligibility. Missing observations
never imply settlement. Known nonpayable observations use `ineligible`; an
operator cannot override them.

The owner decisions are Wise and Mercury in parallel, one deposit per invoice,
and cross-currency deposits unmatched. Multi-invoice allocation and full historical
account import remain outside this slice.
