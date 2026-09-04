import {
  GeneralResourceError,
  type GeneralListWindow,
  type GeneralResourceFilters,
  type GeneralResourceKind,
  type GeneralResourceRecord,
  type GeneralResourceRepository,
  type GeneralValue,
  type UserRateRecord,
} from '@ezacto/core'
import type BetterSqlite3 from 'better-sqlite3'
import { sql, type SQL } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>
type NativeClient = BetterSqlite3.Database | D1Database

interface AtomicStatement {
  text: string
  params: unknown[]
}

interface ResourceDefinition {
  table: string
  columns: Readonly<Record<string, string>>
  booleans: ReadonlySet<string>
  json: ReadonlySet<string>
  filters: Readonly<Partial<Record<keyof GeneralResourceFilters, string>>>
  archive: boolean
}

const definitions: Readonly<Record<GeneralResourceKind, ResourceDefinition>> = {
  clients: {
    table: 'clients',
    columns: {
      name: 'name',
      address: 'address',
      currency: 'currency',
      isActive: 'is_active',
      parentClientId: 'parent_client_id',
      billToClientId: 'bill_to_client_id',
      paymentTerms: 'payment_terms',
      defaultTaxPct: 'default_tax_pct',
      defaultTax2Pct: 'default_tax2_pct',
      defaultDiscountPct: 'default_discount_pct',
    },
    booleans: new Set(['isActive']),
    json: new Set(),
    archive: true,
    filters: {
      isActive: 'is_active',
      updatedSince: 'updated_at',
      parentClientId: 'parent_client_id',
      billToClientId: 'bill_to_client_id',
    },
  },
  contacts: {
    table: 'contacts',
    columns: {
      clientId: 'client_id',
      title: 'title',
      firstName: 'first_name',
      lastName: 'last_name',
      email: 'email',
      phoneOffice: 'phone_office',
      phoneMobile: 'phone_mobile',
      fax: 'fax',
      invoiceRecipientStatus: 'invoice_recipient_status',
    },
    booleans: new Set(),
    json: new Set(),
    archive: false,
    filters: { clientId: 'client_id', updatedSince: 'updated_at' },
  },
  'expense-categories': {
    table: 'expense_categories',
    columns: {
      name: 'name',
      unitName: 'unit_name',
      unitPriceCents: 'unit_price_cents',
      isActive: 'is_active',
    },
    booleans: new Set(['isActive']),
    json: new Set(),
    archive: true,
    filters: { isActive: 'is_active', updatedSince: 'updated_at' },
  },
  projects: {
    table: 'projects',
    columns: {
      clientId: 'client_id',
      name: 'name',
      code: 'code',
      isActive: 'is_active',
      billingMethod: 'billing_method',
      billBy: 'bill_by',
      hourlyRateCents: 'hourly_rate_cents',
      feeCents: 'fee_cents',
      budgetBy: 'budget_by',
      budgetSeconds: 'budget_seconds',
      costBudgetCents: 'cost_budget_cents',
      budgetIsMonthly: 'budget_is_monthly',
      costBudgetIncludeExpenses: 'cost_budget_include_expenses',
      notifyWhenOverBudget: 'notify_when_over_budget',
      overBudgetPct: 'over_budget_pct',
      showBudgetToAll: 'show_budget_to_all',
      reportVisibility: 'report_visibility',
      startsOn: 'starts_on',
      endsOn: 'ends_on',
      notes: 'notes',
      billingCurrency: 'billing_currency',
      timeEntryNotesMinimumLength: 'time_entry_notes_minimum_length',
    },
    booleans: new Set([
      'isActive',
      'budgetIsMonthly',
      'costBudgetIncludeExpenses',
      'notifyWhenOverBudget',
      'showBudgetToAll',
    ]),
    json: new Set(),
    archive: true,
    filters: { isActive: 'is_active', clientId: 'client_id', updatedSince: 'updated_at' },
  },
  tasks: {
    table: 'tasks',
    columns: {
      name: 'name',
      billableByDefault: 'billable_by_default',
      defaultHourlyRateCents: 'default_hourly_rate_cents',
      isDefault: 'is_default',
      isActive: 'is_active',
    },
    booleans: new Set(['billableByDefault', 'isDefault', 'isActive']),
    json: new Set(),
    archive: true,
    filters: { isActive: 'is_active', updatedSince: 'updated_at' },
  },
  'task-assignments': {
    table: 'task_assignments',
    columns: {
      projectId: 'project_id',
      taskId: 'task_id',
      isActive: 'is_active',
      billable: 'billable',
      hourlyRateCents: 'hourly_rate_cents',
      budgetSeconds: 'budget_seconds',
      budgetCents: 'budget_cents',
    },
    booleans: new Set(['isActive', 'billable']),
    json: new Set(),
    archive: true,
    filters: {
      projectId: 'project_id',
      taskId: 'task_id',
      isActive: 'is_active',
      updatedSince: 'updated_at',
    },
  },
  'user-assignments': {
    table: 'user_assignments',
    columns: {
      projectId: 'project_id',
      userId: 'user_id',
      isActive: 'is_active',
      isProjectManager: 'is_project_manager',
      useDefaultRates: 'use_default_rates',
      hourlyRateCents: 'hourly_rate_cents',
      budgetSeconds: 'budget_seconds',
      timeEntryNotesMinimumLength: 'time_entry_notes_minimum_length',
    },
    booleans: new Set(['isActive', 'isProjectManager', 'useDefaultRates']),
    json: new Set(),
    archive: true,
    filters: {
      projectId: 'project_id',
      userId: 'user_id',
      isActive: 'is_active',
      updatedSince: 'updated_at',
    },
  },
  users: {
    table: 'users',
    columns: {
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
      managerGrants: 'manager_grants',
      avatarUrl: 'avatar_url',
      samlExempt: 'saml_exempt',
      isOwner: 'is_owner',
      email: '__email_relation__',
      timeEntryNotesMinimumLength: 'time_entry_notes_minimum_length',
    },
    booleans: new Set([
      'isContractor',
      'isActive',
      'hasAccessToAllFutureProjects',
      'samlExempt',
      'isOwner',
    ]),
    json: new Set(['managerGrants']),
    archive: true,
    filters: {
      isActive: 'is_active',
      updatedSince: 'updated_at',
      profile: 'profile',
      isContractor: 'is_contractor',
    },
  },
  roles: {
    table: 'roles',
    columns: { name: 'name', userIds: '__relation__' },
    booleans: new Set(),
    json: new Set(),
    archive: false,
    filters: {},
  },
}

