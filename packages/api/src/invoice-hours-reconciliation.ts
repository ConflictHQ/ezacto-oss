/**
 * Whether an invoice's billed hours agree with the time it claims (issue 924).
 *
 * Generated line origins identify exact linked entries without using free-text
 * descriptions or treating fee/expense quantities as hours. Partial coverage
 * stays explicit; has_mismatch still reports offsetting per-line differences.
 * The rollup tolerance accumulates the per-line rounding allowance. Read with the authority that reads the invoice itself and its
 * hours report: a session or a token carrying `invoices:read`.
 */

import {
  InvoiceTimeReleaseError,
  type InvoiceLineTimeRelease,
  type InvoiceLineTimeReleaseResult,
  type InvoiceHoursReconciliation,
} from '@ezacto/core'
import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { readObjectBody } from './resources/support.js'
import { requireApiScope } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError, validationError } from './errors.js'

export interface InvoiceHoursReconciliationService {
  releaseLineTime?(
    command: InvoiceLineTimeRelease,
    actorUserId: number,
    now: string,
  ): Promise<InvoiceLineTimeReleaseResult>
  /** `null` for an invoice that does not exist. */
  readHoursReconciliation(invoiceId: number): Promise<InvoiceHoursReconciliation | null>
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

export const installInvoiceHoursReconciliationRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  service: Readonly<InvoiceHoursReconciliationService>,
  clock: () => string = () => new Date().toISOString(),
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
          hours_version: result.hoursVersion ?? null,
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
            eligible_for_release: result.invoiceState === 'draft' && entry.running === 0,
          })),
          projects: result.projects.map((project) => ({
            project_id: project.projectId,
            project_name: project.projectName,
            tolerance_seconds: project.toleranceSeconds ?? result.toleranceSeconds,
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
  api.use(
    '/invoices/:id/hours-reconciliation/release',
    bodyLimit({
      maxSize: 65536,
      onError: () => {
        throw new ApiError({
          status: 413,
          code: 'payload_too_large',
          message: 'Select at most 1000 entries.',
        })
      },
    }),
  )
  if (service.releaseLineTime)
    api.post('/invoices/:id/hours-reconciliation/release', async (context) => {
      requireApiScope(context, 'reports:read')
      requireApiScope(context, 'time_entries:write')
      requireApiScope(context, 'invoices:write')
      if (context.get('principal').authentication.kind === 'token') throw new ApiError({status:403,code:'invoice_elevation_required',message:'Use the invoice-scoped elevated CLI command to unlink draft time. The line-hours review workflow uses a browser session.'})
      context.header('cache-control', 'no-store')
      const body = await readObjectBody(context),
        invoiceId = Number(context.req.param('id'))
      const allowed = [
        'command_id',
        'line_id',
        'expected_version',
        'hours_version',
        'entry_ids',
        'confirmed',
      ]
      if (
        !Number.isSafeInteger(invoiceId) ||
        invoiceId < 1 ||
        Object.keys(body).some((key) => !allowed.includes(key)) ||
        body.confirmed !== true ||
        typeof body.command_id !== 'string' ||
        typeof body.line_id !== 'number' ||
        typeof body.expected_version !== 'number' ||
        typeof body.hours_version !== 'string' ||
        !Array.isArray(body.entry_ids) ||
        body.entry_ids.some((id) => typeof id !== 'number')
      )
        throw validationError([
          {
            field: 'release',
            code: 'invalid',
            message:
              'Confirm a saved draft line, its displayed hours review and selected linked entries.',
          },
        ])
      try {
        const record = await service.releaseLineTime!(
          {
            commandId: body.command_id,
            invoiceId,
            lineId: body.line_id,
            expectedVersion: body.expected_version,
            hoursVersion: body.hours_version,
            entryIds: body.entry_ids as number[],
          },
          context.get('principal').userId,
          clock(),
        )
        return context.json(
          {
            data: {
              command_id: record.commandId,
              invoice_id: record.invoiceId,
              line_id: record.lineId,
              expected_version: record.expectedVersion,
              hours_version: record.hoursVersion,
              released_entry_ids: record.releasedEntryIds,
              released_seconds: record.releasedSeconds,
              recorded_at: record.recordedAt,
              replayed: record.replayed,
            },
          },
          200,
          { 'cache-control': 'no-store' },
        )
      } catch (error) {
        if (!(error instanceof InvoiceTimeReleaseError)) throw error
        if (error.code === 'invalid')
          throw validationError([{ field: 'release', code: 'invalid', message: error.message }])
        throw new ApiError({
          status: error.code === 'not_found' ? 404 : 409,
          code: error.code,
          message: error.message,
        })
      }
    })
}
