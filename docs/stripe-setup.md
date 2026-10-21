# Stripe: collecting payment on invoices

This integration lets an organization's clients pay its eZacto invoices through Stripe. It is separate from subscription billing for the hosted eZacto service. Use the account that should receive this organization's invoice payments.

## Configure a test deployment

1. Select the intended Stripe account and test environment. Provide a server API key with the permissions required to create the Products/Prices and Payment Links used by the adapter. Keep it in `STRIPE_API_KEY`, never in a frontend variable.
2. Configure an HTTPS webhook destination at:

   ```text
   https://app.example.com/webhooks/stripe
   ```

3. Subscribe to `checkout.session.completed` and `checkout.session.async_payment_succeeded` using the **snapshot** payload format expected by this implementation. Set that endpoint's signing secret as `STRIPE_WEBHOOK_SECRET`. A Stripe CLI listener has a different signing secret from a dashboard endpoint; use the one that generated the deliveries you are testing.
4. Deploy both secrets using [the integration deployment guide](integrations.md). Use test credentials and a test database together; do not mix test invoice IDs with a live account.

Stripe documents [Payment Links](https://docs.stripe.com/payment-links/create) and [webhook destinations/signatures](https://docs.stripe.com/webhooks). The eZacto adapter, rather than generic Stripe feature availability, determines which payment events your release handles.

## Verify the complete invoice path

Create a disposable invoice in the test instance, enable its Stripe card-payment option (`stripe_checkout`), and open its generated payment link. Complete payment using Stripe's test tools. Verify the event is delivered to this instance, signature verification succeeds, and the invoice gets exactly one receipt for the expected amount. Redelivery of that same event must not create another receipt.

The handler records `checkout.session.completed` and `checkout.session.async_payment_succeeded` only when `payment_status` is `paid`. An unpaid completion or `checkout.session.async_payment_failed` is acknowledged without recording money. Delayed payment methods need the asynchronous-success event enabled on your endpoint; see [Stripe’s fulfillment guide](https://docs.stripe.com/checkout/fulfillment). A browser success page alone is not payment evidence.

Invoice metadata (including the legacy `ezacto_invoice_id` key) selects the invoice; when metadata is absent, the session’s `payment_link` can identify a link already stored by this instance. The payment intent is the idempotency key: redelivering an event or sending a different event for that same intent must not add another receipt. A different currency is refused rather than converted.

A payment above the current balance is not applied. The runtime emits a structured `[payments] provider payment not recorded` warning with the provider transaction, invoice, amount and balance for manual reconciliation. Check the provider record before taking action; acknowledgement is not evidence that this money was applied to an invoice. Refund/dispute reconciliation remains a separate, unsupported path; these events do not delete payments or reopen invoices automatically.

For live activation, deliberately select the receiving account's live key and live endpoint secret, deploy, and verify account/mode without charging a real customer as a diagnostic. Real invoice sending and payment collection are separate operator actions.

| Symptom | Check |
| --- | --- |
| No card payment link | API key, invoice payment option and positive outstanding balance |
| Link creation is forbidden | Stripe key permissions and selected account/mode |
| Webhook signature fails | Correct endpoint secret, unmodified raw body and deployment clock |
| Webhook accepted but no receipt | Event type, paid status, invoice mapping and relevant amount/provider evidence |
| Payment appears twice in another accounting system | Review mirror/provider receipt identities before manually recording it again |

Rotate keys through the authoritative environment and verify the new deployment before retiring the old key when overlap is supported. Before disconnecting, review outstanding links and deliveries. Removing eZacto credentials does not deactivate already issued Stripe links or refund payments; manage those deliberately in the provider and preserve the reconciliation record.

Implementation reference: `packages/integrations/src/stripe/`, `packages/api/src/stripe.ts`, `entries/worker/src/runtime.ts`.
