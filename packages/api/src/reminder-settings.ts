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

export interface ReminderSettingsService {
  readOrganizationReminderPolicy(): Promise<ReminderPolicyBody | null>
  setOrganizationReminderPolicy(policy: ReminderPolicyBody | null): Promise<void>
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

export const installReminderSettingsRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  service: Readonly<ReminderSettingsService>,
): void => {
  const body = async () => ({
    data: { reminder_policy: await service.readOrganizationReminderPolicy() },
  })

  api.get('/settings/invoice-reminders', async (context) => {
    assertMoneyWriter(context)
    return context.json(await body(), 200, { 'cache-control': 'no-store' })
  })

  api.post('/settings/invoice-reminders', async (context) => {
    assertMoneyWriter(context)
    const raw = (await context.req.json().catch(() => ({}))) as Record<string, unknown>
    await service.setOrganizationReminderPolicy(policyOf(raw))
    return context.json(await body(), 200, { 'cache-control': 'no-store' })
  })
}