const identifier = (name: string) => sql.identifier(name)

const isD1Client = (client: NativeClient): client is D1Database => 'batch' in client

const nativeClient = (database: Database): NativeClient =>
  (database as Database & { $client: NativeClient }).$client

const runAtomic = async (
  database: Database,
  statements: readonly AtomicStatement[],
): Promise<Record<string, unknown>[][]> => {
  const client = nativeClient(database)
  if (isD1Client(client)) {
    const results = await client.batch(
      statements.map((statement) => client.prepare(statement.text).bind(...statement.params)),
    )
    return results.map((result) => (result.results ?? []) as Record<string, unknown>[])
  }
  const execute = client.transaction(() =>
    statements.map(
      (statement) =>
        client.prepare(statement.text).all(...statement.params) as Record<string, unknown>[],
    ),
  )
  return execute.immediate()
}

const whereFor = (
  definition: ResourceDefinition,
  filters: Readonly<GeneralResourceFilters>,
  window?: Readonly<GeneralListWindow>,
): SQL => {
  const conditions: SQL[] = []
  for (const [field, column] of Object.entries(definition.filters)) {
    const value = filters[field as keyof GeneralResourceFilters]
    if (value === undefined) continue
    const stored = typeof value === 'boolean' ? (value ? 1 : 0) : value
    conditions.push(
      field === 'updatedSince'
        ? sql`${identifier(column!)} > ${stored}`
        : sql`${identifier(column!)} = ${stored}`,
    )
  }
  if (window !== undefined) {
    if (window.afterId !== null) conditions.push(sql`id > ${window.afterId}`)
    conditions.push(sql`id <= ${window.throughId}`)
  }
  return conditions.length === 0 ? sql`1` : sql.join(conditions, sql` AND `)
}

