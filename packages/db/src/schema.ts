import { sql } from 'drizzle-orm'
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  sqliteView,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

const timestamps = {
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}

export const organizations = sqliteTable(
  'organizations',
  {
    id: integer('id').primaryKey().default(1),
    name: text('name').notNull(),
    address: text('address'),
    weekStartDay: text('week_start_day', { enum: ['saturday', 'sunday', 'monday'] })
      .notNull()
      .default('monday'),
    timeEntryMode: text('time_entry_mode', { enum: ['duration', 'start_end'] })
      .notNull()
      .default('duration'),
    timeFormat: text('time_format', { enum: ['decimal', 'hours_minutes'] })
      .notNull()
      .default('decimal'),
    clock: text('clock', { enum: ['12h', '24h'] }).notNull().default('12h'),
    dateFormat: text('date_format').notNull().default('%Y-%m-%d'),
    currency: text('currency').notNull().default('USD'),
    currencyCodeDisplay: text('currency_code_display', {
      enum: ['iso_code_none', 'iso_code_before', 'iso_code_after'],
    })
      .notNull()
      .default('iso_code_after'),
    currencySymbolDisplay: text('currency_symbol_display', {
      enum: ['symbol_none', 'symbol_before', 'symbol_after'],
    })
      .notNull()
      .default('symbol_before'),
    decimalSymbol: text('decimal_symbol').notNull().default('.'),
    thousandsSeparator: text('thousands_separator').notNull().default(','),
    weeklyCapacityDefault: integer('weekly_capacity_default').notNull().default(126_000),
    fiscalYearStartMonth: integer('fiscal_year_start_month').notNull().default(1),
    timesheetDeadline: text('timesheet_deadline', { mode: 'json' })
      .$type<{ day: string; time: string } | null>(),
    reminderPolicy: text('reminder_policy', { mode: 'json' }).$type<Record<string, unknown>>(),
    autoLock: integer('auto_lock', { mode: 'boolean' }).notNull().default(false),
    autoSubmit: integer('auto_submit', { mode: 'boolean' }).notNull().default(false),
    timeEntryNotesRequired: integer('time_entry_notes_required', { mode: 'boolean' })
      .notNull()
      .default(false),
    timeRounding: text('time_rounding', {
      enum: ['none', 'nearest_6', 'nearest_15', 'nearest_30', 'up_6', 'up_15', 'up_30'],
    })
      .notNull()
      .default('none'),
    modules: text('modules', { mode: 'json' }).$type<Record<string, boolean>>().notNull(),
    require2fa: integer('require_2fa', { mode: 'boolean' }).notNull().default(false),
    requireSso: integer('require_sso', { mode: 'boolean' }).notNull().default(false),
    ...timestamps,
  },
  (table) => [
    check('organizations_singleton', sql`${table.id} = 1`),
    check(
      'organizations_fiscal_month',
      sql`${table.fiscalYearStartMonth} between 1 and 12`,
    ),
    check('organizations_capacity_nonnegative', sql`${table.weeklyCapacityDefault} >= 0`),
    check('organizations_modules_json', sql`json_valid(${table.modules})`),
    check(
      'organizations_timesheet_deadline_json',
      sql`${table.timesheetDeadline} is null or json_valid(${table.timesheetDeadline})`,
    ),
    check(
      'organizations_reminder_policy_json',
      sql`${table.reminderPolicy} is null or json_valid(${table.reminderPolicy})`,
    ),
  ],
)

