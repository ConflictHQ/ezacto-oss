import {
  composeAutoApprovalWarning,
  composeAutoApprovalNotice,
  composeAutoApprovalReviewWarning,
  composeDailyTimeReminder,
  composeSubmissionDigest,
  composeSubmissionReminder,
  effectiveTimeZone,
  localMoment,
  reminderTiming,
  submissionReminderWeek,
  trackedLessThanUsual,
  usualDaySeconds,
  type LocalMoment,
  type ReminderLinks,
  type ReminderWeek,
} from '@ezacto/core'
import { sql } from 'drizzle-orm'
import type { InvoiceStateDatabase } from './invoice-state.js'
import {
  notificationDecided,
  readStrandedNotifications,
  recordNotificationMail,
  recordNotificationSkip,
  type NotificationKey,
  type RecordedNotification,
} from './notification-mail.js'

/**
 * Time reminders and timesheet-submission reminders (issue 935).
 *
 * `notification_preferences` stored a daily-reminder time, days and channels, a
 * team-reminder opt-in and a weekly digest, and the product said delivery was
 * inactive. This is the delivery.
 *
 * One pass looks at every person who could be due something and decides, in
 * *their* local time, whether it is time. Every decision is written to the
 * `notification_deliveries` ledger keyed by (kind, person, scope, period) --
 * the local date for the daily reminder, the week start for the weekly ones --
 * so a pass that runs every minute, twice at once, or after a crash decides each
 * occurrence exactly once. A message is recorded with its `email_log` row before
 * it is queued, and a queue failure is re-queued from the record on a later pass
 * rather than composed again.
 *
 * Nothing here talks to a mail provider. It returns the messages to queue.
 */

export const DAILY_REMINDER_KIND = 'daily_time_reminder'
export const SUBMISSION_REMINDER_KIND = 'submission_reminder'
export const SUBMISSION_DIGEST_KIND = 'submission_digest'
export const AUTO_APPROVAL_WARNING_KIND = 'auto_approval_warning'
export const AUTO_APPROVAL_REVIEW_WARNING_KIND = 'auto_approval_review_warning'
export const AUTO_APPROVAL_NOTICE_KIND = 'auto_approval_notice'
export const REMINDER_TEMPLATES = {
  [DAILY_REMINDER_KIND]: 'time_reminder:v1',
  [SUBMISSION_REMINDER_KIND]: 'submission_reminder:v1',
  [SUBMISSION_DIGEST_KIND]: 'submission_digest:v1',
  [AUTO_APPROVAL_WARNING_KIND]: 'auto_approval_warning:v1',
  [AUTO_APPROVAL_REVIEW_WARNING_KIND]: 'auto_approval_review_warning:v1',
  [AUTO_APPROVAL_NOTICE_KIND]: 'auto_approval_notice:v1',
} as const

const reminderKinds = [
  DAILY_REMINDER_KIND,
  SUBMISSION_REMINDER_KIND,
  SUBMISSION_DIGEST_KIND,
  AUTO_APPROVAL_WARNING_KIND,
  AUTO_APPROVAL_REVIEW_WARNING_KIND,
  AUTO_APPROVAL_NOTICE_KIND,
] as const

/** How long before the deadline the submitter is told; half the window when that is shorter. */
const AUTO_APPROVAL_WARNING_HOURS = 24

/**
 * A message the queue has not picked up for this long is queued again, on the
 * ten-minute marks so a provider that is down is not handed the same message
 * every minute, and only while it is still worth sending.
 */
const STRANDED_AFTER_MINUTES = 5
const STRANDED_UNTIL_HOURS = 6

export interface TimeReminderInput {
  readonly now: string
  /** The deployment sender the mail goes out from. */
  readonly from: { readonly email: string; readonly name?: string }
  /** The instance's own address, for the links in the mail. */
  readonly appUrl: string
}

interface OrganizationRow {
  name: string
  timezone: string
  weekStartDay: 'saturday' | 'sunday' | 'monday'
  approval: number | null
  autoApprovalEnabled: number
  autoApprovalDays: number | null
  autoApprovalFrom: string | null
  autoApprovalAuthority: number
  scheduleDay: string | null
  scheduleTime: string | null
}

interface PersonRow {
  userId: number
  firstName: string
  lastName: string
  timezone: string
  weeklyCapacity: number
  profile: string
  email: string | null
  reminderTime: string | null
  reminderDays: string
}

