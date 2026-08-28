import { sql } from 'drizzle-orm'
import {
  type AnySQLiteColumn,
  check,
  foreignKey,
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

export const projects = sqliteTable(
  'projects',
  {
    id: integer('id').primaryKey(),
    harvestId: integer('harvest_id'),
    clientId: integer('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    code: text('code').notNull().default(''),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    billingMethod: text('billing_method', {
      enum: ['non_billable', 'time_materials', 'fixed_fee'],
    })
      .notNull()
      .default('time_materials'),
    billBy: text('bill_by', { enum: ['project', 'tasks', 'people', 'none'] })
      .notNull()
      .default('project'),
    hourlyRateCents: integer('hourly_rate_cents'),
    feeCents: integer('fee_cents'),
    budgetBy: text('budget_by', {
      enum: ['project', 'project_cost', 'task', 'task_fees', 'person', 'none'],
    })
      .notNull()
      .default('none'),
    budgetSeconds: integer('budget_seconds'),
    costBudgetCents: integer('cost_budget_cents'),
    budgetIsMonthly: integer('budget_is_monthly', { mode: 'boolean' }).notNull().default(false),
    costBudgetIncludeExpenses: integer('cost_budget_include_expenses', { mode: 'boolean' })
      .notNull()
      .default(false),
    notifyWhenOverBudget: integer('notify_when_over_budget', { mode: 'boolean' })
      .notNull()
      .default(false),
    overBudgetPct: real('over_budget_pct'),
    overBudgetNotifiedOn: text('over_budget_notified_on'),
    showBudgetToAll: integer('show_budget_to_all', { mode: 'boolean' }).notNull().default(false),
    reportVisibility: text('report_visibility', { enum: ['managers', 'everyone'] })
      .notNull()
      .default('managers'),
    startsOn: text('starts_on'),
    endsOn: text('ends_on'),
    notes: text('notes'),
    billingCurrency: text('billing_currency'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('projects_harvest_id_unique').on(table.harvestId),
    index('projects_client_id').on(table.clientId),
    check('projects_is_active_boolean', sql`${table.isActive} in (0, 1)`),
    check(
      'projects_hourly_rate_nonnegative',
      sql`${table.hourlyRateCents} is null or ${table.hourlyRateCents} >= 0`,
    ),
    check('projects_fee_nonnegative', sql`${table.feeCents} is null or ${table.feeCents} >= 0`),
    check(
      'projects_budget_seconds_nonnegative',
      sql`${table.budgetSeconds} is null or ${table.budgetSeconds} >= 0`,
    ),
    check(
      'projects_cost_budget_nonnegative',
      sql`${table.costBudgetCents} is null or ${table.costBudgetCents} >= 0`,
    ),
    check('projects_budget_monthly_boolean', sql`${table.budgetIsMonthly} in (0, 1)`),
    check('projects_budget_expenses_boolean', sql`${table.costBudgetIncludeExpenses} in (0, 1)`),
    check('projects_notify_over_budget_boolean', sql`${table.notifyWhenOverBudget} in (0, 1)`),
    check(
      'projects_over_budget_pct_nonnegative',
      sql`${table.overBudgetPct} is null or ${table.overBudgetPct} >= 0`,
    ),
    check('projects_show_budget_boolean', sql`${table.showBudgetToAll} in (0, 1)`),
  ],
)

export const projectTags = sqliteTable('project_tags', {
  id: integer('id').primaryKey(),
  name: text('name').notNull().unique(),
  ...timestamps,
})

export const projectTagAssignments = sqliteTable(
  'project_tag_assignments',
  {
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    projectTagId: integer('project_tag_id')
      .notNull()
      .references(() => projectTags.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.projectTagId] }),
    index('project_tag_assignments_tag_id').on(table.projectTagId),
  ],
)