export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey(),
    harvestId: integer('harvest_id'),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    telephone: text('telephone'),
    employeeId: text('employee_id'),
    timezone: text('timezone').notNull().default('UTC'),
    isContractor: integer('is_contractor', { mode: 'boolean' }).notNull().default(false),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    hasAccessToAllFutureProjects: integer('has_access_to_all_future_projects', {
      mode: 'boolean',
    })
      .notNull()
      .default(false),
    weeklyCapacity: integer('weekly_capacity').notNull().default(126_000),
    profile: text('profile', {
      enum: [
        'member',
        'project_manager',
        'people_admin',
        'accounting',
        'executive_manager',
        'administrator',
      ],
    })
      .notNull()
      .default('member'),
    managerGrants: text('manager_grants', { mode: 'json' }).$type<string[]>().notNull(),
    isOwner: integer('is_owner', { mode: 'boolean' }).notNull().default(false),
    avatarUrl: text('avatar_url'),
    samlExempt: integer('saml_exempt', { mode: 'boolean' }).notNull().default(false),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('users_harvest_id_unique').on(table.harvestId),
    uniqueIndex('users_single_owner').on(table.isOwner).where(sql`${table.isOwner} = 1`),
    check('users_capacity_nonnegative', sql`${table.weeklyCapacity} >= 0`),
    check('users_manager_grants_json', sql`json_valid(${table.managerGrants})`),
    check('users_is_contractor_boolean', sql`${table.isContractor} in (0, 1)`),
    check('users_is_active_boolean', sql`${table.isActive} in (0, 1)`),
    check(
      'users_future_projects_boolean',
      sql`${table.hasAccessToAllFutureProjects} in (0, 1)`,
    ),
    check('users_is_owner_boolean', sql`${table.isOwner} in (0, 1)`),
    check('users_saml_exempt_boolean', sql`${table.samlExempt} in (0, 1)`),
    check(
      'users_owner_is_administrator',
      sql`${table.isOwner} = 0 or ${table.profile} = 'administrator'`,
    ),
  ],
)