const people = async (
  database: InvoiceStateDatabase,
  condition: 'daily' | 'team' | 'digest',
): Promise<PersonRow[]> =>
  await database.all<PersonRow>(
    sql`SELECT person.id AS userId, person.first_name AS firstName, person.last_name AS lastName,
               person.timezone AS timezone, person.weekly_capacity AS weeklyCapacity,
               person.profile AS profile,
               preference.reminder_time AS reminderTime, preference.reminder_days AS reminderDays,
               (SELECT email.address FROM user_emails email
                WHERE email.user_id = person.id AND email.is_primary = 1
                  AND email.verified_at IS NOT NULL AND email.invalidated_at IS NULL
                LIMIT 1) AS email
        FROM users person
        JOIN notification_preferences preference ON preference.user_id = person.id
        WHERE person.is_active = 1 AND (
          (${condition} = 'daily' AND preference.daily_reminder_enabled = 1
            AND preference.email_enabled = 1 AND preference.reminder_time IS NOT NULL)
          OR (${condition} = 'team' AND preference.include_in_team_reminders = 1)
          OR (${condition} = 'digest' AND preference.weekly_digest = 1
            AND person.profile IN ('project_manager', 'executive_manager', 'administrator'))
        )
        ORDER BY person.id`,
  )

const minutesOf = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))

/**
 * What somebody has tracked on a local date, with a timer that is running now
 * counting as it runs. The stored seconds of a running entry stand still until
 * it stops, so without this a person mid-session would be reminded to start.
 */
const trackedSecondsOn = async (
  database: InvoiceStateDatabase,
  userId: number,
  local: LocalMoment,
  now: string,
): Promise<number> => {
  const [stored] = await database.all<{ seconds: number }>(
    sql`SELECT coalesce(sum(seconds), 0) AS seconds FROM time_entries
        WHERE user_id = ${userId} AND spent_date = ${local.date}`,
  )
  const running = await database.all<{ timerStartedAt: string | null; startedTime: string | null }>(
    sql`SELECT timer_started_at AS timerStartedAt, started_time AS startedTime FROM time_entries
        WHERE user_id = ${userId} AND spent_date = ${local.date}
          AND (timer_started_at IS NOT NULL OR (started_time IS NOT NULL AND ended_time IS NULL))`,
  )
  let elapsed = 0
  for (const entry of running) {
    if (entry.timerStartedAt !== null) {
      elapsed += Math.max(0, Math.floor((Date.parse(now) - Date.parse(entry.timerStartedAt)) / 1000))
    } else if (entry.startedTime !== null) {
      elapsed += Math.max(0, minutesOf(local.time) - minutesOf(entry.startedTime)) * 60
    }
  }
  return (stored?.seconds ?? 0) + elapsed
}

const hasUnsubmitted = async (
  database: InvoiceStateDatabase,
  userId: number,
  week: ReminderWeek,
): Promise<boolean> => {
  const rows = await database.all<{ present: number }>(
    sql`SELECT 1 AS present FROM time_entries
        WHERE user_id = ${userId} AND spent_date BETWEEN ${week.start} AND ${week.end}
          AND approval_status = 'unsubmitted'
        UNION ALL
        SELECT 1 AS present FROM expenses
        WHERE user_id = ${userId} AND spent_date BETWEEN ${week.start} AND ${week.end}
          AND approval_status = 'unsubmitted'
        LIMIT 1`,
  )
  return rows.length > 0
}

/** The people this approver would review, who have unsubmitted work in the week. */
const unsubmittedAmong = async (
  database: InvoiceStateDatabase,
  approver: Readonly<PersonRow>,
  week: ReminderWeek,
): Promise<string[]> => {
  const rows = await database.all<{ firstName: string; lastName: string }>(
    sql`SELECT person.first_name AS firstName, person.last_name AS lastName
        FROM users person
        WHERE person.is_active = 1 AND person.id <> ${approver.userId}
          AND (${approver.profile} IN ('administrator', 'executive_manager') OR EXISTS (
            SELECT 1 FROM teammate_assignments assignment
            WHERE assignment.manager_id = ${approver.userId} AND assignment.user_id = person.id
          ))
          AND (EXISTS (
            SELECT 1 FROM time_entries entry
            WHERE entry.user_id = person.id AND entry.spent_date BETWEEN ${week.start} AND ${week.end}
              AND entry.approval_status = 'unsubmitted'
          ) OR EXISTS (
            SELECT 1 FROM expenses expense
            WHERE expense.user_id = person.id AND expense.spent_date BETWEEN ${week.start} AND ${week.end}
              AND expense.approval_status = 'unsubmitted'
          ))
        ORDER BY person.first_name, person.last_name, person.id`,
  )
  return rows.map((row) => `${row.firstName} ${row.lastName}`.trim())
}

