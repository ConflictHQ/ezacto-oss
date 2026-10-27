# Mercury inbound feed feasibility (#101)

Reviewed 2026-10-26. This is a public-documentation spike, not a live-account
acceptance run. No Mercury token, account data, webhook registration or money
movement was used. The existing provider-neutral matcher remains unchanged.

## Read surface

Mercury documents `GET /api/v1/transactions` across accounts, and
`GET /api/v1/account/{accountId}/transactions` for a selected account. The former
supports account filters, ascending/descending order, limits of 1–1000, and
transaction-ID pagination using `start_after` or `end_before`. `start`/`end`
filter creation time; `postedStart`/`postedEnd` filter posting time. These must
not be treated as interchangeable. Status values include pending, sent,
cancelled, failed, reversed and blocked. A transaction can also be fetched
individually for reconciliation.

Sources: [list transactions](https://docs.mercury.com/reference/listtransactions),
[account transactions](https://docs.mercury.com/reference/listaccounttransactions),
[transaction detail](https://docs.mercury.com/reference/gettransactionbyid).

## Credentials and acceptance environment

Use an operator-owned read-only token, or a custom token limited to the required
read scopes. Mercury supports bearer authentication. Read-only tokens do not
require an IP allowlist. Do not provision payment permissions for a feed.
Unused tokens are automatically deleted after 45 days; surface authentication failures rather than
silently treating an inaccessible feed as empty.

The sandbox has separate credentials and the API base
`https://api-sandbox.mercury.com/api/v1/`. Production credentials do not work
there. Its seeded data makes a disposable, nonfinancial adapter acceptance run
possible. No such run has been performed here.

Sources: [authentication](https://docs.mercury.com/docs/getting-started),
[token policy](https://docs.mercury.com/docs/api-token-security-policies),
[sandbox](https://docs.mercury.com/docs/using-mercury-sandbox).

## Implementation boundary

The read API makes a polling adapter feasible. The Events reference defines
positive transaction amounts as credits and negative amounts as debits. Before
accepting deposits, verify the sandbox response's amount units, currency, posting date,
stable transaction identity and internal-transfer classification. Do not infer
these semantics from a field name or assume every positive movement is customer
revenue. Pending and reversed movements cannot become confirmed receipts.

Pagination alone is not a durable change feed: a previously seen transaction can
change status. Mercury also documents 90 days of event history, including
resource versions and create/update/delete operations. Evaluate that endpoint
for updates and retain a rescan strategy for gaps beyond its retention period.
The adapter needs deduplication and explicit treatment of later reversals. Prove those with fixtures derived
from sandbox responses. Preserve the neutral contract's credit-only boundary;
persist only the minimal matching fields, not raw account or attachment data.
Source: [event history and transaction fields](https://docs.mercury.com/reference/events).

Mercury also offers transaction webhooks, but documents that sandbox webhooks are
unavailable. Polling therefore permits the first acceptance run without requiring
a production webhook. [Webhook availability](https://docs.mercury.com/reference/webhooks).

Next: implement durable staging and explicit confirm/reject, then the scoped
polling adapter and sandbox acceptance. This spike neither closes #101 nor proves
the provider-fixture or live acceptance criteria.
