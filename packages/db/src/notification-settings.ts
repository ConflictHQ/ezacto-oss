import { sql } from 'drizzle-orm'
import type { InvoiceStateDatabase } from './invoice-state.js'

/**
 * The company-wide switches for the mail ezacto sends its own people
 * (issues 934, 935). Per-person choices live with the person.
 */
export interface NotificationSettings {
  /**
   * Administrators are copied on every budget alert (issue 934), not only when
   * a project has no manager to tell. Off by default.
   */
  readonly budgetAlertsIncludeAdmins: boolean
}

export const readNotificationSettings = async (
  database: InvoiceStateDatabase,
): Promise<NotificationSettings> => {
  const [row] = await database.all<{ includeAdmins: number }>(
    sql`SELECT budget_alerts_include_admins AS includeAdmins FROM organizations WHERE id = 1`,
  )
  return { budgetAlertsIncludeAdmins: row?.includeAdmins === 1 }
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
  return readNotificationSettings(database)
}
