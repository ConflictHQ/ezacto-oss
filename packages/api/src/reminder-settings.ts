import type { Context, Hono } from 'hono'
import { requireSessionPrincipal } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError, validationError } from './errors.js'

/**
 * The organisation's default payment reminder policy (issue 801).
 *
 * One setting: the first reminder goes `first_after_days` after an invoice's
 * due date, then one every `every_days` until the invoice is paid, written off
 * or cancelled. `null` switches the default off. An invoice's own policy, set
 * on the invoice, still wins where it has one.
 */

export interface ReminderPolicyBody {
  readonly first_after_days: number
  readonly every_days: number
}

/**
 * One invoice's answer (issue 850). `invoice` is `false` where the operator
 * switched reminders off for it and `null` where it follows the organisation;
 * `effective` is what will happen, so a screen does not work out the
 * precedence a second time.
 */
export interface InvoiceReminderPreference {
  readonly invoice: boolean | null
  readonly organizationPolicy: ReminderPolicyBody | null
  readonly effective: boolean
  /** The next reminder booked, or null where none is. */
  readonly nextReminderAt: string | null
}

export interface ReminderSettingsService {
  readOrganizationReminderPolicy(): Promise<ReminderPolicyBody | null>
  /** Sets the default and books it for open invoices with nothing pending; how many. */
  setOrganizationReminderPolicy(policy: ReminderPolicyBody | null): Promise<number>
  readInvoiceReminders(invoiceId: number): Promise<InvoiceReminderPreference | null>
  /** `false` switches them off for this invoice; `null` hands it back to the organisation. */
  setInvoiceReminders(invoiceId: number, value: boolean | null): Promise<boolean>
}

const assertMoneyWriter = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): void => {
  const principal = requireSessionPrincipal(context)
  if (!['administrator', 'accounting', 'executive_manager'].includes(principal.profile)) {
    throw new ApiError({
      status: 403,
      code: 'profile_forbidden',
      message: 'Only administrators and accounting can change payment reminders.',
    })
  }
}

const policyOf = (body: Record<string, unknown>): ReminderPolicyBody | null => {
  if (!('reminder_policy' in body)) {
    throw validationError([
      { field: 'reminder_policy', code: 'required', message: 'reminder_policy is required.' },
    ])
  }
  const value = body.reminder_policy
  if (value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw validationError([
      {
        field: 'reminder_policy',
        code: 'invalid',
        message: 'reminder_policy must be an object or null to switch reminders off.',
      },
    ])
  }
  const policy = value as Record<string, unknown>
  const errors = []
  const first = policy.first_after_days
  const every = policy.every_days
  if (typeof first !== 'number' || !Number.isSafeInteger(first) || first < 0 || first > 3650) {
    errors.push({
      field: 'reminder_policy.first_after_days',
      code: 'invalid',
      message: 'first_after_days must be a whole number of days from 0 to 3650.',
    })
  }
  if (typeof every !== 'number' || !Number.isSafeInteger(every) || every < 1 || every > 365) {
    errors.push({
      field: 'reminder_policy.every_days',
      code: 'invalid',
      message: 'every_days must be a whole number of days from 1 to 365.',
    })
  }
  if (errors.length > 0) throw validationError(errors)
  return { first_after_days: first as number, every_days: every as number }
}

const invoiceIdOf = <Bindings extends object>(context: Context<ApiContext<Bindings>>): number => {
  const id = Number(context.req.param('id'))
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new ApiError({ status: 404, code: 'not_found', message: 'Invoice not found.' })
  }
  return id
}

const invoiceFlagOf = (body: Record<string, unknown>): boolean | null => {
  if (!('reminders' in body)) {
    throw validationError([
      { field: 'reminders', code: 'required', message: 'reminders is required.' },
    ])
  }
  const value = body.reminders
  if (value !== null && typeof value !== 'boolean') {
    throw validationError([
      {
        field: 'reminders',
        code: 'invalid',
        message: 'reminders must be true, false, or null to follow the organization.',
      },
    ])
  }
  return value
}

export const installReminderSettingsRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  service: Readonly<ReminderSettingsService>,
): void => {
  const body = async (applied?: number) => ({
    data: {
      reminder_policy: await service.readOrganizationReminderPolicy(),
      ...(applied === undefined ? {} : { applied_to_open_invoices: applied }),
    },
  })

  api.get('/settings/invoice-reminders', async (context) => {
    assertMoneyWriter(context)
    return context.json(await body(), 200, { 'cache-control': 'no-store' })
  })

  api.post('/settings/invoice-reminders', async (context) => {
    assertMoneyWriter(context)
    const raw = (await context.req.json().catch(() => ({}))) as Record<string, unknown>
    const applied = await service.setOrganizationReminderPolicy(policyOf(raw))
    return context.json(await body(applied), 200, { 'cache-control': 'no-store' })
  })

  const invoiceBody = (answer: InvoiceReminderPreference, invoiceId: number) => ({
    data: {
      invoice_id: invoiceId,
      reminders: answer.invoice,
      organization_reminder_policy: answer.organizationPolicy,
      effective: answer.effective,
      next_reminder_at: answer.nextReminderAt,
    },
  })

  api.get('/invoices/:id/reminder-preference', async (context) => {
    assertMoneyWriter(context)
    const invoiceId = invoiceIdOf(context)
    const answer = await service.readInvoiceReminders(invoiceId)
    if (answer === null) {
      throw new ApiError({ status: 404, code: 'not_found', message: 'Invoice not found.' })
    }
    return context.json(invoiceBody(answer, invoiceId), 200, { 'cache-control': 'no-store' })
  })

  api.post('/invoices/:id/reminder-preference', async (context) => {
    assertMoneyWriter(context)
    const invoiceId = invoiceIdOf(context)
    const raw = (await context.req.json().catch(() => ({}))) as Record<string, unknown>
    const wanted = invoiceFlagOf(raw)
    if (!(await service.setInvoiceReminders(invoiceId, wanted))) {
      throw new ApiError({ status: 404, code: 'not_found', message: 'Invoice not found.' })
    }
    const answer = await service.readInvoiceReminders(invoiceId)
    if (answer === null) {
      throw new ApiError({ status: 404, code: 'not_found', message: 'Invoice not found.' })
    }
    return context.json(invoiceBody(answer, invoiceId), 200, { 'cache-control': 'no-store' })
  })
}
