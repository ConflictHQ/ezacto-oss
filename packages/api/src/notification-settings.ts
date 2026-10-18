import { isReminderDay, type ReminderDay } from '@ezacto/core'
import type { Context, Hono } from 'hono'
import { requireSessionPrincipal } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError } from './errors.js'
import {
  assertFields,
  isJsonObject,
  readObjectBody,
  unknownFieldErrors,
} from './resources/support.js'

/**
 * Company settings for the mail ezacto sends its own people (issues 934, 935).
 * Administrators only: these decide who is emailed by the instance, and by
 * whom it is read as the company's own voice.
 */

export interface SubmissionReminderBody {
  readonly day: ReminderDay
  readonly time: string
}

export interface NotificationSettingsBody {
  readonly budget_alerts_include_admins: boolean
  /** When everyone is reminded to submit last week's time; null for never (issue 935). */
  readonly submission_reminder: SubmissionReminderBody | null
}

export interface NotificationSettingsService {
  read(): Promise<NotificationSettingsBody>
  update(patch: Readonly<Partial<NotificationSettingsBody>>): Promise<NotificationSettingsBody>
}

/** What the repository keeps, in the repository's own spelling. */
export interface StoredNotificationSettings {
  readonly budgetAlertsIncludeAdmins: boolean
  readonly submissionReminder: SubmissionReminderBody | null
}

export interface NotificationSettingsStore {
  read(): Promise<StoredNotificationSettings>
  update(patch: {
    readonly budgetAlertsIncludeAdmins?: boolean
    readonly submissionReminder?: SubmissionReminderBody | null
  }): Promise<StoredNotificationSettings>
}

/** The store behind the wire spelling, so both entries share one mapping. */
export const createNotificationSettingsService = (
  store: Readonly<NotificationSettingsStore>,
): NotificationSettingsService => {
  const wire = (value: StoredNotificationSettings): NotificationSettingsBody => ({
    budget_alerts_include_admins: value.budgetAlertsIncludeAdmins,
    submission_reminder: value.submissionReminder,
  })
  return {
    read: async () => wire(await store.read()),
    update: async (patch) =>
      wire(
        await store.update({
          ...(patch.budget_alerts_include_admins === undefined
            ? {}
            : { budgetAlertsIncludeAdmins: patch.budget_alerts_include_admins }),
          ...(patch.submission_reminder === undefined
            ? {}
            : { submissionReminder: patch.submission_reminder }),
        }),
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

const fields = new Set(['budget_alerts_include_admins', 'submission_reminder'])

const canonicalTime = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/

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
    const patch: {
      budget_alerts_include_admins?: boolean
      submission_reminder?: SubmissionReminderBody | null
    } = {}
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
    if ('submission_reminder' in body) {
      const schedule = body.submission_reminder
      if (schedule === null) {
        patch.submission_reminder = null
      } else if (
        !isJsonObject(schedule) ||
        Object.keys(schedule).some((key) => key !== 'day' && key !== 'time') ||
        !isReminderDay(schedule.day) ||
        typeof schedule.time !== 'string' ||
        !canonicalTime.test(schedule.time)
      ) {
        errors.push({
          field: 'submission_reminder',
          code: 'invalid',
          message: 'submission_reminder must be null, or a weekday and a time as HH:MM',
        })
      } else {
        patch.submission_reminder = { day: schedule.day, time: schedule.time }
      }
    }
    if (Object.keys(patch).length === 0 && errors.length === 0) {
      errors.push({
        field: 'body',
        code: 'required',
        message: 'name at least one setting to change',
      })
    }
    assertFields(errors)
    return context.json({ data: await service.update(patch) }, 200, { 'cache-control': 'no-store' })
  })
}
