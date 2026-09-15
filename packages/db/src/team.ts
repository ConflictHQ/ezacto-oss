import {
  TeamError,
  type ReminderDay,
  type TeamCommand,
  type TeamCommandReceipt,
  type TeamListFilter,
  type TeamNamedRelation,
  type TeamNotificationPreference,
  type TeamPersonPatch,
  type TeamPersonRecord,
  type TeamPersonSummary,
  type TeamProjectAssignment,
  type TeamRateRecord,
  type TeamRepository,
  type TeamViewer,
  type UserProfile,
} from '@ezacto/core'
import type BetterSqlite3 from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import { teamPersonAccessPredicate } from './team-access.js'

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>
type NativeClient = BetterSqlite3.Database | D1Database

interface Operation {
  query: string
  bindings: readonly unknown[]
}

interface UserRow {
  id: number
  firstName: string
  lastName: string
  email: string | null
  telephone: string | null
  employeeId: string | null
  timezone: string
  isContractor: number
  isActive: number
  hasAccessToAllFutureProjects: number
  weeklyCapacity: number
  profile: UserProfile
  isOwner: number
  avatarUrl: string | null
  version: number
  createdAt: string
  updatedAt: string
}

interface SummaryRow extends UserRow {
  totalSeconds: number
  billableSeconds: number
  running: number
}

interface AssignmentRow {
  id: number
  projectId: number
  projectName: string
  projectCode: string
  clientId: number
  clientName: string
  isActive: number
  isProjectManager: number
  useDefaultRates: number
  hourlyRateCents: number | null
  budgetSeconds: number | null
  updatedAt: string
}

interface RateRow {
  id: number
  userId: number
  amountCents: number
  startDate: string | null
  endDate: string | null
  createdAt: string
  updatedAt: string
}

interface NotificationRow {
  dailyReminderEnabled: number
  reminderTime: string | null
  reminderDays: string
  emailEnabled: number
  desktopEnabled: number
  slackEnabled: number
  includeInTeamReminders: number
  weeklyDigest: number
  notifyProjectDeleted: number
  updatedAt: string
}

interface ReceiptRow {
  targetUserId: number
  commandKind: string
  inputFingerprint: string
  actorUserId: number
  resultJson: string
}

const nativeClient = (database: Database): NativeClient =>
  (database as Database & { $client: NativeClient }).$client

const isD1 = (client: NativeClient): client is D1Database => 'batch' in client

const first = async <Row>(
  client: NativeClient,
  query: string,
  bindings: readonly unknown[] = [],
): Promise<Row | null> => {
  if (isD1(client)) return client.prepare(query).bind(...bindings).first<Row>()
  return (client.prepare(query).get(...bindings) as Row | undefined) ?? null
}

const all = async <Row>(
  client: NativeClient,
  query: string,
  bindings: readonly unknown[] = [],
): Promise<Row[]> => {
  if (isD1(client)) return (await client.prepare(query).bind(...bindings).all<Row>()).results
  return client.prepare(query).all(...bindings) as Row[]
}

const atomic = async (
  client: NativeClient,
  operations: readonly Operation[],
): Promise<Record<string, unknown>[][]> => {
  if (isD1(client)) {
    const result = await client.batch(
      operations.map(({ query, bindings }) => client.prepare(query).bind(...bindings)),
    )
    return result.map((item) => (item.results ?? []) as Record<string, unknown>[])
  }
  return client.transaction(() =>
    operations.map(({ query, bindings }) => {
      const statement = client.prepare(query)
      if (statement.reader) {
        return statement.all(...bindings) as Record<string, unknown>[]
      }
      statement.run(...bindings)
      return []
    }),
  ).immediate()
}

const hexadecimal = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')

const fingerprint = async (value: unknown): Promise<string> => {
  const encoded = new TextEncoder().encode(JSON.stringify(value))
  return `sha256:${hexadecimal(new Uint8Array(await crypto.subtle.digest('SHA-256', encoded)))}`
}

