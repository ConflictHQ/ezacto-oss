# Wise: contractor payout setup

Connect the organization's own Wise business account, verify who pays and who receives, then separately approve payment runs. Wise is configured with an API token, not an OAuth Connect button.

## Prerequisites and current limits

The current runtime uses `https://api.wise.com`; there is no deployed `WISE_ENVIRONMENT` or sandbox-URL setting. Do not insert sandbox credentials and assume the runtime switches to sandbox. Local adapter tests use injected transports; production setup checks should begin with read-only connection checks.

API funding depends on the account and route. Wise currently limits personal-token balance funding to accounts based in the US, Canada, Australia, New Zealand, Singapore and Malaysia. Confirm your own account's eligibility in [Wise's personal-token documentation](https://docs.wise.com/guides/developer/auth-and-security/personal-api-token) and confirm that the quote offers balance funding before approving a payment.

## Create and deploy the credentials

1. Sign into the paying Wise business account. Under **Your Account → Connect and manage apps → API tokens**, create a token with the access needed for recipient, quote, transfer and funding operations. Complete Wise's verification and store the token securely when it is shown.
2. Set `WISE_TOKEN` in the deployment secret store. Pin `WISE_PROFILE_ID` to the intended business profile; do not rely on a guess when the token can reach multiple profiles.
3. Obtain the matching production webhook public key from [Wise's event handling documentation](https://docs.wise.com/guides/developer/webhooks/event-handling), preserving its full PEM format, and set `WISE_WEBHOOK_PUBLIC_KEY`. This is a signature-verification public key, not your API token.
4. Follow [credential deployment](integrations.md) for the Worker or container, and deploy before registering the webhook subscription.

## Verify without moving money

As an authorized money operator, open **Settings → Payouts** or read `GET /api/v1/integrations/wise` in your authenticated session. Confirm:

- `data.configured` is true.
- `data.connection.profile_id` and `profile_name` identify the intended payer.
- `payable_recipients` is plausible for that account.
- `webhooks_verifiable` is true when the verification key is installed. This flag proves configuration, not delivery of a real signed notification.

Link a person's verified Wise recipient or supported Wise contact deliberately. A suggested destination is not an approval to pay it. eZacto retains provider identifiers and deliberately discards Wise's full bank-account summary; do not copy account numbers into notes or logs.

## Register and verify the webhook

Create a profile-level `transfers#state-change` subscription for the paying profile, with this target:

```text
https://app.example.com/webhooks/wise
```

Use [Wise's subscription instructions](https://docs.wise.com/guides/developer/webhooks/subscribe-to-webhooks) for the access available to your account. The endpoint is at the site root, not under `/api/v1`. It is not mounted without `WISE_WEBHOOK_PUBLIC_KEY`. An unauthenticated GET is not a webhook test; inspect a supported signed delivery and its delivery ID/status. Requests are verified using `X-Signature-SHA256` before their contents are trusted.

## Approving and scheduling payments

Use **Payments → Review selected payments**, confirm the recipient, amount/currency, fee, source balance and maximum source cost, then explicitly **Send** or **Schedule**. Approved scheduled runs execute later through the runtime scheduler; the old claim that nothing runs on a schedule no longer applies. See [staff payments](staff-payments.md) for the complete workflow, partial payments, reservations and cancellation limits.

A scheduled time starts processing; it is not a promised bank-arrival time. The Worker processes due runs on its minute tick and the container uses its scheduler. The implementation refreshes the quote before execution and pauses changes beyond the approved limits. When a create/funding response is uncertain, inspect the existing Wise transfer and use reconciliation; do not create a replacement simply because a request timed out.

## Troubleshooting, rotation and stopping

| Symptom | Check |
| --- | --- |
| Provider `401` | Correct, active business token actually deployed |
| Wrong or ambiguous profile | Pin `WISE_PROFILE_ID` after checking the account's profiles |
| Recipient cannot be linked | Recipient belongs to the payer, is active and is not already assigned to another person; check the request ID |
| `created_not_linked` | Wise already created a recipient; link that existing recipient rather than creating another |
| `not_discoverable` | The person's Wise contact details/discoverability settings and the identifier they supplied |
| No supported funding route | Account/country/currency eligibility and available balance; a working recipient lookup does not prove funding permission |
| Invalid webhook signature | Correct environment's PEM key, exact raw body and provider delivery evidence |
| Scheduled run does not advance | Scheduler, current run state, source balance, cost ceiling and retained reservations |

Before rotating, record unresolved transfer identities and scheduled runs. Replace the token through the environment, deploy, verify the payer, then revoke the old token when overlap is supported. To stop new payments, review/cancel eligible unsubmitted scheduled work first; removing a token is not cancellation of an already created or funded transfer. Preserve reconciliation and audit history.

Implementation reference: `packages/integrations/src/wise/`, `packages/api/src/wise.ts`, `docs/staff-payments.md`.
