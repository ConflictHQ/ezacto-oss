import {
  reminderDays,
  type ReminderDay,
  type TeamNotificationPatch,
  type TeamNotificationPreference,
} from '@ezacto/core'
import type { Hono } from 'hono'
import { requireSessionPrincipal } from './auth.js'
import type { ApiContext } from './context.js'
import { validationError, type FieldError } from './errors.js'
import { readObjectBody, unknownFieldErrors } from './resources/support.js'

/**
 * A person's notification preferences (issue 935): the daily time reminder, the
 * mail channel, the team reminders and the weekly digest.
 *
 * One parser for the two places they are set -- an administrator editing
 * somebody on the Team page, and a person editing themselves -- so the two
 * cannot come to disagree about what is acceptable.
 *
 * What cannot be delivered is refused rather than stored: desktop and Slack
 * have no delivery, and neither has the project-deletion notice. Storing a
 * preference nothing honours is how the earlier release came to say, in the
 * interface, that delivery was inactive.
 */

export const notificationPreferenceFields = [
  'daily_reminder_enabled',
  'reminder_time',
  'reminder_days',
  'channels',
  'include_in_team_reminders',
  'weekly_digest',
  'notify_project_deleted',
] as const

const canonicalTime = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/u

export const snakeNotification = (value: Readonly<TeamNotificationPreference>) => ({
  delivery_active: value.deliveryActive,
  daily_reminder_enabled: value.dailyReminderEnabled,
  reminder_time: value.reminderTime,
  reminder_days: [...value.reminderDays],
  channels: {
    email: value.emailEnabled,
    desktop: value.desktopEnabled,
    slack: value.slackEnabled,
  },
  include_in_team_reminders: value.includeInTeamReminders,
  weekly_digest: value.weeklyDigest,
  notify_project_deleted: value.notifyProjectDeleted,
  updated_at: value.updatedAt,
})

const booleanField = (
  body: Readonly<Record<string, unknown>>,
  field: string,
  errors: FieldError[],
): boolean | undefined => {
  if (!Object.hasOwn(body, field)) return undefined
  const value = body[field]
  if (typeof value !== 'boolean') {
    errors.push({ field, code: 'invalid_boolean', message: `${field} must be a boolean` })
    return undefined
  }
  return value
}

/**
 * The patch the body asks for, or null with the reasons in `errors`. Every
 * field is required: a preference form always sends the whole of it, and a
 * partial update could not say whether a missing day meant "unchanged" or "off".
 */
export const parseNotificationPreferences = (
  body: Readonly<Record<string, unknown>>,
  errors: FieldError[],
): TeamNotificationPatch | null => {
  const daily = booleanField(body, 'daily_reminder_enabled', errors)
  const include = booleanField(body, 'include_in_team_reminders', errors)
  const weekly = booleanField(body, 'weekly_digest', errors)
  const deleted = booleanField(body, 'notify_project_deleted', errors)
  const time = body.reminder_time
  if (time !== null && (typeof time !== 'string' || !canonicalTime.test(time))) {
    errors.push({ field: 'reminder_time', code: 'invalid_time', message: 'reminder_time must be HH:MM or null' })
  }
  const days = body.reminder_days
  if (
    !Array.isArray(days) ||
    !days.every((day) => typeof day === 'string' && reminderDays.includes(day as ReminderDay)) ||
    new Set(days).size !== days.length
  ) {
    errors.push({ field: 'reminder_days', code: 'invalid_array', message: 'reminder_days must contain distinct weekdays' })
  }
  const channels = body.channels
  const channel =
    typeof channels === 'object' && channels !== null && !Array.isArray(channels)
      ? (channels as Record<string, unknown>)
      : null
  if (
    channel === null ||
    Object.keys(channel).some((field) => !['email', 'desktop', 'slack'].includes(field)) ||
    typeof channel.email !== 'boolean' ||
    typeof channel.desktop !== 'boolean' ||
    typeof channel.slack !== 'boolean'
  ) {
    errors.push({ field: 'channels', code: 'invalid', message: 'channels requires email, desktop, and slack booleans' })
  } else {
    if (channel.slack) {
      errors.push({ field: 'channels.slack', code: 'unavailable', message: 'Slack reminders require a configured Slack connector.' })
    }
    if (channel.desktop) {
      errors.push({ field: 'channels.desktop', code: 'unavailable', message: 'Desktop notifications are not delivered by this release.' })
    }
  }
  if (
    daily === true &&
    (time === null || !Array.isArray(days) || days.length === 0 || channel === null || channel.email !== true)
  ) {
    errors.push({
      field: 'daily_reminder_enabled',
      code: 'incomplete',
      message: 'Daily reminders require a time, at least one day, and the email channel.',
    })
  }
  if ([daily, include, weekly, deleted].some((value) => value === undefined)) {
    errors.push({ field: 'body', code: 'required', message: 'All notification preference fields are required.' })
  }
  if (deleted === true) {
    errors.push({
      field: 'notify_project_deleted',
      code: 'unavailable',
      message: 'The project-deletion notice is not delivered by this release.',
    })
  }
  if (errors.length > 0) return null
  return {
    dailyReminderEnabled: daily!,
    reminderTime: time as string | null,
    reminderDays: days as ReminderDay[],
    emailEnabled: channel!.email as boolean,
    desktopEnabled: false,
    slackEnabled: false,
    includeInTeamReminders: include!,
    weeklyDigest: weekly!,
    notifyProjectDeleted: false,
  }
}

/** Your own preferences, for the page where you set them (Settings, You). */
export interface ProfileNotificationsPort {
  read(userId: number): Promise<TeamNotificationPreference | null>
  update(userId: number, patch: Readonly<TeamNotificationPatch>): Promise<TeamNotificationPreference | null>
}

export const installProfileNotificationRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  port: Readonly<ProfileNotificationsPort>,
): void => {
  api.get('/profile/notifications', async (context) => {
    const principal = requireSessionPrincipal(context)
    const preferences = await port.read(principal.userId)
    if (preferences === null) {
      throw validationError([{ field: 'user', code: 'not_found', message: 'Your account was not found.' }])
    }
    return context.json({ data: snakeNotification(preferences) }, 200, { 'cache-control': 'no-store' })
  })

  api.post('/profile/notifications', async (context) => {
    const principal = requireSessionPrincipal(context)
    const body = await readObjectBody(context)
    const errors = unknownFieldErrors(body, new Set(notificationPreferenceFields))
    const patch = parseNotificationPreferences(body, errors)
    if (patch === null) throw validationError(errors)
    const saved = await port.update(principal.userId, patch)
    if (saved === null) {
      throw validationError([{ field: 'user', code: 'not_found', message: 'Your account was not found.' }])
    }
    return context.json({ data: snakeNotification(saved) }, 200, { 'cache-control': 'no-store' })
  })
}