const filterSql = (
  viewer: Readonly<TeamViewer>,
  filter: Readonly<TeamListFilter>,
): { sql: string; bindings: unknown[] } => {
  const target = teamPersonAccessPredicate(viewer)
  return {
    sql: `${target.sql}${filter.isActive === undefined ? '' : ' AND user.is_active = ?'}`,
    bindings: [
      ...target.bindings,
      ...(filter.isActive === undefined ? [] : [filter.isActive ? 1 : 0]),
    ],
  }
}

const utilizationPpm = (seconds: number, capacity: number): number | null => {
  if (capacity === 0) return null
  const value = (BigInt(seconds) * 1_000_000n + BigInt(Math.floor(capacity / 2))) /
    BigInt(capacity)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TeamError('invalid_input', 'Utilization exceeds the supported aggregate range.')
  }
  return Number(value)
}

const summary = (row: SummaryRow): TeamPersonSummary => ({
  id: row.id,
  firstName: row.firstName,
  lastName: row.lastName,
  email: row.email,
  avatarUrl: row.avatarUrl,
  profile: row.profile,
  isOwner: row.isOwner === 1,
  isContractor: row.isContractor === 1,
  isActive: row.isActive === 1,
  weeklyCapacity: row.weeklyCapacity,
  totalSeconds: row.totalSeconds,
  billableSeconds: row.billableSeconds,
  nonbillableSeconds: row.totalSeconds - row.billableSeconds,
  utilizationPpm: utilizationPpm(row.totalSeconds, row.weeklyCapacity),
  running: row.running === 1,
})

const rate = (row: RateRow): TeamRateRecord => ({ ...row })

const assignment = (row: AssignmentRow): TeamProjectAssignment => ({
  ...row,
  isActive: row.isActive === 1,
  isProjectManager: row.isProjectManager === 1,
  useDefaultRates: row.useDefaultRates === 1,
})

const notification = (row: NotificationRow): TeamNotificationPreference => ({
  deliveryActive: false,
  dailyReminderEnabled: row.dailyReminderEnabled === 1,
  reminderTime: row.reminderTime,
  reminderDays: JSON.parse(row.reminderDays) as ReminderDay[],
  emailEnabled: row.emailEnabled === 1,
  desktopEnabled: row.desktopEnabled === 1,
  slackEnabled: row.slackEnabled === 1,
  includeInTeamReminders: row.includeInTeamReminders === 1,
  weeklyDigest: row.weeklyDigest === 1,
  notifyProjectDeleted: row.notifyProjectDeleted === 1,
  updatedAt: row.updatedAt,
})

const namedRelations = async (
  client: NativeClient,
  table: 'roles' | 'departments',
  relation: 'user_roles' | 'user_departments',
  relationColumn: 'role_id' | 'department_id',
  userId?: number,
): Promise<TeamNamedRelation[]> =>
  all<TeamNamedRelation>(
    client,
    userId === undefined
      ? `SELECT id, name FROM ${table} ORDER BY lower(name), id`
      : `SELECT value.id, value.name FROM ${table} value
         JOIN ${relation} relation ON relation.${relationColumn} = value.id
         WHERE relation.user_id = ? ORDER BY lower(value.name), value.id`,
    userId === undefined ? [] : [userId],
  )

const userColumns = `user.id AS id, user.first_name AS firstName,
  user.last_name AS lastName,
  (SELECT address FROM user_emails email
    WHERE email.user_id = user.id AND email.is_primary = 1
      AND email.invalidated_at IS NULL LIMIT 1) AS email,
  user.telephone AS telephone, user.employee_id AS employeeId,
  user.timezone AS timezone, user.is_contractor AS isContractor,
  user.is_active AS isActive,
  user.has_access_to_all_future_projects AS hasAccessToAllFutureProjects,
  user.weekly_capacity AS weeklyCapacity, user.profile AS profile,
  user.is_owner AS isOwner, user.avatar_url AS avatarUrl,
  user.version AS version, user.created_at AS createdAt,
  user.updated_at AS updatedAt`