const storedValue = (
  definition: ResourceDefinition,
  field: string,
  value: GeneralValue,
): unknown => {
  if (definition.booleans.has(field)) return value === true ? 1 : 0
  if (definition.json.has(field)) return JSON.stringify(value)
  return value
}

const camelForColumn = (definition: ResourceDefinition, column: string): string => {
  if (column === 'created_at') return 'createdAt'
  if (column === 'updated_at') return 'updatedAt'
  if (column === 'harvest_id') return 'harvestId'
  return (
    Object.entries(definition.columns).find(([, candidate]) => candidate === column)?.[0] ?? column
  )
}

const recordFromRow = (
  definition: ResourceDefinition,
  row: Record<string, unknown>,
): GeneralResourceRecord => {
  const output: Record<string, GeneralValue> = {}
  for (const [column, raw] of Object.entries(row)) {
    if (column === 'statement_key') continue
    const field = camelForColumn(definition, column)
    if (definition.booleans.has(field)) output[field] = raw === 1
    else if (definition.json.has(field))
      output[field] = JSON.parse(String(raw)) as readonly string[]
    else output[field] = raw as GeneralValue
  }
  return output as GeneralResourceRecord
}

const translate = (error: unknown): never => {
  if (error instanceof GeneralResourceError) throw error
  const messages: string[] = []
  let current: unknown = error
  const seen = new Set<unknown>()
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current)
    messages.push(current instanceof Error ? current.message : String(current))
    current = typeof current === 'object' && 'cause' in current ? current.cause : undefined
  }
  const message = messages.join(': ')
  const lower = message.toLowerCase()
  if (lower.includes('foreign key'))
    throw new GeneralResourceError('invalid_reference', 'A referenced resource does not exist.')
  if (lower.includes('unique'))
    throw new GeneralResourceError('conflict', 'The resource conflicts with an existing record.')
  if (lower.includes('append-only'))
    throw new GeneralResourceError('immutable', 'Rates are append-only.')
  if (
    lower.includes('cycle') ||
    lower.includes('immutable') ||
    lower.includes('sqlite_constraint_trigger') ||
    lower.includes('must be appended') ||
    lower.includes('must be a valid date') ||
    lower.includes('derived')
  ) {
    throw new GeneralResourceError('invalid_input', message)
  }
  if (
    lower.includes('check constraint') ||
    lower.includes('not null') ||
    lower.includes('datatype mismatch')
  ) {
    throw new GeneralResourceError('invalid_input', 'The resource violates a storage invariant.')
  }
  throw error
}

const assertWindow = (window: Readonly<GeneralListWindow>): void => {
  if (
    !Number.isSafeInteger(window.throughId) ||
    window.throughId < 1 ||
    !Number.isSafeInteger(window.take) ||
    window.take < 1 ||
    (window.afterId !== null && (!Number.isSafeInteger(window.afterId) || window.afterId < 1))
  ) {
    throw new RangeError('list window must contain positive safe integers')
  }
}

const roleUsers = async (database: Database, roleId: number): Promise<readonly number[]> => {
  const rows = await database.all<{ user_id: number }>(
    sql`SELECT user_id FROM user_roles WHERE role_id = ${roleId} ORDER BY user_id`,
  )
  return rows.map(({ user_id }) => user_id)
}

const hydrateRole = async (
  database: Database,
  record: GeneralResourceRecord,
): Promise<GeneralResourceRecord> => ({
  ...record,
  userIds: await roleUsers(database, record.id),
})

const hydrateUser = async (
  database: Database,
  record: GeneralResourceRecord,
): Promise<GeneralResourceRecord> => {
  const rows = await database.all<{ address: string }>(
    sql`SELECT address FROM user_emails WHERE user_id = ${record.id} AND is_primary = 1 AND invalidated_at IS NULL LIMIT 1`,
  )
  return { ...record, email: rows[0]?.address ?? null }
}

