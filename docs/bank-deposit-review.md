# Bank feeds and deposit review

The inbound bank-feed path stages credits and suggests an invoice. It never
moves funds, refunds a payment, or creates an invoice receipt automatically.
One deposit can be confirmed against one invoice. Cross-currency confirmation
is refused; split allocation remains separate work under #101.

## Configuration

Configure separate read-only deployment credentials and an explicitly selected
account. The existing Wise payout credential is never used implicitly.

| Mercury | Wise |
| --- | --- |
| `MERCURY_BANK_FEED_TOKEN` | `WISE_BANK_FEED_TOKEN` |
| `MERCURY_BANK_FEED_ACCOUNT_ID` | `WISE_BANK_FEED_PROFILE_ID` |
| `MERCURY_BANK_FEED_CURRENCY` | `WISE_BANK_FEED_BALANCE_ID` |
| | `WISE_BANK_FEED_CURRENCY` |

`BANK_FEED_ENVIRONMENT` defaults to `production`; `sandbox` selects the provider's
sandbox host. Mercury's schema does not give the currency: independently verify
the selected account's currency before configuring it. Only currencies with two
minor-unit digits are supported. Provider authentication/SCA requirements still
apply; a read failure never advances the stored cursor.

No credential or technical import form is exposed in the product. With no feed
configured the Bank deposits page says so. Partial configuration is reported as
`configuration_invalid` and does not break unrelated invoice routes. Public demo
runtimes always disable bank feeds, even if deployment inputs contain credentials.

Worker uses a dedicated five-minute schedule; Container checks due feeds on its
normal scheduler. A lease permits one poll for an account at a time. Each poll
reads one page of at most 100 source observations. The last 30 days are scanned;
that exact window is retained across pages. A completed cycle waits five minutes
before beginning a fresh rolling scan. This is not a historical full-account
import. See [adapter evidence and limitations](bank-feed-adapters.md).

## Review

Administrators and accounting use **Invoices → Bank deposits**. Assigning another
same-currency invoice changes only a suggestion. Confirm displays the selected
invoice, amount and remaining balance; the whole deposit is recorded through
the existing invoice-payment command. Overpayment requires explicit agreement.
The receipt, invoice state, outbox events and review audit commit together.
Deleting the receipt through the existing invoice workflow unconfirms the credit.

Confirmed and rejected deposits are not re-suggested by replay. Source amounts,
identity, date, memo and counterparty cannot silently change. A changed duplicate
is refused for investigation. Reject and reopen are explicit audited actions.

Provider settlement and source classification are separate facts. A known final
external credit is ready for confirmation. An administrator can separately
verify an uncertain or final-but-ambiguous external credit after checking posted
funds at the provider, recording a source reference and explicitly confirming
that it is a customer credit. The original provider observation remains intact;
the UI labels this basis **operator**. Known pending, reversed, ineligible or
internal transfers cannot be overridden. A later changed provider observation
invalidates that attestation, including observation-only updates for omitted
credits. A receipt already confirmed is retained for accounting review rather
than automatically deleted by a bank update.

## Privacy and recovery

Only normalized credit fields, provider resource IDs, opaque pagination state
and review evidence are stored. Provider credentials remain deployment secrets;
raw statements, routing/account-number fields and attachments are not retained.
Review and status APIs require native administrator/accounting sessions; source
attestation requires an administrator. API tokens and ordinary members cannot
read or mutate the queue. Write-time session/role/version/currency checks fence
revocation and concurrent review.

The existing backup inventory includes these financial records. Account closure
reports user-linked review/attestation history as retained financial attribution.
No provider acceptance is claimed from synthetic tests: live operator account,
currency, scope and finality verification remain required before real usage.