export const projectMilestones = sqliteTable(
  'project_milestones',
  {
    id: integer('id').primaryKey(),
    harvestId: integer('harvest_id'),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    amountCents: integer('amount_cents').notNull(),
    dueOn: text('due_on'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('project_milestones_harvest_id_unique').on(table.harvestId),
    index('project_milestones_project_id').on(table.projectId),
    check('project_milestones_amount_nonnegative', sql`${table.amountCents} >= 0`),
  ],
)

export const tasks = sqliteTable(
  'tasks',
  {
    id: integer('id').primaryKey(),
    harvestId: integer('harvest_id'),
    name: text('name').notNull(),
    billableByDefault: integer('billable_by_default', { mode: 'boolean' }).notNull().default(true),
    defaultHourlyRateCents: integer('default_hourly_rate_cents'),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('tasks_harvest_id_unique').on(table.harvestId),
    check('tasks_billable_default_boolean', sql`${table.billableByDefault} in (0, 1)`),
    check(
      'tasks_default_rate_nonnegative',
      sql`${table.defaultHourlyRateCents} is null or ${table.defaultHourlyRateCents} >= 0`,
    ),
    check('tasks_is_default_boolean', sql`${table.isDefault} in (0, 1)`),
    check('tasks_is_active_boolean', sql`${table.isActive} in (0, 1)`),
  ],
)

export const taskAssignments = sqliteTable(
  'task_assignments',
  {
    id: integer('id').primaryKey(),
    harvestId: integer('harvest_id'),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    taskId: integer('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict' }),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    billable: integer('billable', { mode: 'boolean' }).notNull(),
    hourlyRateCents: integer('hourly_rate_cents'),
    budgetSeconds: integer('budget_seconds'),
    budgetCents: integer('budget_cents'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('task_assignments_harvest_id_unique').on(table.harvestId),
    uniqueIndex('task_assignments_project_task_unique').on(table.projectId, table.taskId),
    uniqueIndex('task_assignments_id_project_task_unique').on(
      table.id,
      table.projectId,
      table.taskId,
    ),
    index('task_assignments_task_id').on(table.taskId),
    check('task_assignments_is_active_boolean', sql`${table.isActive} in (0, 1)`),
    check('task_assignments_billable_boolean', sql`${table.billable} in (0, 1)`),
    check(
      'task_assignments_rate_nonnegative',
      sql`${table.hourlyRateCents} is null or ${table.hourlyRateCents} >= 0`,
    ),
    check(
      'task_assignments_budget_seconds_nonnegative',
      sql`${table.budgetSeconds} is null or ${table.budgetSeconds} >= 0`,
    ),
    check(
      'task_assignments_budget_cents_nonnegative',
      sql`${table.budgetCents} is null or ${table.budgetCents} >= 0`,
    ),
  ],
)

export const userAssignments = sqliteTable(
  'user_assignments',
  {
    id: integer('id').primaryKey(),
    harvestId: integer('harvest_id'),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    isProjectManager: integer('is_project_manager', { mode: 'boolean' }).notNull().default(false),
    useDefaultRates: integer('use_default_rates', { mode: 'boolean' }).notNull().default(true),
    hourlyRateCents: integer('hourly_rate_cents'),
    budgetSeconds: integer('budget_seconds'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('user_assignments_harvest_id_unique').on(table.harvestId),
    uniqueIndex('user_assignments_project_user_unique').on(table.projectId, table.userId),
    uniqueIndex('user_assignments_id_project_user_unique').on(
      table.id,
      table.projectId,
      table.userId,
    ),
    index('user_assignments_user_id').on(table.userId),
    check('user_assignments_is_active_boolean', sql`${table.isActive} in (0, 1)`),
    check('user_assignments_manager_boolean', sql`${table.isProjectManager} in (0, 1)`),
    check('user_assignments_default_rates_boolean', sql`${table.useDefaultRates} in (0, 1)`),
    check(
      'user_assignments_rate_nonnegative',
      sql`${table.hourlyRateCents} is null or ${table.hourlyRateCents} >= 0`,
    ),
    check(
      'user_assignments_budget_nonnegative',
      sql`${table.budgetSeconds} is null or ${table.budgetSeconds} >= 0`,
    ),
  ],
)

export const timeEntries = sqliteTable(
  'time_entries',
  {
    id: integer('id').primaryKey(),
    harvestId: text('harvest_id'),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    taskId: integer('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict' }),
    userAssignmentId: integer('user_assignment_id').notNull(),
    taskAssignmentId: integer('task_assignment_id').notNull(),
    spentDate: text('spent_date').notNull(),
    seconds: integer('seconds').notNull(),
    secondsWithoutTimer: integer('seconds_without_timer').notNull(),
    roundedSeconds: integer('rounded_seconds').notNull(),
    timerStartedAt: text('timer_started_at'),
    startedTime: text('started_time'),
    endedTime: text('ended_time'),
    notes: text('notes'),
    billable: integer('billable', { mode: 'boolean' }).notNull(),
    budgeted: integer('budgeted', { mode: 'boolean' }).notNull().default(false),
    billableRateCents: integer('billable_rate_cents'),
    costRateCents: integer('cost_rate_cents'),
    externalRef: text('external_ref', { mode: 'json' }).$type<Record<string, unknown>>(),
    calendarEventRef: text('calendar_event_ref', { mode: 'json' }).$type<Record<string, unknown>>(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('time_entries_harvest_id_unique').on(table.harvestId),
    index('time_entries_user_spent_date').on(table.userId, table.spentDate),
    index('time_entries_project_spent_date').on(table.projectId, table.spentDate),
    index('time_entries_external_ref_id')
      .on(sql`cast(json_extract(${table.externalRef}, '$.id') as text)`)
      .where(sql`${table.externalRef} is not null`),
    uniqueIndex('time_entries_one_running_per_user')
      .on(table.userId)
      .where(
        sql`${table.timerStartedAt} is not null or (${table.startedTime} is not null and ${table.endedTime} is null)`,
      ),
    foreignKey({
      columns: [table.userAssignmentId, table.projectId, table.userId],
      foreignColumns: [userAssignments.id, userAssignments.projectId, userAssignments.userId],
      name: 'time_entries_user_assignment_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.taskAssignmentId, table.projectId, table.taskId],
      foreignColumns: [taskAssignments.id, taskAssignments.projectId, taskAssignments.taskId],
      name: 'time_entries_task_assignment_fk',
    }).onDelete('restrict'),
    check(
      'time_entries_seconds_safe',
      sql`${table.seconds} between 0 and 9007199254740991`,
    ),
    check(
      'time_entries_checkpoint_safe',
      sql`${table.secondsWithoutTimer} between 0 and 9007199254740991`,
    ),
    check(
      'time_entries_rounded_safe',
      sql`${table.roundedSeconds} between 0 and 9007199254740991`,
    ),
    check('time_entries_billable_boolean', sql`${table.billable} in (0, 1)`),
    check('time_entries_budgeted_boolean', sql`${table.budgeted} in (0, 1)`),
    check(
      'time_entries_billable_rate_nonnegative',
      sql`${table.billableRateCents} is null or ${table.billableRateCents} >= 0`,
    ),
    check(
      'time_entries_cost_rate_nonnegative',
      sql`${table.costRateCents} is null or ${table.costRateCents} >= 0`,
    ),
    check(
      'time_entries_external_ref_json',
      sql`${table.externalRef} is null or json_valid(${table.externalRef})`,
    ),
    check(
      'time_entries_calendar_ref_json',
      sql`${table.calendarEventRef} is null or json_valid(${table.calendarEventRef})`,
    ),
    check(
      'time_entries_shape',
      sql`${table.timerStartedAt} is null or (${table.startedTime} is null and ${table.endedTime} is null)`,
    ),
    check(
      'time_entries_timer_started_at_canonical',
      sql`${table.timerStartedAt} is null or (
        unixepoch(${table.timerStartedAt}) is not null
        and substr(${table.timerStartedAt}, 1, 19)
          = strftime('%Y-%m-%dT%H:%M:%S', ${table.timerStartedAt})
        and cast(substr(${table.timerStartedAt}, 12, 2) as integer) between 0 and 23
        and cast(substr(${table.timerStartedAt}, 15, 2) as integer) between 0 and 59
        and cast(substr(${table.timerStartedAt}, 18, 2) as integer) between 0 and 59
        and (
          ${table.timerStartedAt} glob '????-??-??T??:??:??Z'
          or ${table.timerStartedAt} glob '????-??-??T??:??:??.[0-9]Z'
          or ${table.timerStartedAt} glob '????-??-??T??:??:??.[0-9][0-9]Z'
          or ${table.timerStartedAt} glob '????-??-??T??:??:??.[0-9][0-9][0-9]Z'
        )
      )`,
    ),
    check(
      'time_entries_ended_requires_started',
      sql`${table.endedTime} is null or ${table.startedTime} is not null`,
    ),
    check(
      'time_entries_stopped_checkpoint',
      sql`${table.timerStartedAt} is not null or (${table.startedTime} is not null and ${table.endedTime} is null) or ${table.secondsWithoutTimer} = ${table.seconds}`,
    ),
  ],
)

export const timeEntryRateReprices = sqliteTable(
  'time_entry_rate_reprices',
  {
    id: integer('id').primaryKey(),
    timeEntryId: integer('time_entry_id')
      .notNull()
      .references(() => timeEntries.id, { onDelete: 'restrict' }),
    previousBillableRateCents: integer('previous_billable_rate_cents'),
    billableRateCents: integer('billable_rate_cents'),
    previousCostRateCents: integer('previous_cost_rate_cents'),
    costRateCents: integer('cost_rate_cents'),
    reason: text('reason').notNull(),
    repricedAt: text('repriced_at').notNull(),
  },
  (table) => [
    index('time_entry_rate_reprices_entry_id').on(table.timeEntryId, table.id),
    check(
      'time_entry_rate_reprices_previous_billable_nonnegative',
      sql`${table.previousBillableRateCents} is null or ${table.previousBillableRateCents} >= 0`,
    ),
    check(
      'time_entry_rate_reprices_billable_nonnegative',
      sql`${table.billableRateCents} is null or ${table.billableRateCents} >= 0`,
    ),
    check(
      'time_entry_rate_reprices_previous_cost_nonnegative',
      sql`${table.previousCostRateCents} is null or ${table.previousCostRateCents} >= 0`,
    ),
    check(
      'time_entry_rate_reprices_cost_nonnegative',
      sql`${table.costRateCents} is null or ${table.costRateCents} >= 0`,
    ),
    check(
      'time_entry_rate_reprices_reason_present',
      sql`length(trim(${table.reason})) between 1 and 500`,
    ),
    check(
      'time_entry_rate_reprices_timestamp_canonical',
      sql`unixepoch(${table.repricedAt}) is not null
        and substr(${table.repricedAt}, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', ${table.repricedAt})
        and cast(substr(${table.repricedAt}, 12, 2) as integer) between 0 and 23
        and cast(substr(${table.repricedAt}, 15, 2) as integer) between 0 and 59
        and cast(substr(${table.repricedAt}, 18, 2) as integer) between 0 and 59
        and ${table.repricedAt} glob '????-??-??T??:??:??.[0-9][0-9][0-9]Z'`,
    ),
  ],
)
