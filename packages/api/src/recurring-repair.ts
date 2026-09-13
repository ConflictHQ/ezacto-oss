/**
 * Seeing and repairing a recurring definition an import could not finish
 * (issue 648, split out of 288).
 *
 * `definition_status = 'incomplete'` is a legitimate state -- an import records
 * "this exists and we do not yet know how it bills" -- and every other recurring
 * route filters those rows out. That is right for the routes that generate
 * invoices and was wrong as a whole: the stubs carried live billing that no
 * screen could see and no route could repair.
 *
 * Two routes, and they are deliberately not the ordinary recurring routes. A
 * stub has NULL terms, so it cannot be returned as a complete definition without
 * the resource type lying; and completing is not editing, so it is not a PATCH.
 */

import type { Context, Hono } from 'hono'
import { requireSessionPrincipal } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError, validationError, type FieldError } from './errors.js'

export interface IncompleteRecurringResource {
  id: number
  harvest_id: number | null
  client_id: number
  client_name: string
  invoice_count: number
  created_at: string
  updated_at: string
}

export interface RecurringRepairTerms {
  clientId: number
  subjectTemplate: string
  notesTemplate: string
  everyNMonths: number
  dayOfMonth: number
  nextIssueOn: string
  amountConfig: unknown
  canDrawFromRetainerId: number | null
  actorUserId: number
  occurredAt: string
}

export interface RecurringRepairService {
  listIncomplete(): Promise<readonly IncompleteRecurringResource[]>
  complete(
    id: number,
    terms: RecurringRepairTerms,
  ): Promise<{ outcome: 'completed' | 'not_found' | 'already_complete' }>
}

/**
 * Who may give a billing definition its terms.
 *
 * The same gate as the rest of the money surface. Completing a stub decides what
 * a client is charged every month from now on, which is not a thing everyone who
 * can edit their own time should be able to do.
 */
const assertMoneyWriter = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): number => {
  const principal = requireSessionPrincipal(context)
  if (!['administrator', 'accounting', 'executive_manager'].includes(principal.profile)) {
    throw new ApiError({
      status: 403,
      code: 'profile_forbidden',
      message: 'Only administrators and accounting can complete a recurring definition.',
    })
  }
  return principal.userId
}

const DATE = /^\d{4}-\d{2}-\d{2}$/u

/**
 * Every field, or none of them.
 *
 * The table refuses `complete` unless all the terms are present, so a partial
 * body would be a constraint failure dressed as a validation pass. Reporting
 * every missing field at once also means somebody transcribing from an old
 * system fixes one form rather than discovering the fields one refusal at a
 * time.
 */
const parseTerms = (body: Record<string, unknown>): Omit<RecurringRepairTerms, 'actorUserId' | 'occurredAt'> => {
  const errors: FieldError[] = []
  const integer = (field: string, min: number, max: number): number => {
    const value = body[field]
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
      errors.push({
        field,
        code: 'invalid',
        message: `${field} must be an integer from ${String(min)} to ${String(max)}.`,
      })
      return min
    }
    return value
  }
  const clientId = integer('client_id', 1, Number.MAX_SAFE_INTEGER)
  const subject = body.subject_template
  if (typeof subject !== 'string' || subject.trim().length === 0) {
    errors.push({
      field: 'subject_template',
      code: 'invalid',
      message: 'subject_template must be a non-empty string.',
    })
  }
  const notes = body.notes_template
  if (typeof notes !== 'string') {
    errors.push({
      field: 'notes_template',
      code: 'invalid',
      message: 'notes_template must be a string.',
    })
  }
  const everyNMonths = integer('every_n_months', 1, Number.MAX_SAFE_INTEGER)
  const dayOfMonth = integer('day_of_month', 1, 31)
  const nextIssueOn = body.next_issue_on
  if (typeof nextIssueOn !== 'string' || !DATE.test(nextIssueOn)) {
    errors.push({
      field: 'next_issue_on',
      code: 'invalid',
      message: 'next_issue_on must be a YYYY-MM-DD date.',
    })
  }
  if (body.amount_config === undefined || body.amount_config === null) {
    errors.push({
      field: 'amount_config',
      code: 'required',
      message: 'amount_config is required.',
    })
  }
  const retainer = body.can_draw_from_retainer_id ?? null
  if (retainer !== null && (typeof retainer !== 'number' || !Number.isSafeInteger(retainer) || retainer < 1)) {
    errors.push({
      field: 'can_draw_from_retainer_id',
      code: 'invalid',
      message: 'can_draw_from_retainer_id must be a positive integer or null.',
    })
  }
  if (errors.length > 0) throw validationError(errors)
  return {
    clientId,
    subjectTemplate: subject as string,
    notesTemplate: notes as string,
    everyNMonths,
    dayOfMonth,
    nextIssueOn: nextIssueOn as string,
    amountConfig: body.amount_config,
    canDrawFromRetainerId: retainer as number | null,
  }
}

export const installRecurringRepairRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  service: Readonly<RecurringRepairService>,
  clock: () => string,
): void => {
  api.get('/recurring-invoices/incomplete', async (context) => {
    assertMoneyWriter(context)
    return context.json({ data: await service.listIncomplete() }, 200, {
      'cache-control': 'no-store',
    })
  })

  api.post('/recurring-invoices/:id/completion', async (context) => {
    const actorUserId = assertMoneyWriter(context)
    const id = Number(context.req.param('id') ?? '')
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw validationError([
        { field: 'id', code: 'invalid', message: 'id must be a positive integer.' },
      ])
    }
    const body = (await context.req.json().catch(() => ({}))) as Record<string, unknown>
    const terms = parseTerms(body)
    const result = await service.complete(id, { ...terms, actorUserId, occurredAt: clock() })
    if (result.outcome === 'not_found') {
      throw new ApiError({
        status: 404,
        code: 'not_found',
        message: 'The requested resource does not exist.',
      })
    }
    if (result.outcome === 'already_complete') {
      // Completing is not editing, and a caller that meant to edit should be
      // told where to go rather than silently obeyed.
      throw new ApiError({
        status: 409,
        code: 'definition_already_complete',
        message: 'This definition already has its terms. Edit it instead.',
      })
    }
    return context.json({ data: { id, completed: true } }, 200, { 'cache-control': 'no-store' })
  })
}
