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
import type { RecurringAmountConfig } from './recurring-invoices.js'

const timestamps = {
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}

const canonicalTimestamp = (column: AnySQLiteColumn) => sql`unixepoch(${column}) is not null
  and substr(${column}, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', ${column})
  and cast(substr(${column}, 12, 2) as integer) between 0 and 23
  and cast(substr(${column}, 15, 2) as integer) between 0 and 59
  and cast(substr(${column}, 18, 2) as integer) between 0 and 59
  and (
    ${column} glob '????-??-??T??:??:??Z'
    or ${column} glob '????-??-??T??:??:??.[0-9]Z'
    or ${column} glob '????-??-??T??:??:??.[0-9][0-9]Z'
    or ${column} glob '????-??-??T??:??:??.[0-9][0-9][0-9]Z'
  )`

const nullableCanonicalTimestamp = (column: AnySQLiteColumn) =>
  sql`${column} is null or (${canonicalTimestamp(column)})`

const nonBlankText = (column: AnySQLiteColumn) => sql`length(trim(${column},
  char(9) || char(10) || char(11) || char(12) || char(13) || char(32) || char(160)
  || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196)
  || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202)
  || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279)
)) > 0`

export type InvoicePaymentOption =
  | 'stripe_checkout'
  | 'paypal_checkout'
  | 'quickbooks_checkout'
  | 'mercury_transfer'
  | 'wise_transfer'
  | 'bill_com_checkout'
  | 'bill_com_transfer'

