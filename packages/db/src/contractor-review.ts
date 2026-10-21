import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import {
  buildContractorReview,
  StaffPaymentError,
  validPaymentMonth,
  type ContractorReviewStore,
  type ContractorEarningsReview,
} from '@ezacto/core'
import { createStaffPaymentStore } from './staff-payments.js'
import { createPaymentActualsStore } from './payment-actuals.js'
import { createPaymentReconciliationStore } from './payment-reconciliation.js'
import { createPaymentAllocationStore } from './payment-allocations.js'
import { createStaffInvoicesStore } from './staff-invoices.js'
import { createAdvanceCreditsStore } from './contractor-advances.js'
import { createPaymentRunsService } from './payment-runs.js'

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>
/** Manual/scheduled proposal triggers share this reader. Execution remains in
 * the existing explicit ledger commands and confirmed payment-run executor. */
export const createContractorReviewStore = (database: Database): ContractorReviewStore => {
  const ledger = createStaffPaymentStore(database)
  const actuals = createPaymentActualsStore(database, ledger)
  const earnings = createPaymentReconciliationStore(database)
  const allocations = createPaymentAllocationStore(database)
  const invoices = createStaffInvoicesStore(database)
  const advances = createAdvanceCreditsStore(database)
  // Reports are local reads. No provider is needed or exposed by this reader.
  const payments = createPaymentRunsService(database, null)
  return {
    async review(month, now) {
      if (!validPaymentMonth(month))
        throw new StaffPaymentError('invalid', 'Choose a valid work month.')
      const [
        captured,
        proposed,
        register,
        documents,
        allocationReport,
        creditReport,
        runReport,
        reviews,
      ] = await Promise.all([
        actuals.actuals(month, now),
        earnings.reconciliation(month, now),
        ledger.report(month, now.slice(0, 10)),
        invoices.report(month),
        allocations.allocationReport(month),
        advances.report(
          `${month}-01` < now.slice(0, 10) ? `${month}-01` : now.slice(0, 10),
          now.slice(0, 10),
        ),
        payments.report(month, month, now),
        database.all<ContractorEarningsReview>(sql`
          SELECT a.id,a.user_id,a.currency,a.amount_cents,a.expected_version,a.actor_id,a.note,a.recorded_at
          FROM staff_payment_actuals a WHERE a.month=${month}
            AND a.expected_version=(SELECT MAX(b.expected_version) FROM staff_payment_actuals b WHERE b.user_id=a.user_id AND b.month=a.month)
          ORDER BY a.user_id`),
      ])
      return buildContractorReview({
        actuals: captured,
        earnings: proposed,
        ledger: register,
        invoices: documents,
        allocations: allocationReport,
        advances: creditReport,
        runs: runReport,
        reviews,
      })
    },
  }
}