const getPerson = async (
  client: NativeClient,
  viewer: Readonly<TeamViewer>,
  userId: number,
): Promise<TeamPersonRecord | null> => {
  const target = teamPersonAccessPredicate(viewer)
  const user = await first<UserRow>(
    client,
    `SELECT ${userColumns} FROM users user WHERE user.id = ? AND ${target.sql}`,
    [userId, ...target.bindings],
  )
  if (user === null) return null
  const [roles, departments, projects, billableRates, costRates, preference] = await Promise.all([
    namedRelations(client, 'roles', 'user_roles', 'role_id', userId),
    namedRelations(client, 'departments', 'user_departments', 'department_id', userId),
    all<AssignmentRow>(
      client,
      `SELECT assignment.id, project.id AS projectId, project.name AS projectName,
        project.code AS projectCode, client.id AS clientId, client.name AS clientName,
        assignment.is_active AS isActive,
        assignment.is_project_manager AS isProjectManager,
        assignment.use_default_rates AS useDefaultRates,
        assignment.hourly_rate_cents AS hourlyRateCents,
        assignment.budget_seconds AS budgetSeconds,
        assignment.updated_at AS updatedAt
      FROM user_assignments assignment
      JOIN projects project ON project.id = assignment.project_id
      JOIN clients client ON client.id = project.client_id
      WHERE assignment.user_id = ?
      ORDER BY assignment.is_active DESC, lower(client.name), lower(project.name), project.id`,
      [userId],
    ),
    all<RateRow>(
      client,
      `SELECT id, user_id AS userId, amount_cents AS amountCents,
        start_date AS startDate, end_date AS endDate,
        created_at AS createdAt, updated_at AS updatedAt
      FROM user_billable_rates WHERE user_id = ?
      ORDER BY coalesce(start_date, '0000-01-01'), id`,
      [userId],
    ),
    all<RateRow>(
      client,
      `SELECT id, user_id AS userId, amount_cents AS amountCents,
        start_date AS startDate, end_date AS endDate,
        created_at AS createdAt, updated_at AS updatedAt
      FROM user_cost_rates WHERE user_id = ?
      ORDER BY coalesce(start_date, '0000-01-01'), id`,
      [userId],
    ),
    first<NotificationRow>(
      client,
      `SELECT daily_reminder_enabled AS dailyReminderEnabled,
        reminder_time AS reminderTime, reminder_days AS reminderDays,
        email_enabled AS emailEnabled, desktop_enabled AS desktopEnabled,
        slack_enabled AS slackEnabled,
        include_in_team_reminders AS includeInTeamReminders,
        weekly_digest AS weeklyDigest,
        notify_project_deleted AS notifyProjectDeleted,
        updated_at AS updatedAt
      FROM notification_preferences WHERE user_id = ?`,
      [userId],
    ),
  ])
  if (preference === null) {
    throw new TeamError('invalid_input', 'The person notification preference is missing.')
  }
  return {
    ...user,
    isContractor: user.isContractor === 1,
    isActive: user.isActive === 1,
    hasAccessToAllFutureProjects: user.hasAccessToAllFutureProjects === 1,
    isOwner: user.isOwner === 1,
    roles,
    departments,
    projectAssignments: projects.map(assignment),
    billableRates: billableRates.map(rate),
    costRates: costRates.map(rate),
    notifications: notification(preference),
  }
}