export const userEmails = sqliteTable(
  'user_emails',
  {
    id: integer('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    address: text('address').notNull(),
    verifiedAt: text('verified_at'),
    isPrimary: integer('is_primary', { mode: 'boolean' }).notNull().default(false),
    invalidatedAt: text('invalidated_at'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('user_emails_verified_address_unique')
      .on(sql`lower(${table.address})`)
      .where(sql`${table.verifiedAt} is not null and ${table.invalidatedAt} is null`),
    uniqueIndex('user_emails_one_primary_per_user')
      .on(table.userId)
      .where(sql`${table.isPrimary} = 1 and ${table.invalidatedAt} is null`),
    index('user_emails_user_id').on(table.userId),
    check(
      'user_emails_primary_is_verified',
      sql`${table.isPrimary} = 0 or (${table.verifiedAt} is not null and ${table.invalidatedAt} is null)`,
    ),
    check('user_emails_is_primary_boolean', sql`${table.isPrimary} in (0, 1)`),
  ],
)

export const organizationOwner = sqliteTable(
  'organization_owner',
  {
    id: integer('id').primaryKey().default(1),
    userId: integer('user_id')
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'restrict' }),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [check('organization_owner_singleton', sql`${table.id} = 1`)],
)

export const userIdentities = sqliteTable(
  'user_identities',
  {
    id: integer('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    providerSubject: text('provider_subject').notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('user_identities_provider_subject_unique').on(
      table.provider,
      table.providerSubject,
    ),
    index('user_identities_user_id').on(table.userId),
  ],
)

export const roles = sqliteTable('roles', {
  id: integer('id').primaryKey(),
  harvestId: integer('harvest_id').unique(),
  name: text('name').notNull().unique(),
  ...timestamps,
})

export const departments = sqliteTable('departments', {
  id: integer('id').primaryKey(),
  name: text('name').notNull().unique(),
  ...timestamps,
})

export const userRoles = sqliteTable(
  'user_roles',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: integer('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (table) => [primaryKey({ columns: [table.userId, table.roleId] })],
)

export const userDepartments = sqliteTable(
  'user_departments',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    departmentId: integer('department_id')
      .notNull()
      .references(() => departments.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (table) => [primaryKey({ columns: [table.userId, table.departmentId] })],
)

export const teammateAssignments = sqliteTable(
  'teammate_assignments',
  {
    managerId: integer('manager_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.managerId, table.userId] }),
    check('teammate_assignments_not_self', sql`${table.managerId} <> ${table.userId}`),
  ],
)

const rateColumns = () => ({
  id: integer('id').primaryKey(),
  harvestId: integer('harvest_id').unique(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
  amountCents: integer('amount_cents').notNull(),
  startDate: text('start_date'),
  endDate: text('end_date'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const userBillableRates = sqliteTable(
  'user_billable_rates',
  rateColumns(),
  (table) => [
    uniqueIndex('user_billable_rates_user_start_unique').on(table.userId, table.startDate),
    index('user_billable_rates_user_id').on(table.userId),
    check('user_billable_rates_amount_nonnegative', sql`${table.amountCents} >= 0`),
  ],
)

export const userCostRates = sqliteTable('user_cost_rates', rateColumns(), (table) => [
  uniqueIndex('user_cost_rates_user_start_unique').on(table.userId, table.startDate),
  index('user_cost_rates_user_id').on(table.userId),
  check('user_cost_rates_amount_nonnegative', sql`${table.amountCents} >= 0`),
])

export const clients = sqliteTable(
  'clients',
  {
    id: integer('id').primaryKey(),
    harvestId: integer('harvest_id'),
    name: text('name').notNull(),
    address: text('address'),
    currency: text('currency').notNull(),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    parentClientId: integer('parent_client_id').references((): AnySQLiteColumn => clients.id, {
      onDelete: 'restrict',
    }),
    billToClientId: integer('bill_to_client_id').references((): AnySQLiteColumn => clients.id, {
      onDelete: 'restrict',
    }),
    statementKey: text('statement_key')
      .notNull()
      .default(sql`lower(hex(randomblob(32)))`),
    paymentTerms: text('payment_terms', {
      enum: ['upon_receipt', 'net_15', 'net_30', 'net_45', 'net_60', 'custom'],
    })
      .notNull()
      .default('custom'),
    defaultTaxPct: real('default_tax_pct'),
    defaultTax2Pct: real('default_tax2_pct'),
    defaultDiscountPct: real('default_discount_pct'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('clients_harvest_id_unique').on(table.harvestId),
    uniqueIndex('clients_statement_key_unique').on(table.statementKey),
    index('clients_parent_client_id').on(table.parentClientId),
    index('clients_bill_to_client_id').on(table.billToClientId),
    check('clients_is_active_boolean', sql`${table.isActive} in (0, 1)`),
  ],
)

// Full closure relation for ad hoc joins and schema consumers. Hot rooted traversal
// should use listClientDescendants so SQLite anchors at one client.
export const clientHierarchy = sqliteView('client_hierarchy', {
  ancestorId: integer('ancestor_id').notNull(),
  descendantId: integer('descendant_id').notNull(),
  depth: integer('depth').notNull(),
}).as(sql`
  WITH RECURSIVE hierarchy(ancestor_id, descendant_id, depth, visited) AS (
    SELECT id, id, 0, printf(',%d,', id) FROM clients
    UNION ALL
    SELECT hierarchy.ancestor_id, child.id, hierarchy.depth + 1,
      hierarchy.visited || child.id || ','
    FROM hierarchy
    JOIN clients child ON child.parent_client_id = hierarchy.descendant_id
    WHERE instr(hierarchy.visited, printf(',%d,', child.id)) = 0
  )
  SELECT ancestor_id, descendant_id, depth FROM hierarchy
`)

export const contacts = sqliteTable(
  'contacts',
  {
    id: integer('id').primaryKey(),
    harvestId: integer('harvest_id'),
    clientId: integer('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    title: text('title'),
    firstName: text('first_name').notNull(),
    lastName: text('last_name'),
    email: text('email'),
    phoneOffice: text('phone_office'),
    phoneMobile: text('phone_mobile'),
    fax: text('fax'),
    invoiceRecipientStatus: text('invoice_recipient_status', {
      enum: ['none', 'recipient', 'cc', 'bcc'],
    })
      .notNull()
      .default('none'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('contacts_harvest_id_unique').on(table.harvestId),
    index('contacts_client_id').on(table.clientId),
  ],
)
