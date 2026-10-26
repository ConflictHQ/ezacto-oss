# Read-only bank feeds (#101)

The integrations package exposes `createMercuryBankFeed` and `createWiseBankFeed`.
These make provider GET requests, return normalized deposits plus explicit
provider observations, and never create a payment or change a provider account.
The review store owns cursor persistence and deduplication. No credential is
read implicitly from an existing payout configuration.

Both constructors require an operator-selected account, currency and explicit
UTC interval (at most 31 days). Mercury requires `accountId`; Wise requires
`profileId` and `balanceId`. Mercury's account and transaction schemas do not
supply the account currency: its configured currency must be independently
verified. Wise validates the returned statement account, currency and interval.
The neutral cents contract currently supports currencies with two minor-unit
digits; unsupported minor units are rejected, never converted or rounded.

Each poll performs one bounded GET. Mercury requests 100 source rows using
provider pagination. The next cursor uses the last raw transaction ID, including filtered rows; the provider's `nextPage` only signals that another page exists. Wise's statement endpoint has no pagination, so a bounded
statement response (2 MiB, at most 10,000 rows) is sorted by UTC date and unique
reference and returned in pages of 100 deposits. Cursors bind provider,
environment, account, currency and interval; moving a cursor between these
contexts fails. A terminal null cursor starts a fresh scan of the same interval
on the next poll. The scheduler must deliberately select subsequent intervals
and periodically rescan historical intervals for changes; pagination is not an
immutable change feed. A failed/oversized/invalid response never returns a cursor.

## Classification and confirmation

Mercury emits positive posted entries. Explicit internal/treasury transfers,
outgoing payments, known card credits/refunds, fees, interest and verified own
counterparties are omitted. Explicit return/refund relations are omitted; an original credit linked to a later return is marked reversed, and unknown relations remain ambiguous. `sent` plus `postedAt` produces a final observation;
`pending`, `reversed` and unknown states remain distinct. Incoming wires and
checks are external credits; other positive kinds remain ambiguous for review.
An external credit is not automatically an invoice payment.

Wise emits positive CREDIT statement rows, excluding explicit own movement,
conversion, top-up, card and interest categories. `DEPOSIT` is an external-credit
classification; other retained kinds are ambiguous. **The public statement
schema does not specify a settlement status.** These observations therefore use
`unknown`, not `pending` or an invented settled state. The implementation does
not assert that statement credits are unsettled: the missing proof must be
resolved with provider-supported evidence or an explicit audited operator
verification before confirmation. The separate incoming-transfer API exposes
`CREDITED` and `creditedTime`, but Wise states that access requires an
implementation manager; it cannot be assumed for existing personal API tokens.

Only IDs, credited amounts/currency, UTC date, payment memo, sender name, and
static classification codes leave the parser. Account/routing details,
attachments and full provider bodies are not returned or included in errors.
HTTP status is retained for authentication/rate-limit diagnostics. Origins are
fixed to documented production/sandbox hosts; redirects are refused.

## Evidence and remaining acceptance

`packages/integrations/test/bank-feed.test.ts` uses explicitly synthetic values
against the documented schemas. It proves exclusion/classification, pagination,
replay, account/currency/date checks, exact cents, bounded responses and sanitized
failures. No fixture claims captured Mercury/Wise provenance. No production or
sandbox credential was used, no provider resource was created, and #101 remains
open pending real provider acceptance and integrated review/confirmation proof.

Official sources inspected 2026-10-26:

- [Mercury transactions](https://docs.mercury.com/reference/listtransactions)
- [Mercury accounts](https://docs.mercury.com/reference/getaccounts)
- [Mercury event meanings and status changes](https://docs.mercury.com/reference/events)
- [Mercury sandbox](https://docs.mercury.com/docs/using-mercury-sandbox)
- [Wise statement endpoint and response schema](https://docs.wise.com/api-reference/balance-statement/balancestatementget)
- [Wise incoming-transfer access and CREDITED state](https://docs.wise.com/api-reference/incoming-transfer)
- [Wise confirmation versus cancellation evidence](https://wise.com/help/articles/2977946/how-do-i-download-a-transfer-confirmation)