const hydrate = async (
  database: Database,
  kind: GeneralResourceKind,
  rows: readonly Record<string, unknown>[],
): Promise<GeneralResourceRecord[]> => {
  const records = rows.map((row) => recordFromRow(definitions[kind], row))
  if (kind === 'roles') return Promise.all(records.map((record) => hydrateRole(database, record)))
  if (kind === 'users') return Promise.all(records.map((record) => hydrateUser(database, record)))
  return records
}

const validatedRoleUserIds = async (
  database: Database,
  values: GeneralValue | undefined,
): Promise<readonly number[] | undefined> => {
  if (values === undefined) return undefined
  const ids = (values as readonly string[]).map(Number)
  const existing =
    ids.length === 0
      ? []
      : await database.all<{ id: number }>(
          sql`SELECT id FROM users WHERE id IN (${sql.join(
            ids.map((id) => sql`${id}`),
            sql`, `,
          )})`,
        )
  if (existing.length !== new Set(ids).size)
    throw new GeneralResourceError(
      'invalid_reference',
      'One or more role users do not exist.',
      'userIds',
    )
  return ids
}

const validatedUserEmail = async (
  database: Database,
  userId: number,
  value: GeneralValue | undefined,
): Promise<string | undefined> => {
  if (value === undefined) return undefined
  const address = String(value)
  const current = await database.all<{ address: string }>(
    sql`SELECT address FROM user_emails WHERE user_id = ${userId} AND is_primary = 1 AND invalidated_at IS NULL LIMIT 1`,
  )
  if (current[0]?.address.toLowerCase() === address.toLowerCase()) return undefined
  const collision = await database.all<{ id: number }>(
    sql`SELECT id FROM user_emails WHERE lower(address) = lower(${address}) AND verified_at IS NOT NULL AND invalidated_at IS NULL AND user_id <> ${userId} LIMIT 1`,
  )
  if (collision.length > 0)
    throw new GeneralResourceError(
      'conflict',
      'The email address belongs to another user.',
      'email',
    )
  return address
}