const receiptFromRow = (row: ReceiptRow): TeamCommandReceipt => {
  let parsed: unknown
  try {
    parsed = JSON.parse(row.resultJson)
  } catch {
    throw new TeamError('invalid_input', 'A stored Team command receipt is invalid.')
  }
  const data =
    typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'data') : undefined
  if (typeof data !== 'object' || data === null) {
    throw new TeamError('invalid_input', 'A stored Team command receipt is invalid.')
  }
  const targetUserId = Reflect.get(data, 'target_user_id')
  const version = Reflect.get(data, 'version')
  const resourceId = Reflect.get(data, 'resource_id')
  const occurredAt = Reflect.get(data, 'occurred_at')
  if (
    !Number.isSafeInteger(targetUserId) ||
    !Number.isSafeInteger(version) ||
    (resourceId !== null && !Number.isSafeInteger(resourceId)) ||
    typeof occurredAt !== 'string'
  ) {
    throw new TeamError('invalid_input', 'A stored Team command receipt is invalid.')
  }
  return {
    targetUserId: targetUserId as number,
    version: version as number,
    resourceId: resourceId as number | null,
    occurredAt,
  }
}

const existingReceipt = async (
  client: NativeClient,
  command: Readonly<TeamCommand>,
  inputFingerprint: string,
): Promise<TeamCommandReceipt | null> => {
  const row = await first<ReceiptRow>(
    client,
    `SELECT target_user_id AS targetUserId, command_kind AS commandKind,
      input_fingerprint AS inputFingerprint, actor_user_id AS actorUserId,
      result_json AS resultJson
    FROM team_command_ledger WHERE command_kind = ? AND command_id = ?`,
    [command.commandKind, command.commandId],
  )
  if (row === null) return null
  if (
    row.targetUserId !== command.targetUserId ||
    row.actorUserId !== command.actorUserId ||
    row.inputFingerprint !== inputFingerprint
  ) {
    throw new TeamError('command_id_reused', 'The idempotency key was already used for different input.')
  }
  return receiptFromRow(row)
}

const checkVersion = async (
  client: NativeClient,
  command: Readonly<TeamCommand>,
): Promise<UserRow> => {
  const user = await first<UserRow>(
    client,
    `SELECT ${userColumns} FROM users user WHERE user.id = ?`,
    [command.targetUserId],
  )
  if (user === null) throw new TeamError('not_found', 'The person does not exist.')
  if (user.version !== command.expectedVersion) {
    throw new TeamError('state_conflict', 'The person changed after it was loaded. Refresh and retry.')
  }
  return user
}

const resultJsonSql = (resourceIdSql = 'NULL'): string =>
  `json_object('schema_version', 1, 'data', json_object(
    'target_user_id', ?, 'version', ?, 'resource_id', ${resourceIdSql}, 'occurred_at', ?
  ))`

const writeToken = (command: Readonly<TeamCommand>): string =>
  `${command.commandKind}:${command.commandId}`

const receiptInsert = (
  command: Readonly<TeamCommand>,
  inputFingerprint: string,
  resourceIdSql = 'NULL',
  extraBindings: readonly unknown[] = [],
): Operation => ({
  query: `INSERT INTO team_command_ledger (
      target_user_id, command_kind, command_id, input_fingerprint,
      actor_user_id, result_json, occurred_at
    ) SELECT ?, ?, ?, ?, ?, ${resultJsonSql(resourceIdSql)}, ?
    FROM users user WHERE user.id = ? AND user.version = ? AND user.team_write_token = ?`,
  bindings: [
    command.targetUserId,
    command.commandKind,
    command.commandId,
    inputFingerprint,
    command.actorUserId,
    command.targetUserId,
    command.expectedVersion + 1,
    ...extraBindings,
    command.occurredAt,
    command.occurredAt,
    command.targetUserId,
    command.expectedVersion + 1,
    writeToken(command),
  ],
})

const translateMutationError = (error: unknown): never => {
  if (error instanceof TeamError) throw error
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()
  if (
    lower.includes('owner cannot') ||
    lower.includes('retain an active administrator') ||
    lower.includes('owner cannot be deactivated')
  ) {
    throw new TeamError('state_conflict', message)
  }
  if (
    lower.includes('chronologically') ||
    lower.includes('valid date') ||
    lower.includes('check constraint') ||
    lower.includes('foreign key') ||
    lower.includes('unique')
  ) {
    throw new TeamError('invalid_input', message)
  }
  throw error
}

