# Paying people through Wise

What an operator has to do at Wise before **Settings → Payouts** shows a paying
profile, and why each value exists.

## What it does

Contractors and staff are paid from the organisation's own Wise account. Each
person who is paid supplies a destination once -- a bank account, in Wise's
terms a *recipient* -- and ezacto stores the recipient id Wise hands back
against that person. A payout then names that id and nothing else: no bank
account number is ever held here, and a payout is never resolved from a guess
about somebody's email address.

Wise can also tell the deployment what became of a transfer, through a webhook
whose deliveries are signature-checked before they are read.

## There is no connect button

Wise is not an OAuth pair. The token authenticates as the business that sends
the money, so there is nothing for an administrator to authorise in a browser:
the token is a deployment secret, and the Payouts screen reports the state it
produces.

## Credentials

| variable | where it comes from |
| --- | --- |
| `WISE_TOKEN` | the business account's API token: Wise → your business profile → **Settings → API tokens → Add new token**. It needs **full access**, because creating a recipient is a write; a read-only token can list profiles and nothing more. Wise shows the token once. |
| `WISE_PROFILE_ID` | which profile pays, where the token reaches more than one. A token on a personal account usually also reaches a business profile; a business profile is chosen on its own when it is the only one of its kind, but naming it is better, because an account with two business profiles is a question nothing here can answer. `GET /api/v1/integrations/wise` reports the id and name of the profile that was chosen, so the quickest way to find the id is to set the token alone, read the route, and pin the id it chose if it is the right one. |
| `WISE_WEBHOOK_PUBLIC_KEY` | the PEM Wise signs webhook deliveries with, published in Wise's webhook documentation (one key for the live API, another for the sandbox). Without it the webhook route is **not mounted**: an unverifiable claim about money is not one to act on. |

The token alone is enough for the Payouts screen and for paying people. The
webhook key is what lets a transfer's outcome come back on its own rather than
being looked up.

## The webhook

In Wise, under the same profile: **Settings → Webhooks → Create subscription**,
subscribed to *transfer state changes* (`transfers#state-change`), pointed at

```
https://<your-host>/webhooks/wise
```

on the site root, not under `/api/v1`. Create the subscription **after** the
deployment carries the public key; Wise begins delivering as soon as it is
saved, and a deployment without the key answers nothing on that path.

## Where the values go

How the values reach a deployment, and how to prove they did, is in
[Integrations: where the keys go](integrations.md). A wrong or revoked token
does not hide: the Payouts screen says the connection could not be loaded and
names the request id, and the Worker log for that id carries Wise's own answer
(a `401` from `/v2/profiles` is a bad token).

## What it will not do

- **Move money on its own.** A payout is proposed here and approved by a person;
  nothing runs on a schedule.
- **Hold an account number.** Wise returns the full number on a recipient
  despite calling it a summary; the client discards it before it can reach a
  row or a screen.
