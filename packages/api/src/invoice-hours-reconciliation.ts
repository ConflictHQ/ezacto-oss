/**
 * Whether an invoice's billed hours agree with the time it claims (issue 924).
 *
 * Generated line origins identify exact linked entries without using free-text
 * descriptions or treating fee/expense quantities as hours. Partial coverage
 * stays explicit; has_mismatch still reports offsetting per-line differences.
 * The rollup tolerance accumulates the per-line rounding allowance. Read with the authority that reads the invoice itself and its
 * hours report: a session or a token carrying `invoices:read`.
 */

import type { InvoiceHoursReconciliation } from '@ezacto/core'
import type { Hono } from 'hono'
import { requireApiScope } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError, validationError } from './errors.js'

export interface InvoiceHoursReconciliationService {
  /** `null` for an invoice that does not exist. */
  readHoursReconciliation(
    invoiceId: number,
  ): Promise<InvoiceHoursReconciliation | null>
}

const serializeFigures = (figures: {
  linkedSeconds: number
  billedSeconds: number
  differenceSeconds: number
  status: string
}) => ({
  linked_seconds: figures.linkedSeconds,
  billed_seconds: figures.billedSeconds,
  difference_seconds: figures.differenceSeconds,
  status: figures.status,
})

export const installInvoiceHoursReconciliationRoutes = <
  Bindings extends object,
>(
  api: Hono<ApiContext<Bindings>>,
  service: Readonly<InvoiceHoursReconciliationService>,
): void => {
  api.get('/invoices/:id/hours-reconciliation', async (context) => {
    requireApiScope(context, 'invoices:read')
    const invoiceId = Number(context.req.param('id') ?? '')
    if (!Number.isSafeInteger(invoiceId) || invoiceId <= 0) {
      throw validationError([
        {
          field: 'id',
          code: 'invalid',
          message: 'id must be a positive integer.',
        },
      ])
    }
    const result = await service.readHoursReconciliation(invoiceId)
    if (result === null) {
      throw new ApiError({
        status: 404,
        code: 'not_found',
        message: 'The requested resource does not exist.',
      })
    }
    return context.json(
      {
        data: {
          invoice_id: invoiceId,
          ...serializeFigures(result),
          tolerance_seconds: result.toleranceSeconds,
          total_tolerance_seconds: result.totalToleranceSeconds,
          comparison_complete: result.comparisonComplete,
          has_mismatch: result.hasMismatch,
          invoice_version: result.invoiceVersion ?? null,
          invoice_state: result.invoiceState ?? null,
          not_compared_entry_ids: result.notComparedEntryIds,
          lines: result.lines.map((line) => ({
            line_id: line.lineId,
            project_id: line.projectId,
            entry_ids: line.entryIds,
            ...serializeFigures(line),
          })),
          entries: result.entries.map((entry) => ({
            entry_id: entry.id ?? null,
            user_id: entry.userId ?? null,
            user_name: entry.userName ?? null,
            spent_date: entry.spentDate ?? null,
            project_id: entry.projectId,
            project_name: entry.projectName,
            seconds: entry.seconds,
          })),
          projects: result.projects.map((project) => ({
            project_id: project.projectId,
            project_name: project.projectName,
            tolerance_seconds:
              project.toleranceSeconds ?? result.toleranceSeconds,
            ...serializeFigures(project),
          })),
          not_compared: result.notCompared.map((line) => ({
            line_id: line.id,
            position: line.position,
            description: line.description,
            quantity: line.quantity,
          })),
        },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })
}
