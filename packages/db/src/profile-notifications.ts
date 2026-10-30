import type { TeamNotificationPatch, TeamNotificationPreference } from '@ezacto/core'
import { sql } from 'drizzle-orm'
import type { InvoiceStateDatabase } from './invoice-state.js'
import { notification, type NotificationRow } from './team.js'

/**
 * A person's own notification preferences (issue 935).
 *
 * The Team page already lets whoever administers people edit anybody's, as a
 * versioned command. This is the person editing themselves: "per-person
 * opt-out" does not mean writing to an administrator. It writes the same row
 * the Team command does, scoped to the one user id the caller supplies -- the
 * route takes it off the session and never from the request.
 */

const select = (userId: number) =>
  sql`SELECT daily_reminder_enabled AS dailyReminderEnabled, reminder_time AS reminderTime,
             reminder_days AS reminderDays, email_enabled AS emailEnabled,
             desktop_enabled AS desktopEnabled, slack_enabled AS slackEnabled,
             include_in_team_reminders AS includeInTeamReminders,
             weekly_digest AS weeklyDigest, notify_project_deleted AS notifyProjectDeleted,
             updated_at AS updatedAt
      FROM notification_preferences WHERE user_id = ${userId}`

export const readUserNotifications = async (
  database: InvoiceStateDatabase,
  userId: number,
): Promise<TeamNotificationPreference | null> => {
  const [row] = await database.all<NotificationRow>(select(userId))
  return row === undefined ? null : notification(row)
}

export const updateUserNotifications = async (
  database: InvoiceStateDatabase,
  userId: number,
  patch: Readonly<TeamNotificationPatch>,
  now: string,
): Promise<TeamNotificationPreference | null> => {
  await database.run(
    sql`UPDATE notification_preferences SET
          daily_reminder_enabled = ${patch.dailyReminderEnabled ? 1 : 0},
          reminder_time = ${patch.reminderTime},
          reminder_days = ${JSON.stringify(patch.reminderDays)},
          email_enabled = ${patch.emailEnabled ? 1 : 0},
          desktop_enabled = ${patch.desktopEnabled ? 1 : 0},
          slack_enabled = ${patch.slackEnabled ? 1 : 0},
          include_in_team_reminders = ${patch.includeInTeamReminders ? 1 : 0},
          weekly_digest = ${patch.weeklyDigest ? 1 : 0},
          notify_project_deleted = ${patch.notifyProjectDeleted ? 1 : 0},
          updated_at = ${now}
        WHERE user_id = ${userId}`,
  )
  return readUserNotifications(database, userId)
}