export const createGeneralResourceRepository = (database: Database): GeneralResourceRepository => ({
  async highWatermark(kind, filters) {
    const definition = definitions[kind]
    const rows = await database.all<{ maximum: number | null }>(
      sql`SELECT max(id) AS maximum FROM ${identifier(definition.table)} WHERE ${whereFor(definition, filters)}`,
    )
    return rows[0]?.maximum ?? null
  },

  async list(kind, filters, window) {
    assertWindow(window)
    const definition = definitions[kind]
    const rows = await database.all<Record<string, unknown>>(
      sql`SELECT * FROM ${identifier(definition.table)} WHERE ${whereFor(definition, filters, window)} ORDER BY id LIMIT ${window.take}`,
    )
    return hydrate(database, kind, rows)
  },

  async get(kind, id) {
    const definition = definitions[kind]
    const rows = await database.all<Record<string, unknown>>(
      sql`SELECT * FROM ${identifier(definition.table)} WHERE id = ${id} LIMIT 1`,
    )
    if (rows.length === 0)
      throw new GeneralResourceError('not_found', 'The resource does not exist.')
    return (await hydrate(database, kind, rows))[0]!
  },

  async create(kind, input, now) {
    const definition = definitions[kind]
    for (const field of Object.keys(input)) {
      if (definition.columns[field] === undefined)
        throw new GeneralResourceError(
          'invalid_input',
          `${field} is not accepted by the repository.`,
          field,
        )
    }
    const relationUsers = input.userIds
    const relationEmail = input.email
    const effectiveInput: Record<string, GeneralValue> = { ...input }
    if (kind === 'users' && effectiveInput.managerGrants === undefined) {
      effectiveInput.managerGrants = []
    }
    if (kind === 'clients' && effectiveInput.currency === undefined) {
      const organizations = await database.all<{ currency: string }>(
        sql`SELECT currency FROM organizations WHERE id = 1 LIMIT 1`,
      )
      if (organizations.length === 0)
        throw new GeneralResourceError(
          'invalid_reference',
          'The organization must exist before a client is created.',
          'currency',
        )
      effectiveInput.currency = organizations[0]!.currency
    }
    if (kind === 'users' && relationEmail !== undefined) {
      const collision = await database.all<{ id: number }>(
        sql`SELECT id FROM user_emails WHERE lower(address) = lower(${String(relationEmail)}) AND verified_at IS NOT NULL AND invalidated_at IS NULL LIMIT 1`,
      )
      if (collision.length > 0)
        throw new GeneralResourceError(
          'conflict',
          'The email address belongs to another user.',
          'email',
        )
    }
    if (kind === 'task-assignments' && effectiveInput.billable === undefined) {
      const rows = await database.all<{ billable_by_default: number }>(
        sql`SELECT billable_by_default FROM tasks WHERE id = ${Number(effectiveInput.taskId)} LIMIT 1`,
      )
      if (rows.length === 0)
        throw new GeneralResourceError(
          'invalid_reference',
          'The assigned task does not exist.',
          'taskId',
        )
      effectiveInput.billable = rows[0]!.billable_by_default === 1
    }
    const roleUserIds =
      kind === 'roles' ? await validatedRoleUserIds(database, relationUsers) : undefined
    const entries = Object.entries(effectiveInput).filter(
      ([field]) => !definition.columns[field]?.startsWith('__'),
    )
    const columns = [
      ...entries.map(([field]) => identifier(definition.columns[field]!)),
      identifier('created_at'),
      identifier('updated_at'),
    ]
    const values = [
      ...entries.map(([field, value]) => sql`${storedValue(definition, field, value)}`),
      sql`${now}`,
      sql`${now}`,
    ]
    try {
      let rows: Record<string, unknown>[]
      if (kind === 'roles' || kind === 'users' || kind === 'projects') {
        const columnNames = [
          ...entries.map(([field]) => definition.columns[field]!),
          'created_at',
          'updated_at',
        ]
        const statements: AtomicStatement[] = [
          {
            text: `INSERT INTO ${definition.table} (${columnNames.join(', ')}) VALUES (${columnNames.map(() => '?').join(', ')}) RETURNING *`,
            params: [
              ...entries.map(([field, value]) => storedValue(definition, field, value)),
              now,
              now,
            ],
          },
        ]
        if (kind === 'roles' && roleUserIds !== undefined && roleUserIds.length > 0) {
          statements.push({
            text: `INSERT INTO user_roles (user_id, role_id, created_at, updated_at)
              SELECT CAST(requested.value AS INTEGER), role.id, ?, ?
              FROM json_each(?) AS requested CROSS JOIN roles AS role
              WHERE role.name = ? RETURNING user_id`,
            params: [now, now, JSON.stringify(roleUserIds), String(effectiveInput.name)],
          })
        }
        if (kind === 'users' && relationEmail !== undefined) {
          statements.push({
            text: `INSERT INTO user_emails
              (user_id, address, verified_at, is_primary, created_at, updated_at)
              VALUES (last_insert_rowid(), ?, ?, 1, ?, ?) RETURNING id`,
            params: [String(relationEmail), now, now, now],
          })
        }
        if (kind === 'projects') {
          statements.push(
            {
              text: `WITH new_project(id) AS MATERIALIZED (
                SELECT max(id) FROM projects
              )
                INSERT INTO user_assignments
                  (project_id, user_id, created_at, updated_at)
                SELECT new_project.id, user.id, ?, ?
                FROM users AS user CROSS JOIN new_project
                WHERE user.is_active = 1
                  AND user.has_access_to_all_future_projects = 1
                ORDER BY user.id RETURNING id`,
              params: [now, now],
            },
            {
              text: `WITH new_project(id) AS MATERIALIZED (
                SELECT max(id) FROM projects
              )
              INSERT INTO task_assignments
                (project_id, task_id, billable, hourly_rate_cents, created_at, updated_at)
              SELECT new_project.id, task.id, task.billable_by_default,
                task.default_hourly_rate_cents, ?, ?
              FROM tasks AS task CROSS JOIN new_project
              WHERE task.is_default = 1 AND task.is_active = 1
              ORDER BY task.id RETURNING id`,
              params: [now, now],
            },
          )
        }
        const atomicRows = await runAtomic(database, statements)
        rows = atomicRows[0] ?? []
      } else {
        rows = await database.all<Record<string, unknown>>(
          sql`INSERT INTO ${identifier(definition.table)} (${sql.join(columns, sql`, `)}) VALUES (${sql.join(values, sql`, `)}) RETURNING *`,
        )
      }
      const insertedId = Number(rows[0]!.id)
      const storedRows = await database.all<Record<string, unknown>>(
        sql`SELECT * FROM ${identifier(definition.table)} WHERE id = ${insertedId} LIMIT 1`,
      )
      const record = recordFromRow(definition, storedRows[0]!)
      if (kind === 'roles') {
        return hydrateRole(database, record)
      }
      if (kind === 'users') {
        return hydrateUser(database, record)
      }
      return record
    } catch (error) {
      return translate(error)
    }
  },

  async update(kind, id, input, now) {
    const definition = definitions[kind]
    for (const field of Object.keys(input)) {
      if (definition.columns[field] === undefined)
        throw new GeneralResourceError(
          'invalid_input',
          `${field} is not accepted by the repository.`,
          field,
        )
    }
    const relationUsers = input.userIds
    const relationEmail = input.email
    const roleUserIds =
      kind === 'roles' ? await validatedRoleUserIds(database, relationUsers) : undefined
    const emailAddress =
      kind === 'users' ? await validatedUserEmail(database, id, relationEmail) : undefined
    const storedEntries = Object.entries(input).filter(
      ([field]) => !definition.columns[field]?.startsWith('__'),
    )
    const assignments = Object.entries(input)
      .filter(([field]) => !definition.columns[field]?.startsWith('__'))
      .map(
        ([field, value]) =>
          sql`${identifier(definition.columns[field]!)} = ${storedValue(definition, field, value)}`,
      )
    assignments.push(sql`updated_at = ${now}`)
    try {
      let rows: Record<string, unknown>[]
      if (
        (kind === 'roles' && roleUserIds !== undefined) ||
        (kind === 'users' && emailAddress !== undefined)
      ) {
        const statements: AtomicStatement[] = [
          {
            text: `UPDATE ${definition.table} SET ${[
              ...storedEntries.map(([field]) => `${definition.columns[field]} = ?`),
              'updated_at = ?',
            ].join(', ')} WHERE id = ? RETURNING *`,
            params: [
              ...storedEntries.map(([field, value]) => storedValue(definition, field, value)),
              now,
              id,
            ],
          },
        ]
        if (kind === 'roles' && roleUserIds !== undefined) {
          statements.push({
            text: 'DELETE FROM user_roles WHERE role_id = ? RETURNING user_id',
            params: [id],
          })
          if (roleUserIds.length > 0) {
            statements.push({
              text: `INSERT INTO user_roles (user_id, role_id, created_at, updated_at)
                SELECT CAST(requested.value AS INTEGER), role.id, ?, ?
                FROM json_each(?) AS requested CROSS JOIN roles AS role
                WHERE role.id = ? RETURNING user_id`,
              params: [now, now, JSON.stringify(roleUserIds), id],
            })
          }
        }
        if (kind === 'users' && emailAddress !== undefined) {
          statements.push(
            {
              text: `UPDATE user_emails SET is_primary = 0, updated_at = ?
                WHERE user_id = ? AND is_primary = 1 RETURNING id`,
              params: [now, id],
            },
            {
              text: `INSERT INTO user_emails
                (user_id, address, verified_at, is_primary, created_at, updated_at)
                SELECT id, ?, ?, 1, ?, ? FROM users WHERE id = ? RETURNING id`,
              params: [emailAddress, now, now, now, id],
            },
          )
        }
        const atomicRows = await runAtomic(database, statements)
        rows = atomicRows[0] ?? []
      } else {
        rows = await database.all<Record<string, unknown>>(
          sql`UPDATE ${identifier(definition.table)} SET ${sql.join(assignments, sql`, `)} WHERE id = ${id} RETURNING *`,
        )
      }
      if (rows.length === 0)
        throw new GeneralResourceError('not_found', 'The resource does not exist.')
      const record = recordFromRow(definition, rows[0]!)
      if (kind === 'roles') {
        return hydrateRole(database, record)
      }
      if (kind === 'users') {
        return hydrateUser(database, record)
      }
      return record
    } catch (error) {
      return translate(error)
    }
  },

  async remove(kind, id, now) {
    const definition = definitions[kind]
    try {
      const rows = definition.archive
        ? await database.all(
            sql`UPDATE ${identifier(definition.table)} SET is_active = 0, updated_at = ${now} WHERE id = ${id} RETURNING id`,
          )
        : await database.all(
            sql`DELETE FROM ${identifier(definition.table)} WHERE id = ${id} RETURNING id`,
          )
      if (rows.length === 0)
        throw new GeneralResourceError('not_found', 'The resource does not exist.')
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : ''
      if (
        message.includes('foreign key') ||
        message.includes('cannot delete') ||
        message.includes('owner')
      ) {
        throw new GeneralResourceError(
          'in_use',
          'The resource cannot be deleted while it is in use.',
        )
      }
      return translate(error)
    }
  },

  async highWatermarkRates(userId, kind) {
    const users = await database.all<{ id: number }>(
      sql`SELECT id FROM users WHERE id = ${userId} LIMIT 1`,
    )
    if (users.length === 0) throw new GeneralResourceError('not_found', 'The user does not exist.')
    const table = kind === 'billable' ? 'user_billable_rates' : 'user_cost_rates'
    const rows = await database.all<{ maximum: number | null }>(
      sql`SELECT max(id) AS maximum FROM ${identifier(table)} WHERE user_id = ${userId}`,
    )
    return rows[0]?.maximum ?? null
  },

  async listRates(userId, kind, window) {
    assertWindow(window)
    const table = kind === 'billable' ? 'user_billable_rates' : 'user_cost_rates'
    const rows = await database.all<Record<string, unknown>>(
      sql`SELECT * FROM ${identifier(table)} WHERE user_id = ${userId} AND id > ${window.afterId ?? 0} AND id <= ${window.throughId} ORDER BY id LIMIT ${window.take}`,
    )
    return rows.map(rateFromRow)
  },

  async getRate(userId, kind, id) {
    const table = kind === 'billable' ? 'user_billable_rates' : 'user_cost_rates'
    const rows = await database.all<Record<string, unknown>>(
      sql`SELECT * FROM ${identifier(table)} WHERE user_id = ${userId} AND id = ${id} LIMIT 1`,
    )
    if (rows.length === 0) throw new GeneralResourceError('not_found', 'The rate does not exist.')
    return rateFromRow(rows[0]!)
  },

  async appendRate(userId, kind, input, now) {
    const table = kind === 'billable' ? 'user_billable_rates' : 'user_cost_rates'
    try {
      const rows = await database.all<Record<string, unknown>>(
        sql`INSERT INTO ${identifier(table)} (user_id, amount_cents, start_date, end_date, created_at, updated_at) VALUES (${userId}, ${input.amountCents}, ${input.startDate}, NULL, ${now}, ${now}) RETURNING *`,
      )
      return rateFromRow(rows[0]!)
    } catch (error) {
      return translate(error)
    }
  },
})

const rateFromRow = (row: Record<string, unknown>): UserRateRecord => ({
  id: Number(row.id),
  harvestId: row.harvest_id as number | null,
  userId: Number(row.user_id),
  amountCents: Number(row.amount_cents),
  startDate: row.start_date as string | null,
  endDate: row.end_date as string | null,
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
})
