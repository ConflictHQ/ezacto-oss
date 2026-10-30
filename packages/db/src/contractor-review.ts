import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import {
  buildContractorReview,
  contractorPersonVersion,
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
import { createContractorAcceptanceStore } from './contractor-acceptance.js'
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
  const reader: ContractorReviewStore = {
    async review(month, now) {
      if (!validPaymentMonth(month))
        throw new StaffPaymentError('invalid', 'Choose a valid work month.')
      for (let attempt = 0; attempt < 3; attempt++) {
        const clock = async () =>
          (
            await database.all<{ revision: number }>(
              sql`SELECT revision FROM contractor_source_clock WHERE id=1`,
            )
          )[0]!.revision
        const before = await clock()
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
        const result = buildContractorReview({
          actuals: captured,
          earnings: proposed,
          ledger: register,
          invoices: documents,
          allocations: allocationReport,
          advances: creditReport,
          runs: runReport,
          reviews,
        })
        const versions = new Map(
          (
            await database.all<{ scope: string; revision: number }>(sql`
        SELECT scope,revision FROM contractor_source_versions WHERE scope='all' OR scope LIKE 'person:%' OR scope LIKE ${'month:%:' + month}
      `)
          ).map((row) => [row.scope, row.revision]),
        )
        for (const person of result.people) {
          person.review_version = contractorPersonVersion(person)
          person.source_revision = JSON.stringify([
            versions.get('all') ?? 0,
            versions.get(`person:${person.user_id}`) ?? 0,
            versions.get(`month:${person.user_id}:${month}`) ?? 0,
          ])
        }
        if (before === (await clock())) return result
      }
      throw new StaffPaymentError(
        'conflict',
        'Contractor records changed while loading. Reload the review.',
      )
    },
  }
  return Object.assign(reader, createContractorAcceptanceStore(database, reader.review))
}
