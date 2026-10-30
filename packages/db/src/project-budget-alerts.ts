import {
  budgetThresholdCrossed,
  canViewMoneyField,
  composeBudgetAlert,
  dateInTimeZone,
  DEFAULT_OVER_BUDGET_PERCENT,
  type ActingUserAuthority,
  type BudgetAlertUnit,
} from '@ezacto/core'
import { sql } from 'drizzle-orm'
import { runAtomic, type InvoiceStateDatabase } from './invoice-state.js'
import {
  readStrandedNotifications,
  recordNotificationMail,
  type RecordedNotification,
} from './notification-mail.js'
import { createReportRepository } from './reports.js'

/**
 * Project budget alerts (issue 934).
 *
 * `projects.notify_when_over_budget` was stored, imported from Harvest, shown
 * on the project page, and never acted on. This is the part that acts.
 *
 * Evaluating is a pass over the projects that asked to be told, not a reaction
 * to each write. Time reaches the database from the week grid, the importer,
 * the API, the report mover and the MCP server, and a hook on each is one
 * forgotten path away from an alert that never comes. A pass reads the same
 * figures the budget report shows -- it calls the same function -- so an alert
 * cannot disagree with the report beside it, and it catches every write path
 * by construction. The Worker runs it every minute and the container on its
 * outbox tick.
 */

export const BUDGET_ALERT_EVENT = 'project.budget_alert'
export const BUDGET_ALERT_KIND = 'budget_alert'
export const BUDGET_ALERT_TEMPLATE = 'budget_alert:v1'

/**
 * A viewer for the budget report that sees every project. The report's
 * visibility rules decide what a *person* may read; the alert is a system
 * reading of the project, and who hears of it is decided separately, per
 * recipient, at delivery.
 */
const systemViewer = { userId: 1, profile: 'administrator' } as const

const usableZone = (zone: string | null): string => {
  if (zone === null) return 'UTC'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date(0))
    return zone
  } catch {
    return 'UTC'
  }
}

