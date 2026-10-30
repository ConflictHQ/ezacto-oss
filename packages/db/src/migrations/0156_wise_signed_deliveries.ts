// #1200: legacy delivery IDs came from unsigned headers and cannot occupy the
// trusted raw-body digest keyspace. Keep every historical row unchanged.
import { wiseWebhookDeliveriesMigration } from './0064_wise_webhook_deliveries.js'
import { paymentRunsMigration } from './0093_payment_runs.js'
import { contractorAdvancesMigration } from './0136_contractor_advances.js'

const trigger = (statements: readonly string[], name: string) => {
  const original = statements.find((statement) => statement.startsWith(`CREATE TRIGGER ${name} `))
  if (!original) throw new Error(`Missing signed Wise migration trigger ${name}`)
  return original
}

export const wiseSignedDeliveriesMigration = [
  ...wiseWebhookDeliveriesMigration.map((statement) =>
    statement
      .replaceAll('wise_webhook_deliveries', 'wise_signed_webhook_deliveries')
      .replace('BEFORE UPDATE OF subscription_id', 'BEFORE UPDATE OF delivery_id, subscription_id'),
  ),
  `CREATE VIEW wise_all_webhook_deliveries AS
    SELECT *, 'legacy-header' AS identity_source FROM wise_webhook_deliveries
    UNION ALL
    SELECT *, 'signed-payload' AS identity_source FROM wise_signed_webhook_deliveries`,
  // Existing earnings receipt dates and late-paid polling must see both ledgers.
  'DROP TRIGGER payment_item_settle',
  trigger(contractorAdvancesMigration, 'payment_item_settle').replaceAll(
    'wise_webhook_deliveries',
    'wise_all_webhook_deliveries',
  ),
  trigger(paymentRunsMigration, 'payment_run_wise_delivery')
    .replaceAll('payment_run_wise_delivery', 'payment_run_wise_signed_delivery')
    .replaceAll('wise_webhook_deliveries', 'wise_signed_webhook_deliveries'),
] as const
