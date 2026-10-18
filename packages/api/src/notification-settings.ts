import type { Context, Hono } from 'hono'
import { requireSessionPrincipal } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError } from './errors.js'
import { assertFields, readObjectBody, unknownFieldErrors } from './resources/support.js'

/**
 * Company settings for the mail ezacto sends its own people (issues 934, 935).
 * Administrators only: these decide who is emailed by the instance, and by
 * whom it is read as the company's own voice.
 */

export interface NotificationSettingsBody {
  readonly budget_alerts_include_admins: boolean
}

export interface NotificationSettingsService {
  read(): Promise<NotificationSettingsBody>
  update(patch: Readonly<Partial<NotificationSettingsBody>>): Promise<NotificationSettingsBody>
}

/** What the repository keeps, in the repository's own spelling. */
export interface NotificationSettingsStore {
  read(): Promise<{ readonly budgetAlertsIncludeAdmins: boolean }>
  update(patch: {
    readonly budgetAlertsIncludeAdmins?: boolean
  }): Promise<{ readonly budgetAlertsIncludeAdmins: boolean }>
}

/** The store behind the wire spelling, so both entries share one mapping. */
export const createNotificationSettingsService = (
  store: Readonly<NotificationSettingsStore>,
): NotificationSettingsService => {
  const wire = (value: { readonly budgetAlertsIncludeAdmins: boolean }): NotificationSettingsBody => ({
    budget_alerts_include_admins: value.budgetAlertsIncludeAdmins,
  })
  return {
    read: async () => wire(await store.read()),
    update: async (patch) =>
      wire(
        await store.update(
          patch.budget_alerts_include_admins === undefined
            ? {}
            : { budgetAlertsIncludeAdmins: patch.budget_alerts_include_admins },
        ),
      ),
  }
}

const assertAdministrator = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): void => {
  const principal = requireSessionPrincipal(context)
  if (principal.profile !== 'administrator') {
    throw new ApiError({
      status: 403,
      code: 'profile_forbidden',
      message: 'Only administrators can change notification settings.',
    })
  }
}

const fields = new Set(['budget_alerts_include_admins'])

export const installNotificationSettingsRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  service: Readonly<NotificationSettingsService>,
): void => {
  api.get('/settings/notifications', async (context) => {
    assertAdministrator(context)
    return context.json({ data: await service.read() }, 200, { 'cache-control': 'no-store' })
  })

  api.post('/settings/notifications', async (context) => {
    assertAdministrator(context)
    const body = await readObjectBody(context)
    const errors = unknownFieldErrors(body, fields)
    const patch: { budget_alerts_include_admins?: boolean } = {}
    if ('budget_alerts_include_admins' in body) {
      if (typeof body.budget_alerts_include_admins !== 'boolean') {
        errors.push({
          field: 'budget_alerts_include_admins',
          code: 'invalid_boolean',
          message: 'budget_alerts_include_admins must be a boolean',
        })
      } else {
        patch.budget_alerts_include_admins = body.budget_alerts_include_admins
      }
    }
    if (Object.keys(patch).length === 0 && errors.length === 0) {
      errors.push({
        field: 'budget_alerts_include_admins',
        code: 'required',
        message: 'name at least one setting to change',
      })
    }
    assertFields(errors)
    return context.json({ data: await service.update(patch) }, 200, { 'cache-control': 'no-store' })
  })
}