/**
 * One pass. Records every decision it makes and returns the messages to put on
 * the queue: the ones just recorded, and any recorded earlier that the log says
 * never left the queue.
 */
export const prepareTimeReminders = async (
  database: InvoiceStateDatabase,
  input: Readonly<TimeReminderInput>,
): Promise<readonly RecordedNotification[]> => {
  const [organization] = await database.all<OrganizationRow>(
    sql`SELECT name AS name, timezone AS timezone, week_start_day AS weekStartDay,
               json_extract(modules, '$.approval') AS approval,
               auto_approval_enabled AS autoApprovalEnabled,
               auto_approval_window_days AS autoApprovalDays,
               auto_approval_effective_from AS autoApprovalFrom,
               EXISTS(SELECT 1 FROM users authority WHERE authority.id=organizations.auto_approval_actor_user_id AND authority.is_active=1 AND authority.profile IN('administrator','executive_manager')) AS autoApprovalAuthority,
               submission_reminder_day AS scheduleDay, submission_reminder_time AS scheduleTime
        FROM organizations WHERE id = 1`,
  )
  if (organization === undefined) return []
  const links: ReminderLinks = {
    timesheet: `${input.appUrl.replace(/\/+$/u, '')}/`,
    preferences: `${input.appUrl.replace(/\/+$/u, '')}/settings/user`,
  }
  const recorded: RecordedNotification[] = []

  const record = async (
    key: NotificationKey,
    person: Readonly<PersonRow>,
    message: { subject: string; text: string },
  ): Promise<void> => {
    const outcome = await recordNotificationMail(database, {
      ...key,
      from: input.from,
      to: { email: person.email!, name: `${person.firstName} ${person.lastName}`.trim() },
      template: REMINDER_TEMPLATES[key.kind as keyof typeof REMINDER_TEMPLATES],
      subject: message.subject,
      text: message.text,
      now: input.now,
    })
    if (outcome.outcome === 'recorded') recorded.push(outcome.notification)
  }

  // Daily time reminder: on the person's chosen days, at their chosen local
  // time, only if they have tracked less than a usual day by then.
  for (const person of await people(database, 'daily')) {
    if (person.email === null || person.reminderTime === null) continue
    const local = localMoment(input.now, effectiveTimeZone(person.timezone, organization.timezone))
    const days = JSON.parse(person.reminderDays) as string[]
    if (!days.includes(local.weekday)) continue
    const timing = reminderTiming(local, person.reminderTime)
    if (timing === 'not_yet') continue
    const key = { kind: DAILY_REMINDER_KIND, userId: person.userId, scope: '', period: local.date }
    if (await notificationDecided(database, key)) continue
    if (timing === 'late') {
      await recordNotificationSkip(database, key, 'late', input.now)
      continue
    }
    const tracked = await trackedSecondsOn(database, person.userId, local, input.now)
    const usual = usualDaySeconds(person.weeklyCapacity, days.length)
    if (!trackedLessThanUsual(tracked, usual)) {
      await recordNotificationSkip(database, key, 'enough_tracked', input.now)
      continue
    }
    await record(
      key,
      person,
      composeDailyTimeReminder({
        companyName: organization.name,
        firstName: person.firstName,
        date: local.date,
        trackedSeconds: tracked,
        usualSeconds: usual,
        links,
      }),
    )
  }

  // The week-end reminders need the Approval module (there is nothing to
  // submit without it) and a schedule an administrator has set.
  if (organization.approval === 1 && organization.scheduleDay !== null && organization.scheduleTime !== null) {
    const scheduleDay = organization.scheduleDay
    const scheduleTime = organization.scheduleTime
    const schedule = async (
      person: Readonly<PersonRow>,
      kind: typeof SUBMISSION_REMINDER_KIND | typeof SUBMISSION_DIGEST_KIND,
    ): Promise<{ key: NotificationKey; week: ReminderWeek } | null> => {
      const local = localMoment(input.now, effectiveTimeZone(person.timezone, organization.timezone))
      if (local.weekday !== scheduleDay) return null
      const timing = reminderTiming(local, scheduleTime)
      if (timing === 'not_yet') return null
      const week = submissionReminderWeek(local, organization.weekStartDay)
      const key = { kind, userId: person.userId, scope: '', period: week.start }
      if (await notificationDecided(database, key)) return null
      if (timing === 'late') {
        await recordNotificationSkip(database, key, 'late', input.now)
        return null
      }
      return { key, week }
    }

    for (const person of await people(database, 'team')) {
      if (person.email === null) continue
      const due = await schedule(person, SUBMISSION_REMINDER_KIND)
      if (due === null) continue
      if (!(await hasUnsubmitted(database, person.userId, due.week))) {
        await recordNotificationSkip(database, due.key, 'nothing_to_submit', input.now)
        continue
      }
      await record(
        due.key,
        person,
        composeSubmissionReminder({
          companyName: organization.name,
          firstName: person.firstName,
          week: due.week,
          links,
        }),
      )
    }

    for (const manager of await people(database, 'digest')) {
      if (manager.email === null) continue
      const due = await schedule(manager, SUBMISSION_DIGEST_KIND)
      if (due === null) continue
      const names = await unsubmittedAmong(database, manager, due.week)
      if (names.length === 0) {
        await recordNotificationSkip(database, due.key, 'everyone_submitted', input.now)
        continue
      }
      await record(
        due.key,
        manager,
        composeSubmissionDigest({
          companyName: organization.name,
          firstName: manager.firstName,
          week: due.week,
          people: names,
          links,
        }),
      )
    }
  }

  // Warn the submitter that the sweep (issue 1009) will approve their week soon.
  // Only while the policy and the Approval module are on, only for weeks the
  // sweep would take, and once per submission: the key carries the submission
  // and its `submitted_at`, so a resubmission starts a new clock and a new notice.
  if (
    organization.approval === 1 &&
    organization.autoApprovalEnabled === 1 &&
    organization.autoApprovalAuthority === 1 &&
    organization.autoApprovalDays !== null &&
    organization.autoApprovalFrom !== null
  ) {
    const windowMs = organization.autoApprovalDays * 86_400_000
    const leadMs = Math.min(AUTO_APPROVAL_WARNING_HOURS * 3_600_000, windowMs / 2)
    const nowMs = Date.parse(input.now)
    const upcoming = await database.all<
      PersonRow & {
        submissionId: number
        submittedAt: string
        periodStart: string
        periodEnd: string
      }
    >(
      sql`SELECT person.id AS userId, person.first_name AS firstName, person.last_name AS lastName,
                   person.timezone AS timezone, person.weekly_capacity AS weeklyCapacity,
                   person.profile AS profile, NULL AS reminderTime, '[]' AS reminderDays,
                   submission.id AS submissionId, submission.submitted_at AS submittedAt,
                   submission.period_start AS periodStart, submission.period_end AS periodEnd,
                   (SELECT email.address FROM user_emails email
                    WHERE email.user_id = person.id AND email.is_primary = 1
                      AND email.verified_at IS NOT NULL AND email.invalidated_at IS NULL
                    LIMIT 1) AS email
            FROM timesheet_submissions submission
            JOIN users person ON person.id = submission.user_id
            WHERE submission.status = 'submitted' AND submission.origin = 'native'
              AND submission.submitted_at >= ${organization.autoApprovalFrom}
              AND submission.submitted_at > ${new Date(nowMs - windowMs).toISOString()}
              AND submission.submitted_at <= ${new Date(nowMs - windowMs + leadMs).toISOString()}
              AND person.is_active = 1
            ORDER BY submission.submitted_at, submission.id`,
    )
    for (const week of upcoming) {
      const key = {
        kind: AUTO_APPROVAL_WARNING_KIND,
        userId: week.userId,
        scope: String(week.submissionId),
        period: week.submittedAt,
      }
      const zone = effectiveTimeZone(week.timezone, organization.timezone)
      const deadline = localMoment(
        new Date(Date.parse(week.submittedAt) + windowMs).toISOString(),
        zone,
      )
      if (week.email !== null)
        await record(
          key,
          week,
          composeAutoApprovalWarning({
            companyName: organization.name,
            firstName: week.firstName,
            week: { start: week.periodStart, end: week.periodEnd },
            deadline: { date: deadline.date, time: deadline.time, zone },
            links,
          }),
        )
      const reviewers =
        await database.all<PersonRow>(sql`SELECT person.id AS userId,person.first_name AS firstName,person.last_name AS lastName,person.timezone AS timezone,person.weekly_capacity AS weeklyCapacity,person.profile AS profile,NULL AS reminderTime,'[]' AS reminderDays,
          (SELECT email.address FROM user_emails email WHERE email.user_id=person.id AND email.is_primary=1 AND email.verified_at IS NOT NULL AND email.invalidated_at IS NULL LIMIT 1) AS email
          FROM users person JOIN notification_preferences preference ON preference.user_id=person.id
          WHERE person.is_active=1 AND person.id<>${week.userId} AND preference.email_enabled=1
            AND (person.profile IN('administrator','executive_manager') OR (person.profile='project_manager' AND EXISTS(SELECT 1 FROM teammate_assignments assignment WHERE assignment.manager_id=person.id AND assignment.user_id=${week.userId}))) ORDER BY person.id`)
      for (const reviewer of reviewers) {
        if (!reviewer.email) continue
        const localDeadline = localMoment(
          new Date(Date.parse(week.submittedAt) + windowMs).toISOString(),
          effectiveTimeZone(reviewer.timezone, organization.timezone),
        )
        await record(
          {
            kind: AUTO_APPROVAL_REVIEW_WARNING_KIND,
            userId: reviewer.userId,
            scope: String(week.submissionId),
            period: new Date(Date.parse(week.submittedAt) + windowMs).toISOString(),
          },
          reviewer,
          composeAutoApprovalReviewWarning({
            companyName: organization.name,
            firstName: reviewer.firstName,
            personName: `${week.firstName} ${week.lastName}`.trim(),
            week: { start: week.periodStart, end: week.periodEnd },
            deadline: {
              date: localDeadline.date,
              time: localDeadline.time,
              zone: effectiveTimeZone(reviewer.timezone, organization.timezone),
            },
            reviewUrl: `${input.appUrl.replace(/\/+$/u, '')}/approvals`,
            links,
          }),
        )
      }
    }
  }

  // A receipt survives policy changes and a crash after approval. Record each
  // outcome once using the same notification ledger/queue recovery as reminders.
  const outcomes = await database.all<
    PersonRow & {
      submissionId: number
      commandId: string
      periodStart: string
      periodEnd: string
      approvedAt: string
      windowDays: number
    }
  >(sql`
      SELECT person.id AS userId,person.first_name AS firstName,person.last_name AS lastName,person.timezone AS timezone,person.weekly_capacity AS weeklyCapacity,person.profile AS profile,NULL AS reminderTime,'[]' AS reminderDays,
        receipt.submission_id AS submissionId,receipt.command_id AS commandId,submission.period_start AS periodStart,submission.period_end AS periodEnd,receipt.approved_at AS approvedAt,receipt.window_days AS windowDays,
        (SELECT email.address FROM user_emails email WHERE email.user_id=person.id AND email.is_primary=1 AND email.verified_at IS NOT NULL AND email.invalidated_at IS NULL LIMIT 1) AS email
      FROM timesheet_automatic_approval_receipts receipt JOIN timesheet_submissions submission ON submission.id=receipt.submission_id JOIN users person ON person.id=submission.user_id
      WHERE person.is_active=1 AND EXISTS(SELECT 1 FROM user_emails verified WHERE verified.user_id=person.id AND verified.is_primary=1 AND verified.verified_at IS NOT NULL AND verified.invalidated_at IS NULL) AND receipt.approved_at<=${input.now} AND NOT EXISTS(SELECT 1 FROM notification_deliveries delivered WHERE delivered.kind=${AUTO_APPROVAL_NOTICE_KIND} AND delivered.user_id=person.id AND delivered.scope=CAST(receipt.submission_id AS TEXT) AND delivered.period=receipt.command_id)
      ORDER BY receipt.approved_at,receipt.submission_id LIMIT 250`)
  for (const outcome of outcomes) {
    if (!outcome.email) continue
    const zone = effectiveTimeZone(outcome.timezone, organization.timezone)
    const approved = localMoment(outcome.approvedAt, zone)
    await record(
      {
        kind: AUTO_APPROVAL_NOTICE_KIND,
        userId: outcome.userId,
        scope: String(outcome.submissionId),
        period: outcome.commandId,
      },
      outcome,
      composeAutoApprovalNotice({
        companyName: organization.name,
        firstName: outcome.firstName,
        week: { start: outcome.periodStart, end: outcome.periodEnd },
        windowDays: outcome.windowDays,
        approved: { date: approved.date, time: approved.time, zone },
        links,
      }),
    )
  }

  // Recorded on an earlier pass and never picked up by the queue: queued again
  // from the record, exactly as it was decided.
  if (Math.floor(Date.parse(input.now) / 60_000) % 10 === 0) {
    const olderThan = new Date(Date.parse(input.now) - STRANDED_AFTER_MINUTES * 60_000).toISOString()
    const newerThan = new Date(Date.parse(input.now) - STRANDED_UNTIL_HOURS * 3_600_000).toISOString()
    for (const kind of reminderKinds) {
      recorded.push(...(await readStrandedNotifications(database, { kind, olderThan, newerThan })))
    }
  }
  return recorded
}
