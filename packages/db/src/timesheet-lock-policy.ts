import type BetterSqlite3 from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import {
  createTimesheetApprovalRepository,
  type TimesheetSubmissionRecord,
} from './timesheet-approvals.js'
import type { PolicySubject, TrackedPolicyResolver } from './tracked-resource-repository.js'

type LockDatabase = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>
type NativeClient = BetterSqlite3.Database | D1Database

export type TimesheetLockKind = 'manual_cutoff' | 'weekly_deadline'
export type TimesheetDeadlineDay =
  | 'sunday'
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday'

export interface TimesheetLockPolicyActor {
  userId: number
  profile:
    | 'member'
    | 'project_manager'
    | 'people_admin'
    | 'accounting'
    | 'executive_manager'
    | 'administrator'
}

export interface TimesheetDeadline {
  day: TimesheetDeadlineDay
  time: string
}

export interface TimesheetLockPolicySettings {
  autoLock: boolean
  timesheetDeadline: TimesheetDeadline | null
  weekStartDay: 'saturday' | 'sunday' | 'monday'
  timezone: string
  updatedAt: string
}

export interface UpdateTimesheetLockPolicySettings {
  autoLock?: boolean
  timesheetDeadline?: TimesheetDeadline | null
  timezone?: string
}

export interface TimesheetLockWindowRecord {
  id: number
  kind: TimesheetLockKind
  periodStart: string | null
  periodEnd: string
  lockedByUserId: number | null
  lockedAt: string
  lockReason: string
  weekStartDay: 'saturday' | 'sunday' | 'monday' | null
  deadlineDay: TimesheetDeadlineDay | null
  deadlineTime: string | null
  timezone: string | null
  unlockedByUserId: number | null
  unlockedAt: string | null
  unlockReason: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export interface TimesheetLockWindowFilters {
  active?: boolean
  kind?: TimesheetLockKind
}

export interface TimesheetLockListWindow {
  afterId: number | null
  throughId: number
  take: number
}

export interface TimesheetLockWindowSource {
  highWatermark(): Promise<number | null>
  list(window: TimesheetLockListWindow): Promise<readonly TimesheetLockWindowRecord[]>
}

export interface TimesheetPolicyLockResolution {
  locked: boolean
  cause: TimesheetLockKind | null
  reason: string | null
  lock: TimesheetLockWindowRecord | null
}

export type TimesheetLockPolicyErrorCode =
  | 'forbidden'
  | 'invalid_settings'
  | 'not_found'
  | 'state_conflict'
  | 'running_entry'
  | 'command_id_reused'

export class TimesheetLockPolicyError extends Error {
  constructor(
    readonly code: TimesheetLockPolicyErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'TimesheetLockPolicyError'
  }
}

interface RawSettingsRow {
  auto_lock: number
  timesheet_deadline: string | null
  week_start_day: 'saturday' | 'sunday' | 'monday'
  timezone: string
  updated_at: string
}

interface RawLockRow {
  id: number
  kind: TimesheetLockKind
  period_start: string | null
  period_end: string
  locked_by_user_id: number | null
  locked_at: string
  lock_reason: string
  command_id: string | null
  input_fingerprint: string | null
  week_start_day: 'saturday' | 'sunday' | 'monday' | null
  deadline_day: TimesheetDeadlineDay | null
  deadline_time: string | null
  timezone: string | null
  unlocked_by_user_id: number | null
  unlocked_at: string | null
  unlock_reason: string | null
  version: number
  created_at: string
  updated_at: string
}

const deadlineDays = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const

const datePattern = /^\d{4}-\d{2}-\d{2}$/
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/

const nativeClient = (database: LockDatabase): NativeClient =>
  (database as LockDatabase & { $client: NativeClient }).$client

const isD1Client = (client: NativeClient): client is D1Database => 'batch' in client

const first = async <Row>(
  client: NativeClient,
  sql: string,
  params: readonly unknown[] = [],
): Promise<Row | null> => {
  if (isD1Client(client)) return client.prepare(sql).bind(...params).first<Row>()
  return (client.prepare(sql).get(...params) as Row | undefined) ?? null
}

const all = async <Row>(
  client: NativeClient,
  sql: string,
  params: readonly unknown[] = [],
): Promise<Row[]> => {
  if (isD1Client(client)) return (await client.prepare(sql).bind(...params).all<Row>()).results
  return client.prepare(sql).all(...params) as Row[]
}

const runReturning = async <Row>(
  client: NativeClient,
  sql: string,
  params: readonly unknown[],
): Promise<Row | null> => {
  if (isD1Client(client)) return client.prepare(sql).bind(...params).first<Row>()
  return (client.prepare(sql).get(...params) as Row | undefined) ?? null
}

const lockRecord = (row: RawLockRow): TimesheetLockWindowRecord => ({
  id: row.id,
  kind: row.kind,
  periodStart: row.period_start,
  periodEnd: row.period_end,
  lockedByUserId: row.locked_by_user_id,
  lockedAt: row.locked_at,
  lockReason: row.lock_reason,
  weekStartDay: row.week_start_day,
  deadlineDay: row.deadline_day,
  deadlineTime: row.deadline_time,
  timezone: row.timezone,
  unlockedByUserId: row.unlocked_by_user_id,
  unlockedAt: row.unlocked_at,
  unlockReason: row.unlock_reason,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const parseDeadline = (value: string | null): TimesheetDeadline | null => {
  if (value === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new TimesheetLockPolicyError('invalid_settings', 'The stored timesheet deadline is invalid.')
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('day' in parsed) ||
    !('time' in parsed) ||
    typeof parsed.day !== 'string' ||
    !deadlineDays.includes(parsed.day as TimesheetDeadlineDay) ||
    typeof parsed.time !== 'string' ||
    !timePattern.test(parsed.time)
  ) {
    throw new TimesheetLockPolicyError('invalid_settings', 'The stored timesheet deadline is invalid.')
  }
  return { day: parsed.day as TimesheetDeadlineDay, time: parsed.time }
}

const settingsRecord = (row: RawSettingsRow): TimesheetLockPolicySettings => ({
  autoLock: row.auto_lock === 1,
  timesheetDeadline: parseDeadline(row.timesheet_deadline),
  weekStartDay: row.week_start_day,
  timezone: row.timezone,
  updatedAt: row.updated_at,
})

const assertPrivileged = (actor: Readonly<TimesheetLockPolicyActor>): void => {
  if (actor.profile !== 'administrator' && actor.profile !== 'executive_manager') {
    throw new TimesheetLockPolicyError(
      'forbidden',
      'The acting user cannot change organization timesheet lock policy.',
    )
  }
}

const assertReason = (reason: string): string => {
  const normalized = reason.trim()
  const characterCount = Array.from(normalized).length
  if (characterCount < 1 || characterCount > 10_000) {
    throw new TimesheetLockPolicyError(
      'invalid_settings',
      'A lock or unlock reason must contain between 1 and 10000 characters.',
    )
  }
  return normalized
}

const assertDate = (value: string, field: string): void => {
  if (!datePattern.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new TimesheetLockPolicyError('invalid_settings', `${field} must be a calendar date.`)
  }
}

const validateDeadline = (deadline: TimesheetDeadline | null): void => {
  if (
    deadline !== null &&
    (!deadlineDays.includes(deadline.day) || !timePattern.test(deadline.time))
  ) {
    throw new TimesheetLockPolicyError(
      'invalid_settings',
      'The deadline must name a weekday and a 24-hour HH:mm time.',
    )
  }
}

const validateTimezone = (timezone: string): void => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0))
  } catch {
    throw new TimesheetLockPolicyError('invalid_settings', 'The organization timezone is invalid.')
  }
}