const executeCommand = async (
  client: NativeClient,
  command: Readonly<TeamCommand>,
  semanticInput: unknown,
  operations: readonly Operation[],
): Promise<TeamCommandReceipt> => {
  const inputFingerprint = await fingerprint({
    targetUserId: command.targetUserId,
    commandKind: command.commandKind,
    expectedVersion: command.expectedVersion,
    input: semanticInput,
  })
  const replay = await existingReceipt(client, command, inputFingerprint)
  if (replay !== null) return replay
  await checkVersion(client, command)
  try {
    await atomic(client, operations)
  } catch (error) {
    const raced = await existingReceipt(client, command, inputFingerprint)
    if (raced !== null) return raced
    return translateMutationError(error)
  }
  const completed = await existingReceipt(client, command, inputFingerprint)
  if (completed !== null) return completed
  throw new TeamError('state_conflict', 'The person changed while the command was being applied.')
}

const validateRelations = async (
  client: NativeClient,
  table: 'roles' | 'departments',
  ids: readonly number[] | undefined,
): Promise<void> => {
  if (ids === undefined || ids.length === 0) return
  const placeholders = ids.map(() => '?').join(',')
  const count = await first<{ count: number }>(
    client,
    `SELECT count(*) AS count FROM ${table} WHERE id IN (${placeholders})`,
    ids,
  )
  if (count?.count !== ids.length) {
    throw new TeamError('invalid_input', `One or more ${table} do not exist.`)
  }
}

const updatePersonOperations = (
  command: Readonly<TeamCommand>,
  patch: Readonly<TeamPersonPatch>,
  inputFingerprint: string,
): Operation[] => {
  const fields: Array<[string, unknown]> = []
  const scalarColumns: Readonly<Record<Exclude<keyof TeamPersonPatch, 'roleIds' | 'departmentIds'>, string>> = {
    firstName: 'first_name',
    lastName: 'last_name',
    telephone: 'telephone',
    employeeId: 'employee_id',
    timezone: 'timezone',
    isContractor: 'is_contractor',
    isActive: 'is_active',
    hasAccessToAllFutureProjects: 'has_access_to_all_future_projects',
    weeklyCapacity: 'weekly_capacity',
    profile: 'profile',
  }
  for (const [field, column] of Object.entries(scalarColumns)) {
    const value = patch[field as keyof TeamPersonPatch]
    if (value !== undefined) fields.push([column, typeof value === 'boolean' ? (value ? 1 : 0) : value])
  }
  const operations: Operation[] = [{
    query: `UPDATE users SET ${[
      ...fields.map(([column]) => `${column} = ?`),
      'version = version + 1',
      'team_write_token = ?',
      'updated_at = ?',
    ].join(', ')} WHERE id = ? AND version = ? RETURNING id`,
    bindings: [
      ...fields.map(([, value]) => value),
      writeToken(command),
      command.occurredAt,
      command.targetUserId,
      command.expectedVersion,
    ],
  }]
  for (const relation of [
    { ids: patch.roleIds, table: 'user_roles', column: 'role_id' },
    { ids: patch.departmentIds, table: 'user_departments', column: 'department_id' },
  ] as const) {
    if (relation.ids === undefined) continue
    operations.push({
      query: `DELETE FROM ${relation.table} WHERE user_id = ?
        AND EXISTS (SELECT 1 FROM users
          WHERE id = ? AND version = ? AND team_write_token = ?)
        RETURNING user_id`,
      bindings: [
        command.targetUserId,
        command.targetUserId,
        command.expectedVersion + 1,
        writeToken(command),
      ],
    })
    if (relation.ids.length > 0) {
      operations.push({
        query: `INSERT INTO ${relation.table} (user_id, ${relation.column}, created_at, updated_at)
          SELECT ?, CAST(value AS INTEGER), ?, ? FROM json_each(?)
          WHERE EXISTS (SELECT 1 FROM users
            WHERE id = ? AND version = ? AND team_write_token = ?)
          RETURNING user_id`,
        bindings: [
          command.targetUserId,
          command.occurredAt,
          command.occurredAt,
          JSON.stringify(relation.ids),
          command.targetUserId,
          command.expectedVersion + 1,
          writeToken(command),
        ],
      })
    }
  }
  operations.push(receiptInsert(command, inputFingerprint))
  return operations
}

