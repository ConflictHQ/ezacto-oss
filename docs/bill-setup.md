# Billing a client through BILL

Some clients pay through [BILL](https://www.bill.com). This sends those clients
their invoice there and brings the payment back, per client, off by default.

## What it does

When an invoice is sent to a client who is billed through BILL:

1. The client becomes a BILL customer, if it is not one already.
2. The invoice is created in BILL under our own invoice number.
3. It is delivered — by BILL's own invoice email, or by ezacto's email carrying
   a BILL payment link. Which one depends on the credential; see below.

Separately, a reconciliation reads BILL's receivables and records what settled
our invoices.

Clients who are not opted in are untouched: their invoice goes out exactly as it
does now.

## There is no connect button, and that is not an oversight

BILL has no OAuth. There is no authorization code, no consent screen and no
token to exchange, so there is nothing a button could start. The credential is
deployment configuration, set once.

## Credentials

Four values, all required, all secrets:

| variable | where it comes from |
| --- | --- |
| `BILL_DEV_KEY` | Settings → Sync & Integrations → Manage Developer Keys |
| `BILL_COMPANY_ID` | the same page; begins `008` |
| `BILL_USERNAME` | see below |
| `BILL_PASSWORD` | see below |

The last two are one choice with real consequences, because BILL reads both from
the same two fields:

**An AP/AR sync token** — the token's *name* as the username and its *value* as
the password, from Settings → Sync & Integrations → Tokens. This is the safer
option: it is scoped, revocable, and BILL refuses it any operation that moves
money. It also cannot have BILL send an invoice email:

> You do not have permissions for sending an invoice or mailing an invoice.

**An operator's BILL login** — a real email and password. This can have BILL
send its own invoice email. It is a human credential that is not scoped to this
integration, so prefer the sync token unless BILL's own email is what you want.

Two optional values:

| variable | effect |
| --- | --- |
| `BILL_REPLY_TO_USER_ID` | a BILL user id beginning `006`. Set it and BILL sends its own invoice email with that user as the reply-to; leave it and ezacto sends the invoice with a BILL payment link in it. |
| `BILL_ENVIRONMENT` | `sandbox` reaches BILL's test organisation. **Anything else is the real book**, including leaving it unset. |

Set all four or none. A deployment with three has a configuration that cannot
sign in and an operator who believes it can, so the container refuses to start
rather than discovering it on the first invoice.

## Delivery, in more detail

|  | BILL sends | ezacto sends |
| --- | --- | --- |
| needs | an operator login **and** `BILL_REPLY_TO_USER_ID` | any working credential |
| the client receives | BILL's invoice email | ezacto's invoice email, carrying a BILL payment link |
| pays at | BILL | BILL |
| payment tracked | yes | yes |

`GET /api/v1/integrations/bill` reports `can_send_from_bill`, so the difference
is visible rather than discovered.

## Turning it on for a client

```
POST /api/v1/integrations/bill/clients/{clientId}
{ "deliver_via_bill": true }
```

Administrator only: sending a client's invoice through a third party changes how
that client is billed, and it is not a preference set in passing. Turning it on
where the deployment has no credentials is refused — a setting that looks saved
and delivers nothing is worse than an error.

The invoice is emailed to the contact already marked as that client's **invoice
recipient**. Turning BILL on does not change who gets billed. A client with no
such contact is refused rather than sent to nobody.

## Sandbox first

BILL's sandbox is free, standalone, and nothing in it touches the real book.
Sandbox keys do not work in production and production needs a separate account
at `bill.com/signup` (choose *Accounts Payable & Receivable*). Production is
billed after a 30-day trial.

Point `BILL_ENVIRONMENT=sandbox` at it and send a test invoice before letting
this near a real client.

## What it will not do

- **Move money.** Nothing here pays, charges, voids or cancels anything. BILL
  puts those behind an MFA challenge to a registered phone that no unattended
  process can answer, so the wall is the boundary of the client rather than
  something to fail at.
- **Mark the invoice paid in ezacto.** A payment BILL reports is recorded as an
  observation — which invoice, how much, when — and does not yet write the
  invoice's own receipt. That write is guarded by the invoice command ledger,
  which both this and the QuickBooks mirror have to go through; see issue 595.
- **Re-send.** An invoice already in BILL is adopted rather than sent again. An
  invoice a client already has is not improved by arriving twice.
- **Edit.** A sent invoice is not updated in BILL afterwards.

## Retries and duplicates

BILL has no idempotency key on create, so a retried delivery is made safe by our
own invoice number: an invoice carrying it is adopted rather than created again.
The link is recorded **before** delivery is attempted, so a failure after the
create costs a send and not a second invoice to the client.

The payment reconciliation is a poll. It sees every payment again on every pass,
and is keyed on the payment and the invoice together, so the second pass records
nothing — and a single BILL payment that settles several invoices is recorded as
one row per invoice rather than its whole amount against one.