const dateParts = (date: string): { year: number; month: number; day: number } => {
  assertDate(date, 'date')
  const [year, month, day] = date.split('-').map(Number)
  return { year: year!, month: month!, day: day! }
}

const addDays = (date: string, days: number): string => {
  const part = dateParts(date)
  const value = new Date(Date.UTC(part.year, part.month - 1, part.day + days))
  return value.toISOString().slice(0, 10)
}

const weekday = (date: string): number => {
  const part = dateParts(date)
  return new Date(Date.UTC(part.year, part.month - 1, part.day)).getUTCDay()
}

const weekStart = (
  date: string,
  start: TimesheetLockPolicySettings['weekStartDay'],
): string => {
  const startIndex = deadlineDays.indexOf(start)
  return addDays(date, -((weekday(date) - startIndex + 7) % 7))
}

const localDateTime = (instant: string, timezone: string): string => {
  const value = new Date(instant)
  if (Number.isNaN(value.getTime())) {
    throw new TimesheetLockPolicyError('invalid_settings', 'occurredAt must be an instant.')
  }
  validateTimezone(timezone)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value)
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`
}

const deadlineDateTime = (periodEnd: string, deadline: TimesheetDeadline): string => {
  const deadlineIndex = deadlineDays.indexOf(deadline.day)
  const endIndex = weekday(periodEnd)
  const delta = ((deadlineIndex - endIndex + 7) % 7) || 7
  return `${addDays(periodEnd, delta)}T${deadline.time}`
}

const translateWriteError = (error: unknown): never => {
  const message = error instanceof Error ? error.message.toLocaleLowerCase('en-US') : ''
  if (message.includes('running time entries')) {
    throw new TimesheetLockPolicyError(
      'running_entry',
      'Running time entries must be stopped before the period can be locked.',
    )
  }
  if (message.includes('administrator')) {
    throw new TimesheetLockPolicyError('forbidden', 'The acting user is not a policy administrator.')
  }
  if (message.includes('only be unlocked once')) {
    throw new TimesheetLockPolicyError('state_conflict', 'The timesheet lock is already unlocked.')
  }
  throw error
}

export interface TimesheetLockPolicyRepository extends TrackedPolicyResolver {
  assertApprovalEnabled(): Promise<void>
  settings(): Promise<TimesheetLockPolicySettings>
  updateSettings(
    actor: Readonly<TimesheetLockPolicyActor>,
    input: Readonly<UpdateTimesheetLockPolicySettings>,
    occurredAt: string,
  ): Promise<TimesheetLockPolicySettings>
  lockWindow(lockId: number): Promise<TimesheetLockWindowRecord>
  lockWindows(filters?: Readonly<TimesheetLockWindowFilters>): TimesheetLockWindowSource
  createManualLock(
    actor: Readonly<TimesheetLockPolicyActor>,
    lockedThrough: string,
    reason: string,
    occurredAt: string,
    commandId: string,
    inputFingerprint: string,
  ): Promise<TimesheetLockWindowRecord>
  materializeAutoLocks(occurredAt: string): Promise<readonly TimesheetLockWindowRecord[]>
  unlock(
    actor: Readonly<TimesheetLockPolicyActor>,
    lockId: number,
    reason: string,
    occurredAt: string,
  ): Promise<TimesheetLockWindowRecord>
  withdrawTimesheet(
    actor: Readonly<TimesheetLockPolicyActor>,
    submissionId: number,
    reason: string,
    occurredAt: string,
  ): Promise<TimesheetSubmissionRecord>
  /** A person taking back their own week before anyone has reviewed it. */
  unsubmitTimesheet(
    actor: Readonly<TimesheetLockPolicyActor>,
    submissionId: number,
    occurredAt: string,
  ): Promise<TimesheetSubmissionRecord>
  resolve(subject: Readonly<PolicySubject>): Promise<TimesheetPolicyLockResolution>
  lockedDates(spentDates: readonly string[]): Promise<ReadonlyMap<string, boolean>>
}

export class DrizzleTimesheetLockPolicyRepository implements TimesheetLockPolicyRepository {
  readonly #client: NativeClient
  readonly #approvals: ReturnType<typeof createTimesheetApprovalRepository>
  readonly #clock: () => string

  constructor(database: LockDatabase, options: { clock?: () => string } = {}) {
    this.#client = nativeClient(database)
    this.#approvals = createTimesheetApprovalRepository(database)
    this.#clock = options.clock ?? (() => new Date().toISOString())
  }

  async assertApprovalEnabled(): Promise<void> {
    await this.#approvals.assertEnabled()
  }

  async settings(): Promise<TimesheetLockPolicySettings> {
    const row = await first<RawSettingsRow>(
      this.#client,
      `SELECT auto_lock, timesheet_deadline, week_start_day, timezone, updated_at
       FROM organizations WHERE id = 1`,
    )
    if (row === null) {
      throw new TimesheetLockPolicyError('not_found', 'Organization settings do not exist.')
    }
    const settings = settingsRecord(row)
    validateTimezone(settings.timezone)
    return settings
  }

  async updateSettings(
    actor: Readonly<TimesheetLockPolicyActor>,
    input: Readonly<UpdateTimesheetLockPolicySettings>,
    occurredAt: string,
  ): Promise<TimesheetLockPolicySettings> {
    assertPrivileged(actor)
    if (input.timesheetDeadline !== undefined) validateDeadline(input.timesheetDeadline)
    if (input.timezone !== undefined) validateTimezone(input.timezone)
    const authorized = await first<{ authorized: number }>(
      this.#client,
      `SELECT 1 AS authorized FROM users
       WHERE id = ? AND profile IN ('administrator','executive_manager')`,
      [actor.userId],
    )
    if (authorized === null) {
      throw new TimesheetLockPolicyError(
        'forbidden',
        'The acting user is not a policy administrator.',
      )
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const before = await this.settings()
      await this.materializeAutoLocks(occurredAt)
      const assignments: string[] = []
      const params: unknown[] = []
      if (input.autoLock !== undefined) {
        assignments.push('auto_lock = ?')
        params.push(input.autoLock ? 1 : 0)
      }
      if (input.timesheetDeadline !== undefined) {
        assignments.push('timesheet_deadline = ?')
        params.push(
          input.timesheetDeadline === null ? null : JSON.stringify(input.timesheetDeadline),
        )
      }
      if (input.timezone !== undefined) {
        assignments.push('timezone = ?')
        params.push(input.timezone)
      }
      assignments.push('updated_at = ?')
      params.push(occurredAt, actor.userId)
      const effectiveAutoLock = input.autoLock === undefined ? 'auto_lock' : '?'
      if (input.autoLock !== undefined) params.push(input.autoLock ? 1 : 0)
      const effectiveDeadline = input.timesheetDeadline === undefined
        ? 'timesheet_deadline'
        : '?'
      if (input.timesheetDeadline !== undefined) {
        params.push(
          input.timesheetDeadline === null ? null : JSON.stringify(input.timesheetDeadline),
        )
      }
      params.push(
        before.autoLock ? 1 : 0,
        before.timesheetDeadline === null ? null : JSON.stringify(before.timesheetDeadline),
        before.weekStartDay,
        before.timezone,
        before.updatedAt,
      )
      const row = await runReturning<RawSettingsRow>(
        this.#client,
        `UPDATE organizations SET ${assignments.join(', ')}
         WHERE id = 1 AND EXISTS (
           SELECT 1 FROM users actor WHERE actor.id = ?
             AND actor.profile IN ('administrator','executive_manager')
         )
           AND (${effectiveAutoLock} = 0 OR ${effectiveDeadline} IS NOT NULL)
           AND auto_lock = ? AND timesheet_deadline IS ?
           AND week_start_day = ? AND timezone = ? AND updated_at = ?
         RETURNING auto_lock, timesheet_deadline, week_start_day, timezone, updated_at`,
        params,
      )
      if (row !== null) return settingsRecord(row)
      const current = await this.settings()
      const effectiveAutoLockValue = input.autoLock ?? current.autoLock
      const effectiveDeadlineValue = input.timesheetDeadline === undefined
        ? current.timesheetDeadline
        : input.timesheetDeadline
      if (effectiveAutoLockValue && effectiveDeadlineValue === null) break
    }
    const current = await this.settings()
    const effectiveAutoLockValue = input.autoLock ?? current.autoLock
    const effectiveDeadlineValue = input.timesheetDeadline === undefined
      ? current.timesheetDeadline
      : input.timesheetDeadline
    if (effectiveAutoLockValue && effectiveDeadlineValue === null) {
      throw new TimesheetLockPolicyError(
        'invalid_settings',
        'Automatic locking requires a weekly timesheet deadline.',
      )
    }
    throw new TimesheetLockPolicyError(
      'state_conflict',
      'The timesheet lock policy changed concurrently. Retry the update.',
    )
  }

  async lockWindow(lockId: number): Promise<TimesheetLockWindowRecord> {
    const row = await first<RawLockRow>(
      this.#client,
      `SELECT * FROM timesheet_lock_windows WHERE id = ?`,
      [lockId],
    )
    if (row === null) {
      throw new TimesheetLockPolicyError('not_found', 'The timesheet lock does not exist.')
    }
    return lockRecord(row)
  }

  lockWindows(filters: Readonly<TimesheetLockWindowFilters> = {}): TimesheetLockWindowSource {
    const conditions: string[] = []
    const params: unknown[] = []
    if (filters.active !== undefined) conditions.push(`lock.unlocked_at IS ${filters.active ? '' : 'NOT '}NULL`)
    if (filters.kind !== undefined) {
      conditions.push('lock.kind = ?')
      params.push(filters.kind)
    }
    const predicate = conditions.length === 0 ? '1 = 1' : conditions.join(' AND ')
    return {
      highWatermark: async () => {
        const row = await first<{ id: number | null }>(
          this.#client,
          `SELECT max(lock.id) AS id FROM timesheet_lock_windows lock WHERE ${predicate}`,
          params,
        )
        return row?.id ?? null
      },
      list: async ({ afterId, throughId, take }) =>
        (
          await all<RawLockRow>(
            this.#client,
            `SELECT lock.* FROM timesheet_lock_windows lock
             WHERE ${predicate} AND lock.id <= ? ${afterId === null ? '' : 'AND lock.id > ?'}
             ORDER BY lock.id LIMIT ?`,
            [...params, throughId, ...(afterId === null ? [] : [afterId]), take],
          )
        ).map(lockRecord),
    }
  }

  async createManualLock(
    actor: Readonly<TimesheetLockPolicyActor>,
    lockedThrough: string,
    reason: string,
    occurredAt: string,
    commandId: string,
    inputFingerprint: string,
  ): Promise<TimesheetLockWindowRecord> {
    assertPrivileged(actor)
    assertDate(lockedThrough, 'lockedThrough')
    const normalizedReason = assertReason(reason)
    if (
      !/^[A-Za-z0-9._:-]{1,128}$/.test(commandId) ||
      !/^sha256:[0-9a-f]{64}$/.test(inputFingerprint)
    ) {
      throw new TimesheetLockPolicyError(
        'invalid_settings',
        'The lock command identity is invalid.',
      )
    }
    const replay = (row: RawLockRow): TimesheetLockWindowRecord => {
      if (
        row.locked_by_user_id !== actor.userId ||
        row.input_fingerprint !== inputFingerprint
      ) {
        throw new TimesheetLockPolicyError(
          'command_id_reused',
          'The Idempotency-Key was already used with different lock input.',
        )
      }
      return lockRecord(row)
    }
    const existing = await first<RawLockRow>(
      this.#client,
      `SELECT * FROM timesheet_lock_windows WHERE command_id = ?`,
      [commandId],
    )
    if (existing !== null) return replay(existing)
    try {
      const row = await runReturning<RawLockRow>(
        this.#client,
        `INSERT INTO timesheet_lock_windows (
          kind, period_start, period_end, locked_by_user_id, locked_at, lock_reason,
          command_id, input_fingerprint, version, created_at, updated_at
        ) VALUES ('manual_cutoff', NULL, ?, ?, ?, ?, ?, ?, 0, ?, ?) RETURNING *`,
        [
          lockedThrough,
          actor.userId,
          occurredAt,
          normalizedReason,
          commandId,
          inputFingerprint,
          occurredAt,
          occurredAt,
        ],
      )
      if (row === null) throw new Error('timesheet lock insert returned no row')
      return lockRecord(row)
    } catch (error) {
      const concurrent = await first<RawLockRow>(
        this.#client,
        `SELECT * FROM timesheet_lock_windows WHERE command_id = ?`,
        [commandId],
      )
      if (concurrent !== null) return replay(concurrent)
      return translateWriteError(error)
    }
  }

  async materializeAutoLocks(
    occurredAt: string,
    additionalDates: readonly string[] = [],
  ): Promise<readonly TimesheetLockWindowRecord[]> {
    const settings = await this.settings()
    if (!settings.autoLock || settings.timesheetDeadline === null) return []
    const localNow = localDateTime(occurredAt, settings.timezone)
    const dates = await all<{ spent_date: string }>(
      this.#client,
      `SELECT spent_date FROM time_entries
       UNION SELECT spent_date FROM expenses
       UNION SELECT period_start AS spent_date FROM timesheet_submissions`,
    )
    const existingPeriods = new Set(
      (
        await all<{ period_start: string; period_end: string }>(
          this.#client,
          `SELECT period_start, period_end FROM timesheet_lock_windows
           WHERE kind = 'weekly_deadline'`,
        )
      ).map(({ period_start, period_end }) => `${period_start}:${period_end}`),
    )
    const periods = [
      ...new Set(
        [...dates.map(({ spent_date }) => spent_date), ...additionalDates].map((spentDate) =>
          weekStart(spentDate, settings.weekStartDay),
        ),
      ),
    ]
      .map((periodStart) => ({ periodStart, periodEnd: addDays(periodStart, 6) }))
      .filter(({ periodEnd }) => deadlineDateTime(periodEnd, settings.timesheetDeadline!) <= localNow)
      .filter(({ periodStart, periodEnd }) => !existingPeriods.has(`${periodStart}:${periodEnd}`))
      .sort((left, right) => left.periodStart.localeCompare(right.periodStart))
    const inserted: TimesheetLockWindowRecord[] = []
    for (const period of periods) {
      try {
        const row = await runReturning<RawLockRow>(
          this.#client,
          `INSERT INTO timesheet_lock_windows (
            kind, period_start, period_end, locked_by_user_id, locked_at, lock_reason,
            week_start_day, deadline_day, deadline_time, timezone,
            version, created_at, updated_at
          ) SELECT 'weekly_deadline', ?, ?, NULL, ?, ?, ?, ?, ?, ?, 0, ?, ?
          FROM organizations organization
          WHERE organization.id = 1 AND organization.auto_lock = 1
            AND organization.timesheet_deadline = ?
            AND organization.week_start_day = ? AND organization.timezone = ?
            AND organization.updated_at = ?
          ON CONFLICT DO NOTHING RETURNING *`,
          [
            period.periodStart,
            period.periodEnd,
            occurredAt,
            `Weekly deadline (${settings.timesheetDeadline.day} ${settings.timesheetDeadline.time} ${settings.timezone})`,
            settings.weekStartDay,
            settings.timesheetDeadline.day,
            settings.timesheetDeadline.time,
            settings.timezone,
            occurredAt,
            occurredAt,
            JSON.stringify(settings.timesheetDeadline),
            settings.weekStartDay,
            settings.timezone,
            settings.updatedAt,
          ],
        )
        if (row !== null) inserted.push(lockRecord(row))
      } catch (error) {
        const message = error instanceof Error ? error.message.toLocaleLowerCase('en-US') : ''
        if (message.includes('running time entries')) continue
        return translateWriteError(error)
      }
    }
    return inserted
  }

  async unlock(
    actor: Readonly<TimesheetLockPolicyActor>,
    lockId: number,
    reason: string,
    occurredAt: string,
  ): Promise<TimesheetLockWindowRecord> {
    assertPrivileged(actor)
    const normalizedReason = assertReason(reason)
    try {
      const row = await runReturning<RawLockRow>(
        this.#client,
        `UPDATE timesheet_lock_windows
         SET unlocked_by_user_id = ?, unlocked_at = ?, unlock_reason = ?,
           version = version + 1, updated_at = ?
         WHERE id = ? AND unlocked_at IS NULL
         RETURNING *`,
        [actor.userId, occurredAt, normalizedReason, occurredAt, lockId],
      )
      if (row !== null) return lockRecord(row)
    } catch (error) {
      return translateWriteError(error)
    }
    const existing = await first<{ unlocked_at: string | null }>(
      this.#client,
      `SELECT unlocked_at FROM timesheet_lock_windows WHERE id = ?`,
      [lockId],
    )
    if (existing === null) {
      throw new TimesheetLockPolicyError('not_found', 'The timesheet lock does not exist.')
    }
    throw new TimesheetLockPolicyError('state_conflict', 'The timesheet lock is already unlocked.')
  }

  async withdrawTimesheet(
    actor: Readonly<TimesheetLockPolicyActor>,
    submissionId: number,
    reason: string,
    occurredAt: string,
  ): Promise<TimesheetSubmissionRecord> {
    assertPrivileged(actor)
    return this.#approvals.withdraw(actor, submissionId, assertReason(reason), occurredAt)
  }

  /**
   * No `assertPrivileged`, deliberately. This is not a policy act -- the
   * authority is that the submission is the actor's own, which the repository
   * checks inside the UPDATE rather than trusting a caller's read.
   */
  async unsubmitTimesheet(
    actor: Readonly<TimesheetLockPolicyActor>,
    submissionId: number,
    occurredAt: string,
  ): Promise<TimesheetSubmissionRecord> {
    return this.#approvals.unsubmit(actor, submissionId, occurredAt)
  }

  async resolve(subject: Readonly<PolicySubject>): Promise<TimesheetPolicyLockResolution> {
    let spentDate: string | null
    if (subject.entityType === 'time_entry') {
      spentDate = (await first<{ spent_date: string }>(
        this.#client,
        `SELECT spent_date FROM time_entries WHERE id = ?`,
        [subject.entityId],
      ))?.spent_date ?? null
    } else if (subject.entityType === 'expense') {
      spentDate = (await first<{ spent_date: string }>(
        this.#client,
        `SELECT spent_date FROM expenses WHERE id = ?`,
        [subject.entityId],
      ))?.spent_date ?? null
    } else if (subject.entityType === 'running_time_entry_replacement') {
      const replacement = subject as Extract<
        PolicySubject,
        { entityType: 'running_time_entry_replacement' }
      >
      spentDate = (await first<{ spent_date: string }>(
        this.#client,
        `SELECT spent_date FROM time_entries WHERE user_id = ?
         AND (timer_started_at IS NOT NULL OR (started_time IS NOT NULL AND ended_time IS NULL))
         LIMIT 1`,
        [replacement.userId],
      ))?.spent_date ?? null
    } else {
      spentDate = subject.spentDate
    }
    await this.materializeAutoLocks(this.#clock(), spentDate === null ? [] : [spentDate])
    if (spentDate === null) return { locked: false, cause: null, reason: null, lock: null }
    const row = await first<RawLockRow>(
      this.#client,
      `SELECT * FROM timesheet_lock_windows lock
       WHERE lock.unlocked_at IS NULL AND ? <= lock.period_end
         AND (lock.period_start IS NULL OR ? >= lock.period_start)
       ORDER BY CASE lock.kind WHEN 'manual_cutoff' THEN 0 ELSE 1 END,
         lock.locked_at DESC, lock.id DESC LIMIT 1`,
      [spentDate, spentDate],
    )
    if (row === null) return { locked: false, cause: null, reason: null, lock: null }
    const lock = lockRecord(row)
    return { locked: true, cause: lock.kind, reason: lock.lockReason, lock }
  }

  async lockedDates(spentDates: readonly string[]): Promise<ReadonlyMap<string, boolean>> {
    const dates = [...new Set(spentDates)]
    if (dates.length === 0) return new Map()
    await this.materializeAutoLocks(this.#clock(), dates)
    const periodStart = dates.reduce((left, right) => left < right ? left : right)
    const periodEnd = dates.reduce((left, right) => left > right ? left : right)
    const windows = await all<Pick<RawLockRow, 'period_start' | 'period_end'>>(
      this.#client,
      `SELECT period_start, period_end FROM timesheet_lock_windows
       WHERE unlocked_at IS NULL AND period_end >= ?
         AND (period_start IS NULL OR period_start <= ?)`,
      [periodStart, periodEnd],
    )
    return new Map(
      dates.map((date) => [
        date,
        windows.some((window) =>
          date <= window.period_end && (window.period_start === null || date >= window.period_start)
        ),
      ]),
    )
  }

  async isLocked(subject: Readonly<PolicySubject>): Promise<boolean> {
    return (await this.resolve(subject)).locked
  }
}

export const createTimesheetLockPolicyRepository = (
  database: LockDatabase,
  options: { clock?: () => string } = {},
): TimesheetLockPolicyRepository => new DrizzleTimesheetLockPolicyRepository(database, options)
