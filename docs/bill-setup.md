# Billing a client through BILL

Some clients pay through [BILL](https://www.bill.com). This sends those clients
their invoice there and brings the payment back, per client, off by default.

## What it does

When an invoice is sent to a client who is billed through BILL:

1. The client becomes a BILL customer, if it is not one already.
2. The invoice is created in BILL under our own invoice number.
3. It is delivered — by BILL's own invoice email, or by ezacto's email carrying
   a BILL payment link. Which one depends on the credential; see below.

Separately, once an hour, a reconciliation reads BILL's receivables and
records what settled our invoices: the payment lands on the invoice here as a
receipt from BILL, which marks it paid and sends the thank-you like any other.
Before it reads the payments it adopts any open invoice of ours that BILL
already holds under the same number with the same total -- one sent from
Harvest before the cutover, or from here before BILL was configured. Adoption
writes only the link, sends nothing, and does not need the client opted in, so
a client who pays at BILL closes their invoices here whether or not BILL is how
their invoices go out. It also learns the client's BILL customer from the first
invoice adopted, when the client has none yet, so an invoice sent from here
later reaches the record the client's own BILL account already pays rather than
one found by name.

Clients who are not opted in are untouched: their invoice goes out exactly as it
does now.

## There is no connect button, and that is not an oversight

This adapter uses deployment credentials. It has no authorization-code flow
or OAuth consent screen, so there is no Connect button. Configure and rotate
the credential through the deployment environment.

## Credentials

Four values, all required, all secrets:

| variable | where it comes from |
| --- | --- |
| `BILL_DEV_KEY` | Settings → Sync & Integrations → Manage Developer Keys → **Generate developer key**. Name it for this deployment; the key is revealed by the eye icon and begins `01`. |
| `BILL_COMPANY_ID` | the same page, printed at the bottom as *Organization ID*; begins `008` |
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
| `BILL_REPLY_TO_USER_ID` | a BILL user id beginning `006`. Set it and BILL sends its own invoice email with that user as the reply-to; leave it and ezacto sends its invoice email as always, with a BILL payment link in it (the "View invoice" link under the amount due, and `%invoice_payment_url%` for a message that names it) and the invoice also in BILL for the client's own BILL account to pay. |
| `BILL_ENVIRONMENT` | `sandbox` reaches BILL's test organisation. **Anything else is the real book**, including leaving it unset. |

Set all four or none. A deployment with three has a configuration that cannot
sign in and an operator who believes it can, so the container refuses to start
rather than discovering it on the first invoice.

BILL has no sandbox organisation unless you apply for one, and the developer
key is issued by the real organisation, so the usual shape is **production
only**: the values go to the production deployment and the development one is
left unconfigured, where the settings page says so. How the values reach a
deployment, and how to prove they did, is in
[Integrations: where the keys go](integrations.md). Once they are there,
`GET /api/v1/integrations/bill` answers `configured: true` with the company id
and environment, and **Settings → Integrations** shows the same.

## Delivery, in more detail

|  | BILL sends | ezacto sends |
| --- | --- | --- |
| needs | an operator login **and** `BILL_REPLY_TO_USER_ID` | any working credential |
| the client receives | BILL's invoice email | ezacto's invoice email, as always, carrying the BILL payment link; the invoice is in BILL for the client's own BILL account to pay too |
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
at `bill.com/signup` (choose *Accounts Payable & Receivable*). Check BILL's current account terms directly before choosing a production plan.

For the container, select `BILL_ENVIRONMENT=sandbox` and verify a disposable
test invoice. For the Worker, first address the deployment caveat below; the
stock workflow does not deliver that setting.

## What it will not do

- **Move money.** Nothing here pays, charges, voids or cancels anything. BILL
  puts those behind an MFA challenge to a registered phone that no unattended
  process can answer, so the wall is the boundary of the client rather than
  something to fail at.
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


## Deployment caveat and verification

The container accepts `BILL_ENVIRONMENT=sandbox`. The current stock Worker
workflow does not pass `BILL_ENVIRONMENT` through to the runtime: adding a GitHub
secret alone is insufficient. Review an explicit configuration change before
using a sandbox Worker. See [credential deployment](integrations.md).

After deployment, inspect `GET /api/v1/integrations/bill` as an authorized user,
confirm the intended company and environment, and verify the invoice-recipient
contact on a disposable sandbox client. Enabling BILL for a client and sending
its invoice are operational actions, not connection probes. Check the scheduled
reconciliation/outbox processing and verify one receipt after an actual sandbox
payment; do not infer settlement from invoice delivery.

For authentication failures, verify the full credential set, selected BILL
environment and account permissions. For missing receipts, inspect the existing
invoice link and reconciliation result before manually recording a payment.
Before rotation or disablement, review pending deliveries and outstanding
invoices. Replace credentials through the authoritative environment and redeploy;
removing credentials does not withdraw invoices already sent by BILL.