export const createTeamRepository = (database: Database): TeamRepository => {
  const client = nativeClient(database)
  return {
    async highWatermark(viewer, filter) {
      const where = filterSql(viewer, filter)
      const row = await first<{ maximum: number | null }>(
        client,
        `SELECT max(user.id) AS maximum FROM users user WHERE ${where.sql}`,
        where.bindings,
      )
      return row?.maximum ?? null
    },

    async list(viewer, filter, window) {
      const where = filterSql(viewer, filter)
      const rows = await all<SummaryRow>(
        client,
        `SELECT ${userColumns},
          coalesce(sum(entry.rounded_seconds), 0) AS totalSeconds,
          coalesce(sum(CASE WHEN entry.billable = 1 THEN entry.rounded_seconds ELSE 0 END), 0)
            AS billableSeconds,
          CASE WHEN EXISTS (
            SELECT 1 FROM time_entries running WHERE running.user_id = user.id
              AND (running.timer_started_at IS NOT NULL
                OR (running.started_time IS NOT NULL AND running.ended_time IS NULL))
          ) THEN 1 ELSE 0 END AS running
        FROM users user
        LEFT JOIN time_entries entry ON entry.user_id = user.id
          AND entry.spent_date BETWEEN ? AND ?
        WHERE ${where.sql} AND user.id > ? AND user.id <= ?
        GROUP BY user.id ORDER BY user.id LIMIT ?`,
        [filter.from, filter.to, ...where.bindings, window.afterId ?? 0, window.throughId, window.take],
      )
      return rows.map(summary)
    },

    get: (viewer, userId) => getPerson(client, viewer, userId),

    async updatePerson(command, patch) {
      const semantic = {
        ...patch,
        ...(patch.roleIds === undefined ? {} : { roleIds: [...patch.roleIds].sort((a, b) => a - b) }),
        ...(patch.departmentIds === undefined
          ? {}
          : { departmentIds: [...patch.departmentIds].sort((a, b) => a - b) }),
      }
      const inputFingerprint = await fingerprint({
        targetUserId: command.targetUserId,
        commandKind: command.commandKind,
        expectedVersion: command.expectedVersion,
        input: semantic,
      })
      const replay = await existingReceipt(client, command, inputFingerprint)
      if (replay !== null) return replay
      await checkVersion(client, command)
      await Promise.all([
        validateRelations(client, 'roles', patch.roleIds),
        validateRelations(client, 'departments', patch.departmentIds),
      ])
      try {
        await atomic(client, updatePersonOperations(command, patch, inputFingerprint))
      } catch (error) {
        const raced = await existingReceipt(client, command, inputFingerprint)
        if (raced !== null) return raced
        return translateMutationError(error)
      }
      const completed = await existingReceipt(client, command, inputFingerprint)
      if (completed !== null) return completed
      throw new TeamError('state_conflict', 'The person changed while the command was being applied.')
    },

    async replaceAssignments(command, assignments) {
      const normalized = [...assignments].sort((left, right) => left.projectId - right.projectId)
      const ids = normalized.map(({ projectId }) => projectId)
      if (ids.length > 0) {
        const placeholders = ids.map(() => '?').join(',')
        const count = await first<{ count: number }>(
          client,
          `SELECT count(*) AS count FROM projects project
           WHERE project.id IN (${placeholders}) AND (
             project.is_active = 1 OR EXISTS (
               SELECT 1 FROM user_assignments current_assignment
               WHERE current_assignment.project_id = project.id
                 AND current_assignment.user_id = ?
                 AND current_assignment.is_active = 1
             )
           )`,
          [...ids, command.targetUserId],
        )
        if (count?.count !== ids.length) {
          throw new TeamError('invalid_input', 'One or more assigned projects are unavailable.')
        }
      }
      const inputFingerprint = await fingerprint({
        targetUserId: command.targetUserId,
        commandKind: command.commandKind,
        expectedVersion: command.expectedVersion,
        input: normalized,
      })
      const projectJson = JSON.stringify(
        normalized.map(({ projectId, isProjectManager }) => ({
          project_id: projectId,
          is_project_manager: isProjectManager ? 1 : 0,
        })),
      )
      return executeCommand(client, command, normalized, [
        {
          query: `UPDATE users SET version = version + 1, team_write_token = ?, updated_at = ?
            WHERE id = ? AND version = ? RETURNING id`,
          bindings: [
            writeToken(command),
            command.occurredAt,
            command.targetUserId,
            command.expectedVersion,
          ],
        },
        {
          query: `UPDATE user_assignments SET is_active = 0, is_project_manager = 0, updated_at = ?
            WHERE user_id = ? AND is_active = 1
              AND project_id NOT IN (
                SELECT CAST(json_extract(value, '$.project_id') AS INTEGER) FROM json_each(?)
              )
              AND EXISTS (SELECT 1 FROM users
                WHERE id = ? AND version = ? AND team_write_token = ?)
            RETURNING id`,
          bindings: [
            command.occurredAt,
            command.targetUserId,
            projectJson,
            command.targetUserId,
            command.expectedVersion + 1,
            writeToken(command),
          ],
        },
        {
          query: `INSERT INTO user_assignments (
              project_id, user_id, is_active, is_project_manager,
              use_default_rates, created_at, updated_at
            ) SELECT CAST(json_extract(value, '$.project_id') AS INTEGER), ?, 1,
              CAST(json_extract(value, '$.is_project_manager') AS INTEGER), 1, ?, ?
            FROM json_each(?)
            WHERE EXISTS (SELECT 1 FROM users
              WHERE id = ? AND version = ? AND team_write_token = ?)
            ON CONFLICT(project_id, user_id) DO UPDATE SET
              is_active = 1,
              is_project_manager = excluded.is_project_manager,
              updated_at = excluded.updated_at
            RETURNING id`,
          bindings: [
            command.targetUserId,
            command.occurredAt,
            command.occurredAt,
            projectJson,
            command.targetUserId,
            command.expectedVersion + 1,
            writeToken(command),
          ],
        },
        receiptInsert(command, inputFingerprint),
      ])
    },

    async updateNotifications(command, patch) {
      const inputFingerprint = await fingerprint({
        targetUserId: command.targetUserId,
        commandKind: command.commandKind,
        expectedVersion: command.expectedVersion,
        input: patch,
      })
      return executeCommand(client, command, patch, [
        {
          query: `UPDATE users SET version = version + 1, team_write_token = ?, updated_at = ?
            WHERE id = ? AND version = ? RETURNING id`,
          bindings: [
            writeToken(command),
            command.occurredAt,
            command.targetUserId,
            command.expectedVersion,
          ],
        },
        {
          query: `UPDATE notification_preferences SET
              daily_reminder_enabled = ?, reminder_time = ?, reminder_days = ?,
              email_enabled = ?, desktop_enabled = ?, slack_enabled = ?,
              include_in_team_reminders = ?, weekly_digest = ?,
              notify_project_deleted = ?, updated_at = ?
            WHERE user_id = ? AND EXISTS (
              SELECT 1 FROM users WHERE id = ? AND version = ? AND team_write_token = ?
            ) RETURNING user_id`,
          bindings: [
            patch.dailyReminderEnabled ? 1 : 0,
            patch.reminderTime,
            JSON.stringify(patch.reminderDays),
            patch.emailEnabled ? 1 : 0,
            patch.desktopEnabled ? 1 : 0,
            patch.slackEnabled ? 1 : 0,
            patch.includeInTeamReminders ? 1 : 0,
            patch.weeklyDigest ? 1 : 0,
            patch.notifyProjectDeleted ? 1 : 0,
            command.occurredAt,
            command.targetUserId,
            command.targetUserId,
            command.expectedVersion + 1,
            writeToken(command),
          ],
        },
        receiptInsert(command, inputFingerprint),
      ])
    },

    async appendRate(command, input) {
      const table = input.kind === 'billable' ? 'user_billable_rates' : 'user_cost_rates'
      const inputFingerprint = await fingerprint({
        targetUserId: command.targetUserId,
        commandKind: command.commandKind,
        expectedVersion: command.expectedVersion,
        input,
      })
      const resourceSql = `(SELECT id FROM ${table}
        WHERE user_id = ? AND start_date IS ? ORDER BY id DESC LIMIT 1)`
      return executeCommand(client, command, input, [
        {
          query: `UPDATE users SET version = version + 1, team_write_token = ?, updated_at = ?
            WHERE id = ? AND version = ? RETURNING id`,
          bindings: [
            writeToken(command),
            command.occurredAt,
            command.targetUserId,
            command.expectedVersion,
          ],
        },
        {
          query: `INSERT INTO ${table} (
              user_id, amount_cents, start_date, end_date, created_at, updated_at
            ) SELECT ?, ?, ?, NULL, ?, ?
            WHERE EXISTS (SELECT 1 FROM users
              WHERE id = ? AND version = ? AND team_write_token = ?)
            RETURNING id`,
          bindings: [
            command.targetUserId,
            input.amountCents,
            input.startDate,
            command.occurredAt,
            command.occurredAt,
            command.targetUserId,
            command.expectedVersion + 1,
            writeToken(command),
          ],
        },
        receiptInsert(command, inputFingerprint, resourceSql, [command.targetUserId, input.startDate]),
      ])
    },

    async removeRate(command, input) {
      const table = input.kind === 'billable' ? 'user_billable_rates' : 'user_cost_rates'
      const inputFingerprint = await fingerprint({
        targetUserId: command.targetUserId,
        commandKind: command.commandKind,
        expectedVersion: command.expectedVersion,
        input,
      })
      // Scoped to the person the command names as well as to the row, so a rate
      // id from another person's history cannot be removed by aiming this at
      // somebody whose version you happen to hold.
      return executeCommand(client, command, input, [
        {
          query: `UPDATE users SET version = version + 1, team_write_token = ?, updated_at = ?
            WHERE id = ? AND version = ? RETURNING id`,
          bindings: [
            writeToken(command),
            command.occurredAt,
            command.targetUserId,
            command.expectedVersion,
          ],
        },
        {
          query: `DELETE FROM ${table}
            WHERE id = ? AND user_id = ?
              AND EXISTS (SELECT 1 FROM users
                WHERE id = ? AND version = ? AND team_write_token = ?)
            RETURNING id`,
          bindings: [
            input.rateId,
            command.targetUserId,
            command.targetUserId,
            command.expectedVersion + 1,
            writeToken(command),
          ],
        },
        receiptInsert(command, inputFingerprint),
      ])
    },

    listRoles: () => namedRelations(client, 'roles', 'user_roles', 'role_id'),
    listDepartments: () =>
      namedRelations(client, 'departments', 'user_departments', 'department_id'),
    listAssignableProjects: () =>
      all(
        client,
        `SELECT project.id, project.name, project.code, client.id AS clientId,
          client.name AS clientName, project.is_active = 1 AS isActive
        FROM projects project JOIN clients client ON client.id = project.client_id
        ORDER BY project.is_active DESC, lower(client.name), lower(project.name), project.id`,
      ),
  }
}