export interface InvoiceReminderPolicy {
  first_after_days: number
  every_days: number
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
    clock: text('clock', { enum: ['12h', '24h'] })
      .notNull()
      .default('12h'),
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
    timesheetDeadline: text('timesheet_deadline', { mode: 'json' }).$type<{
      day: string
      time: string
    } | null>(),
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
    check('organizations_fiscal_month', sql`${table.fiscalYearStartMonth} between 1 and 12`),
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
    uniqueIndex('users_single_owner')
      .on(table.isOwner)
      .where(sql`${table.isOwner} = 1`),
    check('users_capacity_nonnegative', sql`${table.weeklyCapacity} >= 0`),
    check('users_manager_grants_json', sql`json_valid(${table.managerGrants})`),
    check('users_is_contractor_boolean', sql`${table.isContractor} in (0, 1)`),
    check('users_is_active_boolean', sql`${table.isActive} in (0, 1)`),
    check('users_future_projects_boolean', sql`${table.hasAccessToAllFutureProjects} in (0, 1)`),
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

export const userBillableRates = sqliteTable('user_billable_rates', rateColumns(), (table) => [
  uniqueIndex('user_billable_rates_user_start_unique').on(table.userId, table.startDate),
  index('user_billable_rates_user_id').on(table.userId),
  check('user_billable_rates_amount_nonnegative', sql`${table.amountCents} >= 0`),
])

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

export const retainers = sqliteTable(
  'retainers',
  {
    id: integer('id').primaryKey(),
    harvestId: integer('harvest_id'),
    clientId: integer('client_id').references(() => clients.id, { onDelete: 'restrict' }),
    projectId: integer('project_id').references(() => projects.id, { onDelete: 'restrict' }),
    state: text('state', { enum: ['ongoing', 'closed'] })
      .notNull()
      .default('ongoing'),
    denomination: text('denomination', { enum: ['money', 'hours'] }).notNull(),
    amountCents: integer('amount_cents'),
    seconds: integer('seconds'),
    lockedRateCents: integer('locked_rate_cents'),
    rateLockedAt: text('rate_locked_at'),
    period: text('period'),
    rollover: text('rollover', { enum: ['carry', 'expire', 'cap'] }),
    expiresAt: text('expires_at'),
    onExhaustion: text('on_exhaustion', { enum: ['block', 'warn', 'overflow'] })
      .notNull()
      .default('block'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('retainers_harvest_id_unique').on(table.harvestId),
    index('retainers_client_id').on(table.clientId),
    index('retainers_project_id').on(table.projectId),
    check(
      'retainers_harvest_id_safe_integer',
      sql`${table.harvestId} is null or ${table.harvestId} between 1 and 9007199254740991`,
    ),
    check('retainers_state', sql`${table.state} in ('ongoing','closed')`),
    check('retainers_denomination', sql`${table.denomination} in ('money','hours')`),
    check(
      'retainers_denomination_shape',
      sql`(${table.denomination} = 'money'
          and ${table.amountCents} between 0 and 9000000000000
          and ${table.seconds} is null
          and ${table.lockedRateCents} is null
          and ${table.rateLockedAt} is null)
        or (${table.denomination} = 'hours'
          and ${table.amountCents} is null
          and ${table.seconds} between 0 and 9007199254740991
          and ((${table.lockedRateCents} is null and ${table.rateLockedAt} is null)
            or (${table.lockedRateCents} between 0 and 9000000000000
              and ${table.rateLockedAt} is not null)))`,
    ),
    check(
      'retainers_period_nonempty',
      sql`${table.period} is null or length(trim(${table.period})) between 1 and 64`,
    ),
    check(
      'retainers_rollover',
      sql`${table.rollover} is null or ${table.rollover} in ('carry','expire','cap')`,
    ),
    check('retainers_on_exhaustion', sql`${table.onExhaustion} in ('block','warn','overflow')`),
    check(
      'retainers_expires_at_canonical',
      sql`${table.expiresAt} is null or date(${table.expiresAt}) is ${table.expiresAt}`,
    ),
    check('retainers_rate_locked_at_canonical', nullableCanonicalTimestamp(table.rateLockedAt)),
    check('retainers_created_at_canonical', canonicalTimestamp(table.createdAt)),
    check('retainers_updated_at_canonical', canonicalTimestamp(table.updatedAt)),
  ],
)

export const recurringInvoices = sqliteTable(
  'recurring_invoices',
  {
    id: integer('id').primaryKey(),
    harvestId: integer('harvest_id'),
    clientId: integer('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    definitionStatus: text('definition_status', { enum: ['complete', 'incomplete'] })
      .notNull()
      .default('complete'),
    subjectTemplate: text('subject_template'),
    notesTemplate: text('notes_template'),
    everyNMonths: integer('every_n_months'),
    dayOfMonth: integer('day_of_month'),
    nextIssueOn: text('next_issue_on'),
    amountConfig: text('amount_config', { mode: 'json' }).$type<RecurringAmountConfig>(),
    canDrawFromRetainerId: integer('can_draw_from_retainer_id').references(() => retainers.id, {
      onDelete: 'restrict',
    }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('recurring_invoices_harvest_id_unique').on(table.harvestId),
    index('recurring_invoices_client_id').on(table.clientId),
    index('recurring_invoices_retainer_id')
      .on(table.canDrawFromRetainerId)
      .where(sql`${table.canDrawFromRetainerId} is not null`),
    check(
      'recurring_invoices_harvest_id_safe_integer',
      sql`${table.harvestId} is null or ${table.harvestId} between 1 and 9007199254740991`,
    ),
    check(
      'recurring_invoices_definition_shape',
      sql`(${table.definitionStatus} = 'complete'
          and ${table.subjectTemplate} is not null
          and ${nonBlankText(table.subjectTemplate)}
          and ${table.notesTemplate} is not null
          and ${table.everyNMonths} between 1 and 9007199254740991
          and ${table.dayOfMonth} between 1 and 31
          and ${table.nextIssueOn} is not null
          and date(${table.nextIssueOn}, '+0 days') is ${table.nextIssueOn}
          and ${table.amountConfig} is not null
          and json_valid(${table.amountConfig})
          and json_type(${table.amountConfig}) = 'object')
        or (${table.definitionStatus} = 'incomplete'
          and ${table.harvestId} is not null
          and ${table.subjectTemplate} is null
          and ${table.notesTemplate} is null
          and ${table.everyNMonths} is null
          and ${table.dayOfMonth} is null
          and ${table.nextIssueOn} is null
          and ${table.amountConfig} is null
          and ${table.canDrawFromRetainerId} is null)`,
    ),
    check('recurring_invoices_created_at_canonical', canonicalTimestamp(table.createdAt)),
    check('recurring_invoices_updated_at_canonical', canonicalTimestamp(table.updatedAt)),
  ],
)

export const invoices = sqliteTable(
  'invoices',
  {
    id: integer('id').primaryKey(),
    harvestId: integer('harvest_id'),
    clientId: integer('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    createdByUserId: integer('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    sourceCreatorId: integer('source_creator_id'),
    sourceCreatorName: text('source_creator_name'),
    number: text('number').notNull(),
    subject: text('subject'),
    purchaseOrder: text('purchase_order'),
    notes: text('notes'),
    currency: text('currency').notNull(),
    issueDate: text('issue_date').notNull(),
    dueDate: text('due_date').notNull(),
    paymentTerms: text('payment_terms', {
      enum: ['upon_receipt', 'net_15', 'net_30', 'net_45', 'net_60', 'custom'],
    })
      .notNull()
      .default('custom'),
    state: text('state', { enum: ['draft', 'open', 'paid', 'closed'] })
      .notNull()
      .default('draft'),
    version: integer('version').notNull().default(0),
    closeReason: text('close_reason', {
      enum: ['cancelled', 'written_off', 'source_closed'],
    }),
    closeWriteOffCents: integer('close_write_off_cents').notNull().default(0),
    sentAt: text('sent_at'),
    paidAt: text('paid_at'),
    paidDate: text('paid_date'),
    closedAt: text('closed_at'),
    periodStart: text('period_start'),
    periodEnd: text('period_end'),
    clientKey: text('client_key')
      .notNull()
      .default(sql`lower(hex(randomblob(32)))`),
    projectId: integer('project_id').references(() => projects.id, { onDelete: 'restrict' }),
    retainerId: integer('retainer_id').references(() => retainers.id, { onDelete: 'restrict' }),
    recurringInvoiceId: integer('recurring_invoice_id').references(() => recurringInvoices.id, {
      onDelete: 'restrict',
    }),
    reminderPolicy: text('reminder_policy', { mode: 'json' }).$type<InvoiceReminderPolicy>(),
    taxRatePpm: integer('tax_rate_ppm'),
    tax2RatePpm: integer('tax2_rate_ppm'),
    discountRatePpm: integer('discount_rate_ppm'),
    amountCents: integer('amount_cents').notNull().default(0),
    dueAmountCents: integer('due_amount_cents').notNull().default(0),
    taxAmountCents: integer('tax_amount_cents').notNull().default(0),
    tax2AmountCents: integer('tax2_amount_cents').notNull().default(0),
    discountAmountCents: integer('discount_amount_cents').notNull().default(0),
    writtenOffCents: integer('written_off_cents').notNull().default(0),
    paymentOptions: text('payment_options', { mode: 'json' })
      .$type<InvoicePaymentOption[]>()
      .notNull()
      .default([]),
    referenceToken: text('reference_token'),
    sourceAmountCents: integer('source_amount_cents'),
    sourceDueAmountCents: integer('source_due_amount_cents'),
    sourceTaxAmountCents: integer('source_tax_amount_cents'),
    sourceTax2AmountCents: integer('source_tax2_amount_cents'),
    sourceDiscountAmountCents: integer('source_discount_amount_cents'),
    sourcePaymentOptions: text('source_payment_options', { mode: 'json' }).$type<string[]>(),
    sourceUpdatedAt: text('source_updated_at'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('invoices_harvest_id_unique').on(table.harvestId),
    uniqueIndex('invoices_number_unique').on(table.number),
    uniqueIndex('invoices_client_key_unique').on(table.clientKey),
    uniqueIndex('invoices_reference_token_unique')
      .on(table.referenceToken)
      .where(sql`${table.referenceToken} is not null`),
    index('invoices_client_id').on(table.clientId),
    index('invoices_project_id').on(table.projectId),
    index('invoices_retainer_id').on(table.retainerId),
    index('invoices_recurring_invoice_id').on(table.recurringInvoiceId),
    index('invoices_created_by_user_id').on(table.createdByUserId),
    check(
      'invoices_reminder_policy_json',
      sql`${table.reminderPolicy} is null or (
        json_valid(${table.reminderPolicy}) and json_type(${table.reminderPolicy}) = 'object'
      )`,
    ),
    check('invoices_issue_date_canonical', sql`date(${table.issueDate}) is ${table.issueDate}`),
    check('invoices_due_date_canonical', sql`date(${table.dueDate}) is ${table.dueDate}`),
    check(
      'invoices_paid_date_canonical',
      sql`${table.paidDate} is null or date(${table.paidDate}) is ${table.paidDate}`,
    ),
    check(
      'invoices_period_start_canonical',
      sql`${table.periodStart} is null or date(${table.periodStart}) is ${table.periodStart}`,
    ),
    check(
      'invoices_period_end_canonical',
      sql`${table.periodEnd} is null or date(${table.periodEnd}) is ${table.periodEnd}`,
    ),
    check('invoices_sent_at_canonical', nullableCanonicalTimestamp(table.sentAt)),
    check('invoices_paid_at_canonical', nullableCanonicalTimestamp(table.paidAt)),
    check('invoices_closed_at_canonical', nullableCanonicalTimestamp(table.closedAt)),
    check('invoices_created_at_canonical', canonicalTimestamp(table.createdAt)),
    check('invoices_updated_at_canonical', canonicalTimestamp(table.updatedAt)),
    check('invoices_version_safe_integer', sql`${table.version} between 0 and 9007199254740991`),
    check(
      'invoices_closure_shape',
      sql`(${table.state} = 'closed') = (${table.closeReason} is not null)`,
    ),
    check(
      'invoices_close_write_off_shape',
      sql`(${table.closeReason} = 'written_off'
          and ${table.closeWriteOffCents} between 1 and ${table.writtenOffCents})
        or (${table.closeReason} is not 'written_off' and ${table.closeWriteOffCents} = 0)`,
    ),
    check(
      'invoices_paid_timestamp_shape',
      sql`(${table.state} = 'paid'
          and ((${table.paidAt} is null) <> (${table.paidDate} is null)))
        or (${table.state} in ('draft','open')
          and ${table.paidAt} is null and ${table.paidDate} is null)
        or (${table.state} = 'closed'
          and not (${table.paidAt} is not null and ${table.paidDate} is not null))`,
    ),
    check(
      'invoices_tax_rate_ppm_range',
      sql`${table.taxRatePpm} is null or ${table.taxRatePpm} between 0 and 1000000`,
    ),
    check(
      'invoices_tax2_rate_ppm_range',
      sql`${table.tax2RatePpm} is null or ${table.tax2RatePpm} between 0 and 1000000`,
    ),
    check(
      'invoices_discount_rate_ppm_range',
      sql`${table.discountRatePpm} is null or ${table.discountRatePpm} between 0 and 1000000`,
    ),
    check('invoices_amount_bound', sql`abs(${table.amountCents}) <= 9000000000000`),
    check('invoices_due_amount_bound', sql`abs(${table.dueAmountCents}) <= 9000000000000`),
    check('invoices_tax_amount_bound', sql`abs(${table.taxAmountCents}) <= 9000000000000`),
    check('invoices_tax2_amount_bound', sql`abs(${table.tax2AmountCents}) <= 9000000000000`),
    check(
      'invoices_discount_amount_bound',
      sql`abs(${table.discountAmountCents}) <= 9000000000000`,
    ),
    check('invoices_written_off_bound', sql`${table.writtenOffCents} between 0 and 9000000000000`),
    check(
      'invoices_payment_options_json',
      sql`json_valid(${table.paymentOptions}) and json_type(${table.paymentOptions}) = 'array'`,
    ),
    check(
      'invoices_reference_token_format',
      sql`${table.referenceToken} is null or (
        length(${table.referenceToken}) = 15
        and substr(${table.referenceToken}, 1, 3) = 'EZ-'
        and substr(${table.referenceToken}, 4) not glob '*[^0-9A-F]*'
      )`,
    ),
    check(
      'invoices_source_payment_options_json',
      sql`${table.sourcePaymentOptions} is null or (
        json_valid(${table.sourcePaymentOptions})
        and json_type(${table.sourcePaymentOptions}) = 'array'
      )`,
    ),
    check(
      'invoices_source_updated_at_canonical',
      nullableCanonicalTimestamp(table.sourceUpdatedAt),
    ),
    check(
      'invoices_source_amount_bound',
      sql`${table.sourceAmountCents} is null or abs(${table.sourceAmountCents}) <= 9000000000000`,
    ),
    check(
      'invoices_source_due_bound',
      sql`${table.sourceDueAmountCents} is null or abs(${table.sourceDueAmountCents}) <= 9000000000000`,
    ),
    check(
      'invoices_source_tax_bound',
      sql`${table.sourceTaxAmountCents} is null or abs(${table.sourceTaxAmountCents}) <= 9000000000000`,
    ),
    check(
      'invoices_source_tax2_bound',
      sql`${table.sourceTax2AmountCents} is null or abs(${table.sourceTax2AmountCents}) <= 9000000000000`,
    ),
    check(
      'invoices_source_discount_bound',
      sql`${table.sourceDiscountAmountCents} is null or abs(${table.sourceDiscountAmountCents}) <= 9000000000000`,
    ),
    check(
      'invoices_source_observation_import_only',
      sql`${table.harvestId} is not null or (
        ${table.sourceAmountCents} is null and ${table.sourceDueAmountCents} is null
        and ${table.sourceTaxAmountCents} is null and ${table.sourceTax2AmountCents} is null
        and ${table.sourceDiscountAmountCents} is null and ${table.sourcePaymentOptions} is null
        and ${table.sourceUpdatedAt} is null
      )`,
    ),
    check(
      'invoices_source_observation_timestamp',
      sql`${table.sourceUpdatedAt} is not null or (
        ${table.sourceAmountCents} is null and ${table.sourceDueAmountCents} is null
        and ${table.sourceTaxAmountCents} is null and ${table.sourceTax2AmountCents} is null
        and ${table.sourceDiscountAmountCents} is null and ${table.sourcePaymentOptions} is null
      )`,
    ),
  ],
)

export const invoiceItemCategories = sqliteTable(
  'invoice_item_categories',
  {
    id: integer('id').primaryKey(),
    harvestId: integer('harvest_id'),
    name: text('name').notNull(),
    useAsService: integer('use_as_service', { mode: 'boolean' }).notNull().default(false),
    useAsExpense: integer('use_as_expense', { mode: 'boolean' }).notNull().default(false),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('invoice_item_categories_harvest_id_unique').on(table.harvestId),
    uniqueIndex('invoice_item_categories_name_unique').on(table.name),
    check('invoice_item_categories_service_boolean', sql`${table.useAsService} in (0, 1)`),
    check('invoice_item_categories_expense_boolean', sql`${table.useAsExpense} in (0, 1)`),
    check('invoice_item_categories_created_at_canonical', canonicalTimestamp(table.createdAt)),
    check('invoice_item_categories_updated_at_canonical', canonicalTimestamp(table.updatedAt)),
  ],
)

export const invoiceLineItems = sqliteTable(
  'invoice_line_items',
  {
    id: integer('id').primaryKey(),
    harvestId: integer('harvest_id'),
    invoiceId: integer('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    kind: text('kind').notNull(),
    description: text('description'),
    quantity: real('quantity').notNull(),
    unitPriceCents: integer('unit_price_cents').notNull(),
    amountCents: integer('amount_cents').notNull(),
    taxed: integer('taxed', { mode: 'boolean' }).notNull().default(false),
    taxed2: integer('taxed2', { mode: 'boolean' }).notNull().default(false),
    projectId: integer('project_id').references(() => projects.id, { onDelete: 'restrict' }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('invoice_line_items_harvest_id_unique').on(table.harvestId),
    uniqueIndex('invoice_line_items_invoice_position_unique').on(table.invoiceId, table.position),
    index('invoice_line_items_invoice_id').on(table.invoiceId),
    index('invoice_line_items_project_id').on(table.projectId),
    check('invoice_line_items_position_nonnegative', sql`${table.position} >= 0`),
    check('invoice_line_items_taxed_boolean', sql`${table.taxed} in (0, 1)`),
    check('invoice_line_items_taxed2_boolean', sql`${table.taxed2} in (0, 1)`),
    check('invoice_line_items_created_at_canonical', canonicalTimestamp(table.createdAt)),
    check('invoice_line_items_updated_at_canonical', canonicalTimestamp(table.updatedAt)),
  ],
)

export const expenseCategories = sqliteTable(
  'expense_categories',
  {
    id: integer('id').primaryKey(),
    harvestId: integer('harvest_id'),
    name: text('name').notNull(),
    unitName: text('unit_name'),
    unitPriceCents: integer('unit_price_cents'),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('expense_categories_harvest_id_unique').on(table.harvestId),
    check(
      'expense_categories_unit_price_bound',
      sql`${table.unitPriceCents} is null or ${table.unitPriceCents} between 0 and 9000000000000`,
    ),
    check('expense_categories_is_active_boolean', sql`${table.isActive} in (0, 1)`),
    check('expense_categories_created_at_canonical', canonicalTimestamp(table.createdAt)),
    check('expense_categories_updated_at_canonical', canonicalTimestamp(table.updatedAt)),
  ],
)

export const expenses = sqliteTable(
  'expenses',
  {
    id: integer('id').primaryKey(),
    harvestId: integer('harvest_id'),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    expenseCategoryId: integer('expense_category_id')
      .notNull()
      .references(() => expenseCategories.id, { onDelete: 'restrict' }),
    spentDate: text('spent_date').notNull(),
    notes: text('notes'),
    units: integer('units'),
    totalCostCents: integer('total_cost_cents').notNull(),
    billable: integer('billable', { mode: 'boolean' }).notNull().default(true),
    approvalStatus: text('approval_status', {
      enum: ['unsubmitted', 'submitted', 'approved'],
    })
      .notNull()
      .default('unsubmitted'),
    invoiceId: integer('invoice_id').references(() => invoices.id, { onDelete: 'restrict' }),
    reimbursable: integer('reimbursable', { mode: 'boolean' }).notNull().default(false),
    reimbursementStatus: text('reimbursement_status', {
      enum: ['none', 'pending', 'approved', 'paid'],
    })
      .notNull()
      .default('none'),
    payoutRef: text('payout_ref'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('expenses_harvest_id_unique').on(table.harvestId),
    index('expenses_user_spent_date').on(table.userId, table.spentDate),
    index('expenses_project_spent_date').on(table.projectId, table.spentDate),
    index('expenses_expense_category_id').on(table.expenseCategoryId),
    index('expenses_invoice_id').on(table.invoiceId),
    check(
      'expenses_units_safe_integer',
      sql`${table.units} is null or ${table.units} between 0 and 9007199254740991`,
    ),
    check('expenses_total_cost_bound', sql`abs(${table.totalCostCents}) <= 9000000000000`),
    check('expenses_billable_boolean', sql`${table.billable} in (0, 1)`),
    check(
      'expenses_approval_status_valid',
      sql`${table.approvalStatus} in ('unsubmitted', 'submitted', 'approved')`,
    ),
    check('expenses_reimbursable_boolean', sql`${table.reimbursable} in (0, 1)`),
    check(
      'expenses_reimbursement_status_valid',
      sql`${table.reimbursementStatus} in ('none', 'pending', 'approved', 'paid')`,
    ),
    check('expenses_spent_date_canonical', sql`date(${table.spentDate}) is ${table.spentDate}`),
    check('expenses_created_at_canonical', canonicalTimestamp(table.createdAt)),
    check('expenses_updated_at_canonical', canonicalTimestamp(table.updatedAt)),
  ],
)

export const invoiceMessages = sqliteTable(
  'invoice_messages',
  {
    id: integer('id').primaryKey(),
    harvestId: integer('harvest_id'),
    invoiceId: integer('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    sentBy: text('sent_by'),
    sentByEmail: text('sent_by_email'),
    sentFrom: text('sent_from'),
    sentFromEmail: text('sent_from_email'),
    recipients: text('recipients', { mode: 'json' })
      .$type<Array<{ name: string; email: string }>>()
      .notNull()
      .default([]),
    subject: text('subject'),
    body: text('body'),
    attachPdf: integer('attach_pdf', { mode: 'boolean' }).notNull().default(false),
    sendMeACopy: integer('send_me_a_copy', { mode: 'boolean' }).notNull().default(false),
    thankYou: integer('thank_you', { mode: 'boolean' }).notNull().default(false),
    reminder: integer('reminder', { mode: 'boolean' }).notNull().default(false),
    sendReminderOn: text('send_reminder_on'),
    eventType: text('event_type', {
      enum: ['send', 'view', 'draft', 'cancel', 'write_off', 're-open', 'close'],
    }),
    deliveryStatus: text('delivery_status', {
      enum: ['queued', 'sent', 'bounced', 'complained', 'failed'],
    }),
    providerMessageId: text('provider_message_id'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('invoice_messages_harvest_id_unique').on(table.harvestId),
    index('invoice_messages_invoice_created_id').on(table.invoiceId, table.createdAt, table.id),
    index('invoice_messages_provider_message_id')
      .on(table.providerMessageId)
      .where(sql`${table.providerMessageId} is not null`),
    check(
      'invoice_messages_recipients_json',
      sql`json_valid(${table.recipients}) and json_type(${table.recipients}) = 'array'`,
    ),
    check('invoice_messages_attach_pdf_boolean', sql`${table.attachPdf} in (0, 1)`),
    check('invoice_messages_copy_boolean', sql`${table.sendMeACopy} in (0, 1)`),
    check('invoice_messages_thank_you_boolean', sql`${table.thankYou} in (0, 1)`),
    check('invoice_messages_reminder_boolean', sql`${table.reminder} in (0, 1)`),
    check(
      'invoice_messages_send_reminder_on_canonical',
      sql`${table.sendReminderOn} is null or date(${table.sendReminderOn}) is ${table.sendReminderOn}`,
    ),
    check('invoice_messages_created_at_canonical', canonicalTimestamp(table.createdAt)),
    check('invoice_messages_updated_at_canonical', canonicalTimestamp(table.updatedAt)),
  ],
)

export const retainerLedger = sqliteTable(
  'retainer_ledger',
  {
    id: text('id').primaryKey(),
    retainerId: integer('retainer_id')
      .notNull()
      .references(() => retainers.id, { onDelete: 'restrict' }),
    kind: text('kind', {
      enum: ['deposit', 'drawdown', 'expiry', 'reset', 'adjustment'],
    }).notNull(),
    unit: text('unit', { enum: ['cents', 'seconds'] }).notNull(),
    amount: integer('amount').notNull(),
    invoiceId: integer('invoice_id').references(() => invoices.id, { onDelete: 'restrict' }),
    occurredOn: text('occurred_on').notNull(),
    notes: text('notes'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('retainer_ledger_retainer_occurred_id').on(table.retainerId, table.occurredOn, table.id),
    index('retainer_ledger_invoice_id').on(table.invoiceId),
    check(
      'retainer_ledger_id_format',
      sql`length(${table.id}) between 1 and 128
        and ${table.id} not glob '*[^A-Za-z0-9._:-]*'`,
    ),
    check(
      'retainer_ledger_kind',
      sql`${table.kind} in ('deposit','drawdown','expiry','reset','adjustment')`,
    ),
    check('retainer_ledger_unit', sql`${table.unit} in ('cents','seconds')`),
    check(
      'retainer_ledger_amount_bound',
      sql`(${table.unit} = 'cents'
          and ${table.amount} between -9000000000000 and 9000000000000)
        or (${table.unit} = 'seconds'
          and ${table.amount} between -9007199254740991 and 9007199254740991)`,
    ),
    check('retainer_ledger_amount_nonzero', sql`${table.amount} <> 0`),
    check(
      'retainer_ledger_kind_sign',
      sql`(${table.kind} = 'deposit' and ${table.amount} > 0)
        or (${table.kind} in ('drawdown','expiry') and ${table.amount} < 0)
        or ${table.kind} in ('reset','adjustment')`,
    ),
    check(
      'retainer_ledger_adjustment_reason',
      sql`${table.kind} <> 'adjustment'
        or (${table.notes} is not null and length(trim(${table.notes})) > 0)`,
    ),
    check(
      'retainer_ledger_invoice_provenance',
      sql`${table.kind} not in ('deposit','drawdown') or ${table.invoiceId} is not null`,
    ),
    check(
      'retainer_ledger_occurred_on_canonical',
      sql`date(${table.occurredOn}) is ${table.occurredOn}`,
    ),
    check('retainer_ledger_created_at_canonical', canonicalTimestamp(table.createdAt)),
  ],
)

export const retainerBalances = sqliteView('retainer_balances', {
  retainerId: integer('retainer_id').notNull(),
  denomination: text('denomination', { enum: ['money', 'hours'] }).notNull(),
  balance: integer('balance').notNull(),
}).as(sql`
  SELECT retainer.id AS retainer_id, retainer.denomination,
    COALESCE(SUM(entry.amount), 0) AS balance
  FROM ${retainers} retainer
  LEFT JOIN ${retainerLedger} entry ON entry.retainer_id = retainer.id
  GROUP BY retainer.id, retainer.denomination
`)

export const eventOutbox = sqliteTable(
  'event_outbox',
  {
    id: text('id').primaryKey(),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: integer('aggregate_id').notNull(),
    aggregateSequence: integer('aggregate_sequence').notNull(),
    eventType: text('event_type').notNull(),
    commandId: text('command_id'),
    eventIndex: integer('event_index'),
    payloadJson: text('payload_json', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    occurredAt: text('occurred_at').notNull(),
    availableAt: text('available_at').notNull(),
    publishedAt: text('published_at'),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastError: text('last_error'),
  },
  (table) => [
    uniqueIndex('event_outbox_aggregate_sequence_unique').on(
      table.aggregateType,
      table.aggregateId,
      table.aggregateSequence,
    ),
    uniqueIndex('event_outbox_command_event_unique')
      .on(table.aggregateType, table.aggregateId, table.commandId, table.eventIndex)
      .where(sql`${table.commandId} is not null`),
    index('event_outbox_dequeue').on(
      table.publishedAt,
      table.availableAt,
      table.occurredAt,
      table.id,
    ),
    check('event_outbox_payload_json', sql`json_valid(${table.payloadJson})`),
    check('event_outbox_sequence_positive', sql`${table.aggregateSequence} >= 1`),
    check(
      'event_outbox_command_id_format',
      sql`${table.commandId} is null or (
        length(${table.commandId}) between 1 and 128
        and ${table.commandId} not glob '*[^A-Za-z0-9._:-]*'
      )`,
    ),
    check(
      'event_outbox_causation_shape',
      sql`(${table.commandId} is null and ${table.eventIndex} is null)
        or (${table.commandId} is not null and ${table.eventIndex} between 0 and 1)`,
    ),
    check('event_outbox_attempt_count_nonnegative', sql`${table.attemptCount} >= 0`),
    check('event_outbox_occurred_at_canonical', canonicalTimestamp(table.occurredAt)),
    check('event_outbox_available_at_canonical', canonicalTimestamp(table.availableAt)),
    check('event_outbox_published_at_canonical', nullableCanonicalTimestamp(table.publishedAt)),
  ],
)

export const invoiceCommandLedger = sqliteTable(
  'invoice_command_ledger',
  {
    invoiceId: integer('invoice_id').notNull(),
    commandId: text('command_id').notNull(),
    commandKind: text('command_kind', {
      enum: [
        'invoice.send',
        'invoice.view',
        'invoice.draft',
        'invoice.cancel',
        'invoice.write_off',
        'invoice.reopen',
        'invoice.source_close',
        'invoice.update',
        'invoice.line_insert',
        'invoice.line_update',
        'invoice.line_delete',
        'invoice.financials_update',
        'payment.record',
        'payment.update',
        'payment.delete',
      ],
    }).notNull(),
    inputFingerprint: text('input_fingerprint').notNull(),
    actorType: text('actor_type', { enum: ['user', 'contact', 'system'] }).notNull(),
    actorId: integer('actor_id'),
    expectedInvoiceVersion: integer('expected_invoice_version'),
    occurredAt: text('occurred_at').notNull(),
    eventCount: integer('event_count'),
    completed: integer('completed', { mode: 'boolean' }).notNull().default(false),
    firstAggregateSequence: integer('first_aggregate_sequence'),
    resultJson: text('result_json', { mode: 'json' }).$type<Record<string, unknown>>(),
    completedAt: text('completed_at'),
  },
  (table) => [
    primaryKey({ columns: [table.invoiceId, table.commandId] }),
    uniqueIndex('invoice_command_ledger_pending_invoice_unique')
      .on(table.invoiceId)
      .where(sql`${table.completed} = 0`),
    check(
      'invoice_command_ledger_command_id_format',
      sql`length(${table.commandId}) between 1 and 128
        and ${table.commandId} not glob '*[^A-Za-z0-9._:-]*'`,
    ),
    check(
      'invoice_command_ledger_fingerprint_format',
      sql`length(${table.inputFingerprint}) = 71
        and substr(${table.inputFingerprint}, 1, 7) = 'sha256:'
        and substr(${table.inputFingerprint}, 8) not glob '*[^0-9a-f]*'`,
    ),
    check(
      'invoice_command_ledger_actor_shape',
      sql`(${table.actorType} = 'system' and ${table.actorId} is null)
        or (${table.actorType} in ('user','contact') and ${table.actorId} is not null)`,
    ),
    check(
      'invoice_command_ledger_expected_version_shape',
      sql`(${table.commandKind} = 'invoice.view' and ${table.expectedInvoiceVersion} is null)
        or (${table.commandKind} <> 'invoice.view' and ${table.expectedInvoiceVersion} >= 0)`,
    ),
    check('invoice_command_ledger_occurred_at_canonical', canonicalTimestamp(table.occurredAt)),
    check('invoice_command_ledger_completed_boolean', sql`${table.completed} in (0, 1)`),
    check(
      'invoice_command_ledger_completion_shape',
      sql`(${table.completed} = 0 and ${table.eventCount} is null
          and ${table.firstAggregateSequence} is null and ${table.resultJson} is null
          and ${table.completedAt} is null)
        or (${table.completed} = 1 and ${table.eventCount} between 1 and 2
          and ${table.firstAggregateSequence} >= 1 and ${table.resultJson} is not null
          and json_valid(${table.resultJson}) and json_extract(${table.resultJson}, '$.schema_version') = 1
          and ${table.completedAt} is not null)`,
    ),
    check(
      'invoice_command_ledger_completed_at_canonical',
      nullableCanonicalTimestamp(table.completedAt),
    ),
  ],
)

export const paymentProviderAccounts = sqliteTable(
  'payment_provider_accounts',
  {
    id: integer('id').primaryKey(),
    provider: text('provider', {
      enum: ['stripe', 'paypal', 'quickbooks', 'mercury', 'wise', 'bill_com'],
    }).notNull(),
    providerShape: text('provider_shape', {
      enum: ['checkout', 'reconciliation'],
    }).notNull(),
    externalAccountId: text('external_account_id').notNull(),
    displayName: text('display_name'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('payment_provider_accounts_identity_unique').on(
      table.provider,
      table.providerShape,
      table.externalAccountId,
    ),
    check(
      'payment_provider_accounts_shape',
      sql`(${table.provider} in ('stripe','paypal','quickbooks') and ${table.providerShape} = 'checkout')
        or (${table.provider} in ('mercury','wise') and ${table.providerShape} = 'reconciliation')
        or ${table.provider} = 'bill_com'`,
    ),
    check(
      'payment_provider_accounts_external_id_nonempty',
      sql`length(${table.externalAccountId}) > 0`,
    ),
    check('payment_provider_accounts_created_at_canonical', canonicalTimestamp(table.createdAt)),
    check('payment_provider_accounts_updated_at_canonical', canonicalTimestamp(table.updatedAt)),
  ],
)

export const bankDeposits = sqliteTable(
  'bank_deposits',
  {
    id: integer('id').primaryKey(),
    providerAccountId: integer('provider_account_id')
      .notNull()
      .references(() => paymentProviderAccounts.id, { onDelete: 'restrict' }),
    providerTransactionId: text('provider_transaction_id').notNull(),
    currency: text('currency').notNull(),
    postedAt: text('posted_at').notNull(),
    amountCents: integer('amount_cents').notNull(),
    memo: text('memo'),
    counterparty: text('counterparty'),
    matchState: text('match_state', {
      enum: ['unmatched', 'suggested', 'confirmed'],
    })
      .notNull()
      .default('unmatched'),
    suggestedInvoiceId: integer('suggested_invoice_id').references(() => invoices.id, {
      onDelete: 'restrict',
    }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('bank_deposits_provider_transaction_unique').on(
      table.providerAccountId,
      table.providerTransactionId,
    ),
    index('bank_deposits_suggested_invoice_id').on(table.suggestedInvoiceId),
    index('bank_deposits_match_posted_id').on(table.matchState, table.postedAt, table.id),
    check(
      'bank_deposits_provider_transaction_nonempty',
      sql`length(${table.providerTransactionId}) > 0`,
    ),
    check(
      'bank_deposits_currency',
      sql`length(${table.currency}) = 3 and ${table.currency} = upper(${table.currency})
        and ${table.currency} not glob '*[^A-Z]*'`,
    ),
    check('bank_deposits_amount_bound', sql`${table.amountCents} between 1 and 9000000000000`),
    check(
      'bank_deposits_match_shape',
      sql`(${table.matchState} = 'unmatched' and ${table.suggestedInvoiceId} is null)
        or (${table.matchState} = 'suggested' and ${table.suggestedInvoiceId} is not null)
        or ${table.matchState} = 'confirmed'`,
    ),
    check('bank_deposits_posted_at_canonical', canonicalTimestamp(table.postedAt)),
    check('bank_deposits_created_at_canonical', canonicalTimestamp(table.createdAt)),
    check('bank_deposits_updated_at_canonical', canonicalTimestamp(table.updatedAt)),
  ],
)

export const invoicePayments = sqliteTable(
  'invoice_payments',
  {
    id: integer('id').primaryKey(),
    harvestId: integer('harvest_id').unique(),
    invoiceId: integer('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    currency: text('currency').notNull(),
    amountCents: integer('amount_cents').notNull(),
    paidAt: text('paid_at'),
    paidDate: text('paid_date'),
    sourcePaidAt: text('source_paid_at'),
    sourcePaidDate: text('source_paid_date'),
    sourceRecordedByName: text('source_recorded_by_name'),
    sourceRecordedByEmail: text('source_recorded_by_email'),
    sourceGatewayId: integer('source_gateway_id'),
    sourceGatewayName: text('source_gateway_name'),
    notes: text('notes'),
    recordedByUserId: integer('recorded_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    provider: text('provider', {
      enum: ['manual', 'stripe', 'paypal', 'quickbooks', 'mercury', 'wise', 'bill_com'],
    }).notNull(),
    providerShape: text('provider_shape', {
      enum: ['manual', 'checkout', 'reconciliation'],
    }).notNull(),
    providerAccountId: integer('provider_account_id').references(() => paymentProviderAccounts.id, {
      onDelete: 'restrict',
    }),
    providerTransactionId: text('provider_transaction_id'),
    bankDepositId: integer('bank_deposit_id')
      .unique()
      .references(() => bankDeposits.id, { onDelete: 'restrict' }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('invoice_payments_provider_transaction_unique')
      .on(table.providerAccountId, table.providerTransactionId)
      .where(
        sql`${table.providerAccountId} is not null and ${table.providerTransactionId} is not null`,
      ),
    index('invoice_payments_invoice_id').on(table.invoiceId),
    index('invoice_payments_recorded_by_user_id').on(table.recordedByUserId),
    index('invoice_payments_provider_account_id').on(table.providerAccountId),
    check(
      'invoice_payments_currency',
      sql`length(${table.currency}) = 3 and ${table.currency} = upper(${table.currency})
        and ${table.currency} not glob '*[^A-Z]*'`,
    ),
    check('invoice_payments_amount_bound', sql`${table.amountCents} between 1 and 9000000000000`),
    check(
      'invoice_payments_paid_shape',
      sql`(${table.paidAt} is null) <> (${table.paidDate} is null)`,
    ),
    check('invoice_payments_paid_at_canonical', nullableCanonicalTimestamp(table.paidAt)),
    check(
      'invoice_payments_paid_date_canonical',
      sql`${table.paidDate} is null or date(${table.paidDate}) is ${table.paidDate}`,
    ),
    check(
      'invoice_payments_source_paid_at_canonical',
      nullableCanonicalTimestamp(table.sourcePaidAt),
    ),
    check(
      'invoice_payments_source_paid_date_canonical',
      sql`${table.sourcePaidDate} is null or date(${table.sourcePaidDate}) is ${table.sourcePaidDate}`,
    ),
    check('invoice_payments_created_at_canonical', canonicalTimestamp(table.createdAt)),
    check('invoice_payments_updated_at_canonical', canonicalTimestamp(table.updatedAt)),
    check(
      'invoice_payments_provider_shape',
      sql`(${table.provider} = 'manual' and ${table.providerShape} = 'manual'
          and ${table.providerAccountId} is null and ${table.bankDepositId} is null)
        or (${table.provider} in ('stripe','paypal','quickbooks','bill_com')
          and ${table.providerShape} = 'checkout'
          and ${table.providerAccountId} is not null and ${table.bankDepositId} is null)
        or (${table.provider} in ('mercury','wise','bill_com')
          and ${table.providerShape} = 'reconciliation'
          and ${table.providerAccountId} is not null and ${table.bankDepositId} is not null)`,
    ),
    check(
      'invoice_payments_external_transaction',
      sql`(${table.providerTransactionId} is null or length(${table.providerTransactionId}) > 0)
        and (${table.provider} = 'manual' or (
          ${table.providerTransactionId} is not null
          and length(${table.providerTransactionId}) > 0
        ))`,
    ),
    check(
      'invoice_payments_harvest_manual',
      sql`${table.harvestId} is null or (
        ${table.provider} = 'manual' and ${table.providerShape} = 'manual'
        and ${table.providerAccountId} is null and ${table.bankDepositId} is null
      )`,
    ),
    check(
      'invoice_payments_source_import_only',
      sql`${table.harvestId} is not null or (
        ${table.sourcePaidAt} is null and ${table.sourcePaidDate} is null
        and ${table.sourceRecordedByName} is null and ${table.sourceRecordedByEmail} is null
        and ${table.sourceGatewayId} is null and ${table.sourceGatewayName} is null
      )`,
    ),
    check(
      'invoice_payments_imported_paid_precedence',
      sql`${table.harvestId} is null or (
        (${table.sourcePaidAt} is not null and ${table.paidAt} is ${table.sourcePaidAt}
          and ${table.paidDate} is null)
        or (${table.sourcePaidAt} is null and ${table.sourcePaidDate} is not null
          and ${table.paidAt} is null and ${table.paidDate} is ${table.sourcePaidDate})
      )`,
    ),
  ],
)

export const invoiceFinancialCalculation = sqliteView('invoice_financial_calculation', {
  invoiceId: integer('invoice_id').notNull(),
  discountAmountCents: integer('discount_amount_cents').notNull(),
  taxAmountCents: integer('tax_amount_cents').notNull(),
  tax2AmountCents: integer('tax2_amount_cents').notNull(),
  amountCents: integer('amount_cents').notNull(),
  dueAmountCents: integer('due_amount_cents').notNull(),
}).as(sql`
  WITH line_bases AS (
    SELECT invoice.id AS invoice_id,
      COALESCE(SUM(line.amount_cents), 0) AS subtotal_cents,
      COALESCE(SUM(CASE WHEN line.taxed = 1 THEN line.amount_cents ELSE 0 END), 0)
        AS tax_base_cents,
      COALESCE(SUM(CASE WHEN line.taxed2 = 1 THEN line.amount_cents ELSE 0 END), 0)
        AS tax2_base_cents
    FROM invoices invoice
    LEFT JOIN invoice_line_items line ON line.invoice_id = invoice.id
    GROUP BY invoice.id
  ),
  payment_bases AS (
    SELECT invoice.id AS invoice_id,
      COALESCE(SUM(payment.amount_cents), 0) AS payment_cents
    FROM invoices invoice
    LEFT JOIN invoice_payments payment ON payment.invoice_id = invoice.id
    GROUP BY invoice.id
  ),
  components AS (
    SELECT invoice.id AS invoice_id, line_bases.subtotal_cents,
      CASE WHEN line_bases.subtotal_cents * COALESCE(invoice.discount_rate_ppm, 0) >= 0
        THEN (line_bases.subtotal_cents * COALESCE(invoice.discount_rate_ppm, 0) + 500000) / 1000000
        ELSE (line_bases.subtotal_cents * COALESCE(invoice.discount_rate_ppm, 0) - 500000) / 1000000
      END AS discount_amount_cents,
      CASE WHEN (
        line_bases.tax_base_cents -
        CASE WHEN line_bases.tax_base_cents * COALESCE(invoice.discount_rate_ppm, 0) >= 0
          THEN (line_bases.tax_base_cents * COALESCE(invoice.discount_rate_ppm, 0) + 500000) / 1000000
          ELSE (line_bases.tax_base_cents * COALESCE(invoice.discount_rate_ppm, 0) - 500000) / 1000000
        END
      ) * COALESCE(invoice.tax_rate_ppm, 0) >= 0 THEN ((
        line_bases.tax_base_cents -
        CASE WHEN line_bases.tax_base_cents * COALESCE(invoice.discount_rate_ppm, 0) >= 0
          THEN (line_bases.tax_base_cents * COALESCE(invoice.discount_rate_ppm, 0) + 500000) / 1000000
          ELSE (line_bases.tax_base_cents * COALESCE(invoice.discount_rate_ppm, 0) - 500000) / 1000000
        END
      ) * COALESCE(invoice.tax_rate_ppm, 0) + 500000) / 1000000 ELSE ((
        line_bases.tax_base_cents -
        CASE WHEN line_bases.tax_base_cents * COALESCE(invoice.discount_rate_ppm, 0) >= 0
          THEN (line_bases.tax_base_cents * COALESCE(invoice.discount_rate_ppm, 0) + 500000) / 1000000
          ELSE (line_bases.tax_base_cents * COALESCE(invoice.discount_rate_ppm, 0) - 500000) / 1000000
        END
      ) * COALESCE(invoice.tax_rate_ppm, 0) - 500000) / 1000000 END AS tax_amount_cents,
      CASE WHEN (
        line_bases.tax2_base_cents -
        CASE WHEN line_bases.tax2_base_cents * COALESCE(invoice.discount_rate_ppm, 0) >= 0
          THEN (line_bases.tax2_base_cents * COALESCE(invoice.discount_rate_ppm, 0) + 500000) / 1000000
          ELSE (line_bases.tax2_base_cents * COALESCE(invoice.discount_rate_ppm, 0) - 500000) / 1000000
        END
      ) * COALESCE(invoice.tax2_rate_ppm, 0) >= 0 THEN ((
        line_bases.tax2_base_cents -
        CASE WHEN line_bases.tax2_base_cents * COALESCE(invoice.discount_rate_ppm, 0) >= 0
          THEN (line_bases.tax2_base_cents * COALESCE(invoice.discount_rate_ppm, 0) + 500000) / 1000000
          ELSE (line_bases.tax2_base_cents * COALESCE(invoice.discount_rate_ppm, 0) - 500000) / 1000000
        END
      ) * COALESCE(invoice.tax2_rate_ppm, 0) + 500000) / 1000000 ELSE ((
        line_bases.tax2_base_cents -
        CASE WHEN line_bases.tax2_base_cents * COALESCE(invoice.discount_rate_ppm, 0) >= 0
          THEN (line_bases.tax2_base_cents * COALESCE(invoice.discount_rate_ppm, 0) + 500000) / 1000000
          ELSE (line_bases.tax2_base_cents * COALESCE(invoice.discount_rate_ppm, 0) - 500000) / 1000000
        END
      ) * COALESCE(invoice.tax2_rate_ppm, 0) - 500000) / 1000000 END AS tax2_amount_cents,
      payment_bases.payment_cents, invoice.written_off_cents
    FROM invoices invoice
    JOIN line_bases ON line_bases.invoice_id = invoice.id
    JOIN payment_bases ON payment_bases.invoice_id = invoice.id
  )
  SELECT invoice_id, discount_amount_cents, tax_amount_cents, tax2_amount_cents,
    subtotal_cents - discount_amount_cents + tax_amount_cents + tax2_amount_cents AS amount_cents,
    subtotal_cents - discount_amount_cents + tax_amount_cents + tax2_amount_cents
      - payment_cents - written_off_cents AS due_amount_cents
  FROM components
`)

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
    invoicedInvoiceId: integer('invoiced_invoice_id').references(() => invoices.id, {
      onDelete: 'restrict',
    }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('project_milestones_harvest_id_unique').on(table.harvestId),
    index('project_milestones_project_id').on(table.projectId),
    index('project_milestones_invoiced_invoice_id').on(table.invoicedInvoiceId),
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
    invoiceId: integer('invoice_id').references(() => invoices.id, { onDelete: 'restrict' }),
    externalRef: text('external_ref', { mode: 'json' }).$type<Record<string, unknown>>(),
    calendarEventRef: text('calendar_event_ref', { mode: 'json' }).$type<Record<string, unknown>>(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('time_entries_harvest_id_unique').on(table.harvestId),
    index('time_entries_user_spent_date').on(table.userId, table.spentDate),
    index('time_entries_project_spent_date').on(table.projectId, table.spentDate),
    index('time_entries_invoice_id').on(table.invoiceId),
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
    check('time_entries_seconds_safe', sql`${table.seconds} between 0 and 9007199254740991`),
    check(
      'time_entries_checkpoint_safe',
      sql`${table.secondsWithoutTimer} between 0 and 9007199254740991`,
    ),
    check('time_entries_rounded_safe', sql`${table.roundedSeconds} between 0 and 9007199254740991`),
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