const monthRange = (month: string): { from: string; to: string } => {
  const year = Number(month.slice(0, 4))
  const index = Number(month.slice(5, 7))
  const last = new Date(Date.UTC(year, index, 0)).getUTCDate()
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` }
}

/** The whole of time, for a budget that is not monthly. */
const LIFETIME = { from: '1970-01-01', to: '9999-12-31' } as const

interface CandidateRow {
  id: number
  budgetBy: 'project' | 'project_cost' | 'task' | 'task_fees' | 'person' | 'none'
  budgetIsMonthly: number
  overBudgetPct: number | null
}

interface OpenAlertRow {
  id: number
  period: string
}

export interface BudgetAlertEvaluation {
  /** Alerts opened by this pass, as `{ alertId, projectId }`. */
  readonly opened: readonly { readonly alertId: number; readonly projectId: number }[]
  /** Open alerts closed because usage fell back, the period turned, or alerts were switched off. */
  readonly closed: number
}

/**
 * One pass. Idempotent: running it twice in a minute opens nothing the first
 * run did not, because the open alert is unique per project in the schema.
 */
export const evaluateProjectBudgetAlerts = async (
  database: InvoiceStateDatabase,
  now: string,
): Promise<BudgetAlertEvaluation> => {
  const [organization] = await database.all<{ timezone: string | null }>(
    sql`SELECT timezone FROM organizations WHERE id = 1`,
  )
  const zone = usableZone(organization?.timezone ?? null)
  const today = dateInTimeZone(now, zone)
  const month = today.slice(0, 7)
  const reports = createReportRepository(database)

  // An open alert on a project that no longer wants one is closed: the budget
  // was removed, the project archived, or the switch turned off. Leaving it
  // open would make the next time the project crosses its line a silent one.
  const abandoned = await database.all<{ id: number }>(
    sql`SELECT alert.id AS id FROM project_budget_alerts alert
        JOIN projects project ON project.id = alert.project_id
        WHERE alert.closed_at IS NULL AND NOT (
          project.is_active = 1 AND project.notify_when_over_budget = 1
          AND project.budget_by <> 'none'
        )`,
  )
  let closed = 0
  for (const alert of abandoned) closed += await closeAlert(database, alert.id, now)

  const candidates = await database.all<CandidateRow>(
    sql`SELECT id AS id, budget_by AS budgetBy, budget_is_monthly AS budgetIsMonthly,
               over_budget_pct AS overBudgetPct
        FROM projects
        WHERE is_active = 1 AND notify_when_over_budget = 1 AND budget_by <> 'none'
        ORDER BY id`,
  )
  const opened: { alertId: number; projectId: number }[] = []
  for (const project of candidates) {
    const monthly = project.budgetIsMonthly === 1
    const period = monthly ? month : 'lifetime'
    const report = await reports.projectBudget(
      project.id,
      monthly ? monthRange(month) : LIFETIME,
      systemViewer,
    )
    // The project total of a task or person budget is the sum of the grains
    // that carry one, as Harvest reads it: a task with no budget is not
    // spending against anything.
    const budgeted = (report?.grains ?? []).filter((grain) => grain.budgetAmount !== null)
    const budget = budgeted.reduce((sum, grain) => sum + (grain.budgetAmount ?? 0), 0)
    const spent = budgeted.reduce((sum, grain) => sum + grain.spentAmount, 0)
    const unit: BudgetAlertUnit = budgeted[0]?.unit ?? 'seconds'
    const threshold = project.overBudgetPct ?? DEFAULT_OVER_BUDGET_PERCENT
    const crossed = budgetThresholdCrossed(spent, budget, threshold)

    const [open] = await database.all<OpenAlertRow>(
      sql`SELECT id AS id, period AS period FROM project_budget_alerts
          WHERE project_id = ${project.id} AND closed_at IS NULL`,
    )
    // Under the line again, or into a new month: this crossing is over, and the
    // next one is a new alert.
    if (open !== undefined && (!crossed || open.period !== period)) {
      closed += await closeAlert(database, open.id, now)
    }
    if (!crossed) continue
    if (open !== undefined && open.period === period) continue

    const alertId = await openAlert(database, {
      projectId: project.id,
      period,
      unit,
      budget,
      spent,
      threshold,
      now,
      today,
    })
    if (alertId !== null) opened.push({ alertId, projectId: project.id })
  }
  return { opened, closed }
}

const closeAlert = async (
  database: InvoiceStateDatabase,
  alertId: number,
  now: string,
): Promise<number> => {
  const closedRows = await database.all<{ id: number }>(
    sql`UPDATE project_budget_alerts SET closed_at = ${now}
        WHERE id = ${alertId} AND closed_at IS NULL RETURNING id`,
  )
  return closedRows.length
}

/**
 * The alert, the activity-log event and Harvest's `over_budget_notified_on`, in
 * one batch. The event is what puts the crossing in the log and what the mail
 * subscriber is driven by, so a crossing cannot exist without its event or the
 * reverse. Returns the alert's id, or null when another evaluator opened one
 * first (the insert is guarded on there being no open alert).
 */
const openAlert = async (
  database: InvoiceStateDatabase,
  alert: Readonly<{
    projectId: number
    period: string
    unit: BudgetAlertUnit
    budget: number
    spent: number
    threshold: number
    now: string
    today: string
  }>,
): Promise<number | null> => {
  const eventId = crypto.randomUUID()
  const payload = JSON.stringify({
    schema_version: 1,
    event_id: eventId,
    event_type: BUDGET_ALERT_EVENT,
    occurred_at: alert.now,
    aggregate: { type: 'project', id: alert.projectId, sequence: 0 },
    actor: { type: 'system', id: null },
    project: {
      period: alert.period,
      unit: alert.unit,
      budget_amount: alert.budget,
      spent_amount: alert.spent,
      threshold_pct: alert.threshold,
    },
  })
  await runAtomic(database, [
    {
      text: `INSERT INTO project_budget_alerts (
          project_id, period, unit, budget_amount, spent_amount, threshold_pct, crossed_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM project_budget_alerts WHERE project_id = ? AND closed_at IS NULL
        )`,
      params: [
        alert.projectId,
        alert.period,
        alert.unit,
        alert.budget,
        alert.spent,
        alert.threshold,
        alert.now,
        alert.projectId,
      ],
    },
    {
      // `changes() = 1` is the insert above having written a row: when another
      // evaluator got there first it wrote none, and so does this.
      text: `INSERT INTO event_outbox (
          id, aggregate_type, aggregate_id, aggregate_sequence, event_type,
          payload_json, occurred_at, available_at
        )
        SELECT ?, 'project', ?, next.sequence, ?,
          json_set(json(?), '$.aggregate.sequence', next.sequence,
            '$.project.alert_id', last_insert_rowid()),
          ?, ?
        FROM (
          SELECT coalesce(max(aggregate_sequence), 0) + 1 AS sequence
          FROM event_outbox WHERE aggregate_type = 'project' AND aggregate_id = ?
        ) next
        WHERE changes() = 1`,
      params: [
        eventId,
        alert.projectId,
        BUDGET_ALERT_EVENT,
        payload,
        alert.now,
        alert.now,
        alert.projectId,
      ],
    },
    {
      text: `UPDATE projects SET over_budget_notified_on = ? WHERE id = ? AND changes() = 1`,
      params: [alert.today, alert.projectId],
    },
  ])
  const [row] = await database.all<{ id: number }>(
    sql`SELECT json_extract(payload_json, '$.project.alert_id') AS id FROM event_outbox
        WHERE id = ${eventId}`,
  )
  return row?.id ?? null
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

interface AlertContextRow {
  projectId: number
  projectName: string
  clientName: string
  currency: string
  budgetBy: CandidateRow['budgetBy']
  notify: number
  active: number
  period: string
  unit: BudgetAlertUnit
  budgetAmount: number
  spentAmount: number
  thresholdPct: number
  open: number
  companyName: string
  includeAdmins: number
}

interface RecipientRow {
  userId: number
  firstName: string
  lastName: string
  profile: ActingUserAuthority['profile']
  grants: string
  email: string | null
  manages: number
}

const basisOf = (budgetBy: CandidateRow['budgetBy']): 'hours' | 'cost' | 'fees' =>
  budgetBy === 'project_cost' ? 'cost' : budgetBy === 'task_fees' ? 'fees' : 'hours'

const managerProfiles = new Set(['project_manager', 'accounting', 'executive_manager', 'administrator'])

const parseGrants = (value: string): readonly string[] => {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

/**
 * Whom a crossing is told to, decided at delivery rather than at the crossing:
 * the people who manage the project now, not the people who did when the
 * threshold was crossed.
 *
 * Managers are the people with an active project-manager assignment whose
 * profile can read the project's budget. Administrators are added when the
 * company setting is on, and are the recipients anyway when a project has no
 * manager with an address, so an alert never goes to nobody.
 */
const resolveRecipients = async (
  database: InvoiceStateDatabase,
  projectId: number,
  includeAdmins: boolean,
): Promise<readonly RecipientRow[]> => {
  const people = await database.all<RecipientRow>(
    sql`SELECT person.id AS userId, person.first_name AS firstName, person.last_name AS lastName,
               person.profile AS profile, person.manager_grants AS grants,
               (SELECT email.address FROM user_emails email
                WHERE email.user_id = person.id AND email.is_primary = 1
                  AND email.verified_at IS NOT NULL AND email.invalidated_at IS NULL
                LIMIT 1) AS email,
               EXISTS (
                 SELECT 1 FROM user_assignments assignment
                 WHERE assignment.project_id = ${projectId} AND assignment.user_id = person.id
                   AND assignment.is_active = 1 AND assignment.is_project_manager = 1
               ) AS manages
        FROM users person
        WHERE person.is_active = 1
          AND (person.profile = 'administrator' OR EXISTS (
            SELECT 1 FROM user_assignments assignment
            WHERE assignment.project_id = ${projectId} AND assignment.user_id = person.id
              AND assignment.is_active = 1 AND assignment.is_project_manager = 1
          ))
        ORDER BY person.id`,
  )
  const reachable = people.filter((person) => person.email !== null)
  const managers = reachable.filter(
    (person) => person.manages === 1 && managerProfiles.has(person.profile),
  )
  const administrators = reachable.filter((person) => person.profile === 'administrator')
  if (includeAdmins || managers.length === 0) {
    return [...managers, ...administrators.filter((admin) => !managers.includes(admin))]
  }
  return managers
}

export interface BudgetAlertMailInput {
  readonly alertId: number
  /** The deployment sender the mail goes out from. */
  readonly from: { readonly email: string; readonly name?: string }
  readonly now: string
}

/**
 * Everything between "this project crossed its budget" and "queue these
 * messages": decides, finds the audience, renders per recipient and records.
 *
 * Returns the messages to queue, and an empty list for every ordinary reason
 * there is nothing to send, so the subscriber above it cannot disagree about
 * the precedence. In particular:
 *
 * - alerts switched off, or the project archived, between the crossing and
 *   now: nothing is sent;
 * - usage already back under the line, so the alert is closed: nothing is sent,
 *   because telling someone about a crossing that no longer holds is noise;
 * - a redelivery of the event re-queues what the log still says is queued and
 *   never composes or records a second message for anyone.
 *
 * Money in the body respects each recipient's profile: a project manager is
 * told "85% of its fee budget" without the figures they cannot see in the app.
 */
export const prepareBudgetAlertMail = async (
  database: InvoiceStateDatabase,
  input: Readonly<BudgetAlertMailInput>,
): Promise<readonly RecordedNotification[]> => {
  const [context] = await database.all<AlertContextRow>(
    sql`SELECT project.id AS projectId, project.name AS projectName,
               client.name AS clientName,
               upper(coalesce(project.billing_currency, client.currency)) AS currency,
               project.budget_by AS budgetBy,
               project.notify_when_over_budget AS notify, project.is_active AS active,
               alert.period AS period, alert.unit AS unit,
               alert.budget_amount AS budgetAmount, alert.spent_amount AS spentAmount,
               alert.threshold_pct AS thresholdPct,
               CASE WHEN alert.closed_at IS NULL THEN 1 ELSE 0 END AS open,
               organization.name AS companyName,
               organization.budget_alerts_include_admins AS includeAdmins
        FROM project_budget_alerts alert
        JOIN projects project ON project.id = alert.project_id
        JOIN clients client ON client.id = project.client_id
        JOIN organizations organization ON organization.id = 1
        WHERE alert.id = ${input.alertId}`,
  )
  if (context === undefined || context.notify !== 1 || context.active !== 1 || context.open !== 1) {
    return []
  }
  const recipients = await resolveRecipients(database, context.projectId, context.includeAdmins === 1)
  for (const person of recipients) {
    const authority: ActingUserAuthority = {
      profile: person.profile,
      managerGrants: parseGrants(person.grants),
      userId: person.userId,
    }
    const basis = basisOf(context.budgetBy)
    const amountsVisible =
      context.unit === 'seconds' ||
      (canViewMoneyField(authority, 'money_budget') &&
        (basis !== 'cost' || canViewMoneyField(authority, 'cost_rate')))
    const message = composeBudgetAlert({
      companyName: context.companyName,
      projectName: context.projectName,
      clientName: context.clientName,
      unit: context.unit,
      budgetAmount: context.budgetAmount,
      spentAmount: context.spentAmount,
      thresholdPercent: context.thresholdPct,
      period: context.period,
      currency: context.currency,
      amountsVisible,
      basis,
    })
    await recordNotificationMail(database, {
      kind: BUDGET_ALERT_KIND,
      userId: person.userId,
      scope: String(context.projectId),
      period: String(input.alertId),
      from: input.from,
      to: { email: person.email!, name: `${person.firstName} ${person.lastName}`.trim() },
      template: BUDGET_ALERT_TEMPLATE,
      subject: message.subject,
      text: message.text,
      related: { type: 'project', id: context.projectId },
      now: input.now,
    })
  }
  return readStrandedNotifications(database, {
    kind: BUDGET_ALERT_KIND,
    scope: String(context.projectId),
    period: String(input.alertId),
    olderThan: input.now,
  })
}
