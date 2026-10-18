import { sql } from 'drizzle-orm'
import type { InvoiceStateDatabase } from './invoice-state.js'

/**
 * The company-wide switches for the mail ezacto sends its own people
 * (issues 934, 935). Per-person choices live with the person.
 */
export interface SubmissionReminderSchedule {
  readonly day: 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday'
  /** `HH:MM`, read on each person's own wall clock. */
  readonly time: string
}

export interface NotificationSettings {
  /**
   * Administrators are copied on every budget alert (issue 934), not only when
   * a project has no manager to tell. Off by default.
   */
  readonly budgetAlertsIncludeAdmins: boolean
  /**
   * When everyone is reminded to submit last week's time (issue 935), or null
   * for never. Off by default: nobody is mailed because a deployment upgraded.
   */
  readonly submissionReminder: SubmissionReminderSchedule | null
}

export const readNotificationSettings = async (
  database: InvoiceStateDatabase,
): Promise<NotificationSettings> => {
  const [row] = await database.all<{
    includeAdmins: number
    day: SubmissionReminderSchedule['day'] | null
    time: string | null
  }>(
    sql`SELECT budget_alerts_include_admins AS includeAdmins,
               submission_reminder_day AS day, submission_reminder_time AS time
        FROM organizations WHERE id = 1`,
  )
  return {
    budgetAlertsIncludeAdmins: row?.includeAdmins === 1,
    submissionReminder:
      row?.day != null && row.time != null ? { day: row.day, time: row.time } : null,
  }
}

export const updateNotificationSettings = async (
  database: InvoiceStateDatabase,
  patch: Readonly<Partial<NotificationSettings>>,
  now: string,
): Promise<NotificationSettings> => {
  if (patch.budgetAlertsIncludeAdmins !== undefined) {
    await database.run(
      sql`UPDATE organizations
          SET budget_alerts_include_admins = ${patch.budgetAlertsIncludeAdmins ? 1 : 0},
              updated_at = ${now}
          WHERE id = 1`,
    )
  }
  if (patch.submissionReminder !== undefined) {
    await database.run(
      sql`UPDATE organizations
          SET submission_reminder_day = ${patch.submissionReminder?.day ?? null},
              submission_reminder_time = ${patch.submissionReminder?.time ?? null},
              updated_at = ${now}
          WHERE id = 1`,
    )
  }
  return readNotificationSettings(database)
}
