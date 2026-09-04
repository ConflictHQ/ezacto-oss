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
import type { StaticRecurringAttachmentPolicyV1 } from './attachments.js'
import type { EmailFailureCode, EmailRecipient, EmailSender } from '@ezacto/mailer'

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

export interface EstimateRecipient {
  name: string
  email: string
}

export type EstimateMessageEventType =
  'send' | 'accept' | 'decline' | 're-open' | 'view' | 'invoice'

export type EstimateDeliveryStatus = 'queued' | 'sent' | 'bounced' | 'complained' | 'failed'

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
    timeEntryNotesMinimumLength: integer('time_entry_notes_minimum_length').notNull().default(1),
    timeRounding: text('time_rounding', {
      enum: ['none', 'nearest_6', 'nearest_15', 'nearest_30', 'up_6', 'up_15', 'up_30'],
    })
      .notNull()
      .default('none'),
    modules: text('modules', { mode: 'json' }).$type<Record<string, boolean>>().notNull(),
    require2fa: integer('require_2fa', { mode: 'boolean' }).notNull().default(false),
    requireSso: integer('require_sso', { mode: 'boolean' }).notNull().default(false),
    timezone: text('timezone').notNull().default('UTC'),
    ...timestamps,
  },
  (table) => [
    check('organizations_singleton', sql`${table.id} = 1`),
    check('organizations_fiscal_month', sql`${table.fiscalYearStartMonth} between 1 and 12`),
    check('organizations_capacity_nonnegative', sql`${table.weeklyCapacityDefault} >= 0`),
    check(
      'organizations_time_entry_notes_minimum_length',
      sql`${table.timeEntryNotesMinimumLength} between 1 and 10000`,
    ),
    check('organizations_modules_json', sql`json_valid(${table.modules})`),
    check(
      'organizations_timezone_nonempty',
      sql`length(trim(${table.timezone})) between 1 and 255`,
    ),
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
    timeEntryNotesMinimumLength: integer('time_entry_notes_minimum_length'),
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
      'users_time_entry_notes_minimum_length',
      sql`${table.timeEntryNotesMinimumLength} is null
        or ${table.timeEntryNotesMinimumLength} between 1 and 10000`,
    ),
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

export const userPasswords = sqliteTable(
  'user_passwords',
  {
    userId: integer('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    credentialVersion: integer('credential_version').notNull(),
    algorithm: text('algorithm', { enum: ['pbkdf2-sha256', 'argon2id'] }).notNull(),
    version: integer('version'),
    iterations: integer('iterations'),
    memoryKiB: integer('memory_kib'),
    timeCost: integer('time_cost'),
    parallelism: integer('parallelism'),
    salt: text('salt').notNull(),
    passwordHash: text('password_hash').notNull(),
    ...timestamps,
  },
  (table) => [
    check(
      'user_passwords_algorithm_parameters',
      sql`(${table.algorithm} = 'pbkdf2-sha256'
          AND ${table.version} IS NULL
          AND ${table.iterations} = 600000
          AND ${table.memoryKiB} IS NULL
          AND ${table.timeCost} IS NULL
          AND ${table.parallelism} IS NULL)
        OR (${table.algorithm} = 'argon2id'
          AND ${table.version} = 19
          AND ${table.iterations} IS NULL
          AND ${table.memoryKiB} = 19456
          AND ${table.timeCost} = 2
          AND ${table.parallelism} = 1)`,
    ),
    check(
      'user_passwords_credential_version',
      sql`${table.credentialVersion} BETWEEN 1 AND 9007199254740991`,
    ),
  ],
)

export const authTokens = sqliteTable(
  'auth_tokens',
  {
    id: integer('id').primaryKey(),
    selector: text('selector').notNull(),
    secretHash: text('secret_hash').notNull(),
    kind: text('kind', { enum: ['verify_email', 'password_reset'] }).notNull(),
    userEmailId: integer('user_email_id')
      .notNull()
      .references(() => userEmails.id, { onDelete: 'cascade' }),
    expiresAt: text('expires_at').notNull(),
    usedAt: text('used_at'),
    usedNonce: text('used_nonce'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('auth_tokens_selector_unique').on(table.selector),
    index('auth_tokens_email_kind').on(table.userEmailId, table.kind),
    check('auth_tokens_used_pair', sql`(${table.usedAt} is null) = (${table.usedNonce} is null)`),
  ],
)

export const authRateLimits = sqliteTable(
  'auth_rate_limits',
  {
    action: text('action', {
      enum: ['signup', 'sign_in', 'verify_email', 'request_reset', 'reset_password'],
    }).notNull(),
    keyHash: text('key_hash').notNull(),
    windowStartedAt: text('window_started_at').notNull(),
    attempts: integer('attempts').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.action, table.keyHash] }),
    check('auth_rate_limits_attempts_positive', sql`${table.attempts} >= 1`),
  ],
)

export const authFirstRun = sqliteTable(
  'auth_first_run',
  {
    id: integer('id').primaryKey().default(1),
    claimNonce: text('claim_nonce').notNull().unique(),
    completedAt: text('completed_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [check('auth_first_run_singleton', sql`${table.id} = 1`)],
)

export const sessions = sqliteTable(
  'sessions',
  {
    id: integer('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    selector: text('selector').notNull().unique(),
    secretHash: text('secret_hash').notNull(),
    profileSnapshot: text('profile_snapshot', {
      enum: [
        'member',
        'project_manager',
        'people_admin',
        'accounting',
        'executive_manager',
        'administrator',
      ],
    }).notNull(),
    managerGrantsSnapshot: text('manager_grants_snapshot').notNull(),
    createdAt: text('created_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
    idleExpiresAt: text('idle_expires_at').notNull(),
    absoluteExpiresAt: text('absolute_expires_at').notNull(),
    revokedAt: text('revoked_at'),
    revocationReason: text('revocation_reason', {
      enum: ['user_revoked', 'privilege_change', 'password_reset', 'user_disabled'],
    }),
    rotationNonce: text('rotation_nonce').unique(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('sessions_user_created_id').on(table.userId, table.createdAt, table.id),
    index('sessions_active_expiry').on(table.idleExpiresAt, table.absoluteExpiresAt),
    check(
      'sessions_revocation_pair',
      sql`(${table.revokedAt} is null) = (${table.revocationReason} is null)`,
    ),
  ],
)

export const oidcTransactions = sqliteTable(
  'oidc_transactions',
  {
    id: integer('id').primaryKey(),
    provider: text('provider').notNull(),
    issuer: text('issuer').notNull(),
    clientId: text('client_id').notNull(),
    clientKeyHash: text('client_key_hash').notNull(),
    stateHash: text('state_hash').notNull().unique(),
    codeVerifier: text('code_verifier').notNull(),
    nonce: text('nonce').notNull(),
    redirectUri: text('redirect_uri').notNull(),
    expiresAt: text('expires_at').notNull(),
    consumedAt: text('consumed_at'),
    consumeNonce: text('consume_nonce').unique(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('oidc_transactions_active_expiry')
      .on(table.expiresAt)
      .where(sql`${table.consumedAt} is null`),
    index('oidc_transactions_client_created').on(table.clientKeyHash, table.createdAt),
    check(
      'oidc_transactions_consumed_pair',
      sql`(${table.consumedAt} is null) = (${table.consumeNonce} is null)`,
    ),
  ],
)

export const apiTokens = sqliteTable(
  'api_tokens',
  {
    id: integer('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    selector: text('selector').notNull(),
    secretHash: text('secret_hash').notNull(),
    name: text('name').notNull(),
    scopes: text('scopes', { mode: 'json' }).$type<string[]>().notNull(),
    lastUsedAt: text('last_used_at'),
    expiresAt: text('expires_at'),
    revokedAt: text('revoked_at'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('api_tokens_selector_unique').on(table.selector),
    index('api_tokens_user_created_id').on(table.userId, table.createdAt, table.id),
    index('api_tokens_active_expiry')
      .on(table.expiresAt)
      .where(sql`${table.revokedAt} is null`),
    check(
      'api_tokens_selector_shape',
      sql`length(${table.selector}) = 16 and ${table.selector} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      'api_tokens_secret_hash_shape',
      sql`length(${table.secretHash}) = 64 and ${table.secretHash} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'api_tokens_name_canonical',
      sql`${table.name} = trim(${table.name},
        char(9) || char(10) || char(11) || char(12) || char(13) || char(32) || char(160)
        || char(5760) || char(8192) || char(8193) || char(8194) || char(8195) || char(8196)
        || char(8197) || char(8198) || char(8199) || char(8200) || char(8201) || char(8202)
        || char(8232) || char(8233) || char(8239) || char(8287) || char(12288) || char(65279)
      ) and length(${table.name}) between 1 and 100`,
    ),
    check(
      'api_tokens_scopes_json',
      sql`json_valid(${table.scopes}) and json_type(${table.scopes}) = 'array'`,
    ),
    check('api_tokens_last_used_at_canonical', nullableCanonicalTimestamp(table.lastUsedAt)),
    check('api_tokens_expires_at_canonical', nullableCanonicalTimestamp(table.expiresAt)),
    check('api_tokens_revoked_at_canonical', nullableCanonicalTimestamp(table.revokedAt)),
    check('api_tokens_created_at_canonical', canonicalTimestamp(table.createdAt)),
    check('api_tokens_updated_at_canonical', canonicalTimestamp(table.updatedAt)),
    check(
      'api_tokens_expiry_after_create',
      sql`${table.expiresAt} is null
        or julianday(${table.expiresAt}) > julianday(${table.createdAt})`,
    ),
    check(
      'api_tokens_last_use_after_create',
      sql`${table.lastUsedAt} is null
        or julianday(${table.lastUsedAt}) >= julianday(${table.createdAt})`,
    ),
    check(
      'api_tokens_revoke_after_create',
      sql`${table.revokedAt} is null
        or julianday(${table.revokedAt}) >= julianday(${table.createdAt})`,
    ),
  ],
)

export const instanceBootstrap = sqliteTable(
  'instance_bootstrap',
  {
    id: integer('id').primaryKey().default(1),
    organizationName: text('organization_name').notNull(),
    ownerFirstName: text('owner_first_name').notNull(),
    ownerLastName: text('owner_last_name').notNull(),
    ownerEmail: text('owner_email').notNull(),
    tokenSelector: text('token_selector').notNull(),
    tokenSecretHash: text('token_secret_hash').notNull(),
    tokenName: text('token_name').notNull(),
    tokenScopes: text('token_scopes', { mode: 'json' }).$type<string[]>().notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    check('instance_bootstrap_singleton', sql`${table.id} = 1`),
    check('instance_bootstrap_organization_name', nonBlankText(table.organizationName)),
    check('instance_bootstrap_owner_first_name', nonBlankText(table.ownerFirstName)),
    check('instance_bootstrap_owner_last_name', nonBlankText(table.ownerLastName)),
    check(
      'instance_bootstrap_owner_email',
      sql`${table.ownerEmail} = lower(${table.ownerEmail})
        and length(${table.ownerEmail}) between 3 and 254`,
    ),
    check(
      'instance_bootstrap_token_selector',
      sql`length(${table.tokenSelector}) = 16
        and ${table.tokenSelector} not glob '*[^A-Za-z0-9_-]*'`,
    ),
    check(
      'instance_bootstrap_token_secret_hash',
      sql`length(${table.tokenSecretHash}) = 64
        and ${table.tokenSecretHash} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'instance_bootstrap_token_scopes',
      sql`json_valid(${table.tokenScopes}) and json_type(${table.tokenScopes}) = 'array'`,
    ),
    check('instance_bootstrap_created_at', canonicalTimestamp(table.createdAt)),
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
    timeEntryNotesMinimumLength: integer('time_entry_notes_minimum_length'),
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
    check(
      'projects_time_entry_notes_minimum_length',
      sql`${table.timeEntryNotesMinimumLength} is null
        or ${table.timeEntryNotesMinimumLength} between 1 and 10000`,
    ),
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
    attachmentPolicy: text('attachment_policy', {
      mode: 'json',
    }).$type<StaticRecurringAttachmentPolicyV1>(),
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

export const estimates = sqliteTable(
  'estimates',
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
    purchaseOrder: text('purchase_order'),
    subject: text('subject'),
    notes: text('notes'),
    currency: text('currency').notNull(),
    state: text('state', { enum: ['draft', 'sent', 'accepted', 'declined'] })
      .notNull()
      .default('draft'),
    version: integer('version').notNull().default(0),
    issueDate: text('issue_date').notNull(),
    sentAt: text('sent_at'),
    acceptedAt: text('accepted_at'),
    declinedAt: text('declined_at'),
    clientKey: text('client_key')
      .notNull()
      .default(sql`lower(hex(randomblob(32)))`),
    taxRatePpm: integer('tax_rate_ppm'),
    tax2RatePpm: integer('tax2_rate_ppm'),
    discountRatePpm: integer('discount_rate_ppm'),
    amountCents: integer('amount_cents').notNull().default(0),
    taxAmountCents: integer('tax_amount_cents').notNull().default(0),
    tax2AmountCents: integer('tax2_amount_cents').notNull().default(0),
    discountAmountCents: integer('discount_amount_cents').notNull().default(0),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('estimates_harvest_id_unique').on(table.harvestId),
    uniqueIndex('estimates_number_unique').on(table.number),
    uniqueIndex('estimates_client_key_unique').on(table.clientKey),
    index('estimates_client_id').on(table.clientId),
    index('estimates_created_by_user_id').on(table.createdByUserId),
    check('estimates_number_nonblank', nonBlankText(table.number)),
    check(
      'estimates_currency_canonical',
      sql`length(${table.currency}) = 3 and ${table.currency} = upper(${table.currency})
        and ${table.currency} not glob '*[^A-Z]*'`,
    ),
    check(
      'estimates_creator_provenance_pair',
      sql`(${table.sourceCreatorId} is null) = (${table.sourceCreatorName} is null)`,
    ),
    check('estimates_issue_date_canonical', sql`date(${table.issueDate}) is ${table.issueDate}`),
    check('estimates_sent_at_canonical', nullableCanonicalTimestamp(table.sentAt)),
    check('estimates_accepted_at_canonical', nullableCanonicalTimestamp(table.acceptedAt)),
    check('estimates_declined_at_canonical', nullableCanonicalTimestamp(table.declinedAt)),
    check('estimates_created_at_canonical', canonicalTimestamp(table.createdAt)),
    check('estimates_updated_at_canonical', canonicalTimestamp(table.updatedAt)),
    check('estimates_version_safe_integer', sql`${table.version} between 0 and 9007199254740991`),
    check(
      'estimates_tax_rate_ppm_range',
      sql`${table.taxRatePpm} is null or ${table.taxRatePpm} between 0 and 1000000`,
    ),
    check(
      'estimates_tax2_rate_ppm_range',
      sql`${table.tax2RatePpm} is null or ${table.tax2RatePpm} between 0 and 1000000`,
    ),
    check(
      'estimates_discount_rate_ppm_range',
      sql`${table.discountRatePpm} is null or ${table.discountRatePpm} between 0 and 1000000`,
    ),
    check('estimates_amount_bound', sql`abs(${table.amountCents}) <= 9000000000000`),
    check('estimates_tax_amount_bound', sql`abs(${table.taxAmountCents}) <= 9000000000000`),
    check('estimates_tax2_amount_bound', sql`abs(${table.tax2AmountCents}) <= 9000000000000`),
    check(
      'estimates_discount_amount_bound',
      sql`abs(${table.discountAmountCents}) <= 9000000000000`,
    ),
  ],
)

export const estimateItemCategories = sqliteTable(
  'estimate_item_categories',
  {
    id: integer('id').primaryKey(),
    harvestId: integer('harvest_id'),
    name: text('name').notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('estimate_item_categories_harvest_id_unique').on(table.harvestId),
    uniqueIndex('estimate_item_categories_name_unique').on(table.name),
    check('estimate_item_categories_name_nonblank', nonBlankText(table.name)),
    check('estimate_item_categories_created_at_canonical', canonicalTimestamp(table.createdAt)),
    check('estimate_item_categories_updated_at_canonical', canonicalTimestamp(table.updatedAt)),
  ],
)

export const estimateLineItems = sqliteTable(
  'estimate_line_items',
  {
    id: integer('id').primaryKey(),
    harvestId: integer('harvest_id'),
    estimateId: integer('estimate_id')
      .notNull()
      .references(() => estimates.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    kind: text('kind').notNull(),
    description: text('description'),
    quantity: real('quantity').notNull(),
    unitPriceCents: integer('unit_price_cents').notNull(),
    amountCents: integer('amount_cents').notNull(),
    taxed: integer('taxed', { mode: 'boolean' }).notNull().default(false),
    taxed2: integer('taxed2', { mode: 'boolean' }).notNull().default(false),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('estimate_line_items_harvest_id_unique').on(table.harvestId),
    uniqueIndex('estimate_line_items_estimate_position_unique').on(
      table.estimateId,
      table.position,
    ),
    index('estimate_line_items_estimate_id').on(table.estimateId),
    check(
      'estimate_line_items_position_safe_integer',
      sql`${table.position} between 0 and 9007199254740991`,
    ),
    check('estimate_line_items_kind_nonblank', nonBlankText(table.kind)),
    check(
      'estimate_line_items_quantity_finite',
      sql`${table.quantity} between -9007199254740991 and 9007199254740991`,
    ),
    check(
      'estimate_line_items_unit_price_bound',
      sql`abs(${table.unitPriceCents}) <= 9000000000000`,
    ),
    check('estimate_line_items_amount_bound', sql`abs(${table.amountCents}) <= 9000000000000`),
    check('estimate_line_items_taxed_boolean', sql`${table.taxed} in (0, 1)`),
    check('estimate_line_items_taxed2_boolean', sql`${table.taxed2} in (0, 1)`),
    check('estimate_line_items_created_at_canonical', canonicalTimestamp(table.createdAt)),
    check('estimate_line_items_updated_at_canonical', canonicalTimestamp(table.updatedAt)),
  ],
)

export const estimateMessages = sqliteTable(
  'estimate_messages',
  {
    id: integer('id').primaryKey(),
    harvestId: integer('harvest_id'),
    estimateId: integer('estimate_id')
      .notNull()
      .references(() => estimates.id, { onDelete: 'cascade' }),
    sentBy: text('sent_by'),
    sentByEmail: text('sent_by_email'),
    sentFrom: text('sent_from'),
    sentFromEmail: text('sent_from_email'),
    recipients: text('recipients', { mode: 'json' })
      .$type<EstimateRecipient[]>()
      .notNull()
      .default([]),
    subject: text('subject'),
    body: text('body'),
    sendMeACopy: integer('send_me_a_copy', { mode: 'boolean' }).notNull().default(false),
    eventType: text('event_type', {
      enum: ['send', 'accept', 'decline', 're-open', 'view', 'invoice'],
    }),
    deliveryStatus: text('delivery_status', {
      enum: ['queued', 'sent', 'bounced', 'complained', 'failed'],
    }),
    providerMessageId: text('provider_message_id'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('estimate_messages_harvest_id_unique').on(table.harvestId),
    uniqueIndex('estimate_messages_invoice_event_unique')
      .on(table.estimateId)
      .where(sql`${table.eventType} = 'invoice'`),
    index('estimate_messages_estimate_created_id').on(table.estimateId, table.createdAt, table.id),
    index('estimate_messages_provider_message_id')
      .on(table.providerMessageId)
      .where(sql`${table.providerMessageId} is not null`),
    check(
      'estimate_messages_recipients_json',
      sql`json_valid(${table.recipients}) and json_type(${table.recipients}) = 'array'`,
    ),
    check(
      'estimate_messages_send_recipients',
      sql`${table.eventType} is not 'send' or json_array_length(${table.recipients}) > 0`,
    ),
    check('estimate_messages_copy_boolean', sql`${table.sendMeACopy} in (0, 1)`),
    check('estimate_messages_created_at_canonical', canonicalTimestamp(table.createdAt)),
    check('estimate_messages_updated_at_canonical', canonicalTimestamp(table.updatedAt)),
  ],
)

export const estimateCommandLedger = sqliteTable(
  'estimate_command_ledger',
  {
    estimateId: integer('estimate_id')
      .notNull()
      .references(() => estimates.id, { onDelete: 'restrict' }),
    commandId: text('command_id').notNull(),
    commandKind: text('command_kind', {
      enum: [
        'estimate.send',
        'estimate.accept',
        'estimate.decline',
        'estimate.re-open',
        'estimate.convert',
      ],
    }).notNull(),
    inputFingerprint: text('input_fingerprint').notNull(),
    actorUserId: integer('actor_user_id').notNull(),
    expectedEstimateVersion: integer('expected_estimate_version').notNull(),
    messageId: integer('message_id').notNull(),
    invoiceId: integer('invoice_id'),
    eventId: text('event_id'),
    occurredAt: text('occurred_at').notNull(),
    completed: integer('completed', { mode: 'boolean' }).notNull().default(false),
    resultJson: text('result_json', { mode: 'json' }).$type<Record<string, unknown>>(),
    completedAt: text('completed_at'),
  },
  (table) => [
    primaryKey({ columns: [table.estimateId, table.commandId] }),
    uniqueIndex('estimate_command_ledger_message_id_unique').on(table.messageId),
    uniqueIndex('estimate_command_ledger_invoice_id_unique')
      .on(table.invoiceId)
      .where(sql`${table.invoiceId} is not null`),
    uniqueIndex('estimate_command_ledger_event_id_unique')
      .on(table.eventId)
      .where(sql`${table.eventId} is not null`),
    check(
      'estimate_command_ledger_command_id_format',
      sql`length(${table.commandId}) between 1 and 128
        and ${table.commandId} not glob '*[^A-Za-z0-9._:-]*'`,
    ),
    check(
      'estimate_command_ledger_fingerprint_format',
      sql`length(${table.inputFingerprint}) = 71
        and substr(${table.inputFingerprint}, 1, 7) = 'sha256:'
        and substr(${table.inputFingerprint}, 8) not glob '*[^0-9a-f]*'`,
    ),
    check(
      'estimate_command_ledger_expected_version_safe',
      sql`${table.expectedEstimateVersion} between 0 and 9007199254740991`,
    ),
    check(
      'estimate_command_ledger_conversion_shape',
      sql`(${table.commandKind} = 'estimate.convert'
          and ${table.invoiceId} is not null and ${table.eventId} is not null)
        or (${table.commandKind} <> 'estimate.convert'
          and ${table.invoiceId} is null and ${table.eventId} is null)`,
    ),
    check('estimate_command_ledger_occurred_at_canonical', canonicalTimestamp(table.occurredAt)),
    check('estimate_command_ledger_completed_boolean', sql`${table.completed} in (0, 1)`),
    check(
      'estimate_command_ledger_completion_shape',
      sql`(${table.completed} = 0 and ${table.resultJson} is null and ${table.completedAt} is null)
        or (${table.completed} = 1 and ${table.resultJson} is not null
          and json_valid(${table.resultJson})
          and json_extract(${table.resultJson}, '$.schema_version') = 1
          and ${table.completedAt} is not null)`,
    ),
    check(
      'estimate_command_ledger_completed_at_canonical',
      nullableCanonicalTimestamp(table.completedAt),
    ),
  ],
)

export const resourceCreateCommands = sqliteTable(
  'resource_create_commands',
  {
    commandKind: text('command_kind', {
      enum: [
        'retainer.create',
        'recurring_invoice.create',
        'invoice_attachment.create',
        'recurring_invoice_attachment.create',
        'estimate_attachment.create',
        'expense_attachment.create',
        'project_attachment.create',
      ],
    }).notNull(),
    commandId: text('command_id').notNull(),
    inputFingerprint: text('input_fingerprint').notNull(),
    actorUserId: integer('actor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    resourceId: integer('resource_id').notNull(),
    resultJson: text('result_json', { mode: 'json' })
      .$type<{ schema_version: 1; data: Record<string, unknown> }>()
      .notNull(),
    occurredAt: text('occurred_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.commandKind, table.commandId] }),
    uniqueIndex('resource_create_commands_resource_unique').on(table.commandKind, table.resourceId),
    check(
      'resource_create_commands_command_id_format',
      sql`length(${table.commandId}) between 1 and 128
        and ${table.commandId} not glob '*[^A-Za-z0-9._:-]*'`,
    ),
    check(
      'resource_create_commands_fingerprint_format',
      sql`length(${table.inputFingerprint}) = 71
        and substr(${table.inputFingerprint}, 1, 7) = 'sha256:'
        and substr(${table.inputFingerprint}, 8) not glob '*[^0-9a-f]*'`,
    ),
    check(
      'resource_create_commands_resource_id_safe',
      sql`${table.resourceId} between 1 and 9007199254740991`,
    ),
    check(
      'resource_create_commands_result_shape',
      sql`json_valid(${table.resultJson})
        and json_extract(${table.resultJson}, '$.schema_version') = 1
        and json_type(${table.resultJson}, '$.data') = 'object'`,
    ),
    check('resource_create_commands_occurred_at_canonical', canonicalTimestamp(table.occurredAt)),
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
    estimateId: integer('estimate_id').references(() => estimates.id, { onDelete: 'restrict' }),
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
    index('invoices_estimate_id').on(table.estimateId),
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
    timesheetSubmissionId: integer('timesheet_submission_id').references(
      () => timesheetSubmissions.id,
      { onDelete: 'restrict' },
    ),
    sourceApprovalStatus: text('source_approval_status', {
      enum: ['unsubmitted', 'submitted', 'approved'],
    }),
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
    index('expenses_timesheet_submission_id')
      .on(table.timesheetSubmissionId)
      .where(sql`${table.timesheetSubmissionId} is not null`),
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

/** Immutable content identity. Binary placement is provided by the D17 storage adapter. */
export const fileObjects = sqliteTable(
  'file_objects',
  {
    id: integer('id').primaryKey(),
    contentHash: text('content_hash').notNull().unique(),
    fileKey: text('file_key').notNull().unique(),
    byteSize: integer('byte_size').notNull(),
    contentType: text('content_type').notNull(),
    ...timestamps,
  },
  (table) => [
    check(
      'file_objects_content_hash_canonical',
      sql`length(${table.contentHash}) = 64 and ${table.contentHash} not glob '*[^0-9a-f]*'`,
    ),
    check(
      'file_objects_file_key_nonblank',
      sql`length(${table.fileKey}) between 1 and 1024 and ${nonBlankText(table.fileKey)}`,
    ),
    check(
      'file_objects_byte_size_safe_integer',
      sql`${table.byteSize} between 0 and 9007199254740991`,
    ),
    check(
      'file_objects_content_type_nonblank',
      sql`length(${table.contentType}) between 1 and 255 and ${nonBlankText(table.contentType)}`,
    ),
    check('file_objects_created_at_canonical', canonicalTimestamp(table.createdAt)),
    check('file_objects_updated_at_canonical', canonicalTimestamp(table.updatedAt)),
  ],
)

/**
 * A logical attachment. The five same-id guards are the Drizzle representation of
 * the migration's deferred owner FKs; exactly one owner-specific join must exist.
 */
export const attachments = sqliteTable(
  'attachments',
  {
    id: integer('id').primaryKey(),
    fileObjectId: integer('file_object_id')
      .notNull()
      .references(() => fileObjects.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    uploadedByUserId: integer('uploaded_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    invoiceAttachmentLinkId: integer('invoice_attachment_link_id').unique(),
    recurringInvoiceAttachmentLinkId: integer('recurring_invoice_attachment_link_id').unique(),
    estimateAttachmentLinkId: integer('estimate_attachment_link_id').unique(),
    expenseAttachmentLinkId: integer('expense_attachment_link_id').unique(),
    projectAttachmentLinkId: integer('project_attachment_link_id').unique(),
    ...timestamps,
  },
  (table) => [
    index('attachments_file_object_id').on(table.fileObjectId),
    index('attachments_uploaded_by_user_id')
      .on(table.uploadedByUserId)
      .where(sql`${table.uploadedByUserId} is not null`),
    check(
      'attachments_name_nonblank',
      sql`length(${table.name}) between 1 and 255 and ${nonBlankText(table.name)}`,
    ),
    check(
      'attachments_exactly_one_owner',
      sql`(${table.invoiceAttachmentLinkId} is not null)
        + (${table.recurringInvoiceAttachmentLinkId} is not null)
        + (${table.estimateAttachmentLinkId} is not null)
        + (${table.expenseAttachmentLinkId} is not null)
        + (${table.projectAttachmentLinkId} is not null) = 1`,
    ),
    check(
      'attachments_invoice_guard_same_id',
      sql`${table.invoiceAttachmentLinkId} is null or ${table.invoiceAttachmentLinkId} = ${table.id}`,
    ),
    check(
      'attachments_recurring_guard_same_id',
      sql`${table.recurringInvoiceAttachmentLinkId} is null or ${table.recurringInvoiceAttachmentLinkId} = ${table.id}`,
    ),
    check(
      'attachments_estimate_guard_same_id',
      sql`${table.estimateAttachmentLinkId} is null or ${table.estimateAttachmentLinkId} = ${table.id}`,
    ),
    check(
      'attachments_expense_guard_same_id',
      sql`${table.expenseAttachmentLinkId} is null or ${table.expenseAttachmentLinkId} = ${table.id}`,
    ),
    check(
      'attachments_project_guard_same_id',
      sql`${table.projectAttachmentLinkId} is null or ${table.projectAttachmentLinkId} = ${table.id}`,
    ),
    check('attachments_created_at_canonical', canonicalTimestamp(table.createdAt)),
    check('attachments_updated_at_canonical', canonicalTimestamp(table.updatedAt)),
  ],
)

export const invoiceAttachments = sqliteTable(
  'invoice_attachments',
  {
    attachmentId: integer('attachment_id')
      .primaryKey()
      .references(() => attachments.id, { onDelete: 'cascade' }),
    invoiceId: integer('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'restrict' }),
  },
  (table) => [index('invoice_attachments_invoice_id').on(table.invoiceId, table.attachmentId)],
)

export const recurringInvoiceAttachments = sqliteTable(
  'recurring_invoice_attachments',
  {
    attachmentId: integer('attachment_id')
      .primaryKey()
      .references(() => attachments.id, { onDelete: 'cascade' }),
    recurringInvoiceId: integer('recurring_invoice_id')
      .notNull()
      .references(() => recurringInvoices.id, { onDelete: 'restrict' }),
  },
  (table) => [
    index('recurring_invoice_attachments_recurring_invoice_id').on(
      table.recurringInvoiceId,
      table.attachmentId,
    ),
  ],
)

export const estimateAttachments = sqliteTable(
  'estimate_attachments',
  {
    attachmentId: integer('attachment_id')
      .primaryKey()
      .references(() => attachments.id, { onDelete: 'cascade' }),
    estimateId: integer('estimate_id')
      .notNull()
      .references(() => estimates.id, { onDelete: 'restrict' }),
  },
  (table) => [index('estimate_attachments_estimate_id').on(table.estimateId, table.attachmentId)],
)

export const expenseAttachments = sqliteTable(
  'expense_attachments',
  {
    attachmentId: integer('attachment_id')
      .primaryKey()
      .references(() => attachments.id, { onDelete: 'cascade' }),
    expenseId: integer('expense_id')
      .notNull()
      .references(() => expenses.id, { onDelete: 'restrict' }),
  },
  (table) => [index('expense_attachments_expense_id').on(table.expenseId, table.attachmentId)],
)

export const projectAttachments = sqliteTable(
  'project_attachments',
  {
    attachmentId: integer('attachment_id')
      .primaryKey()
      .references(() => attachments.id, { onDelete: 'cascade' }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
  },
  (table) => [index('project_attachments_project_id').on(table.projectId, table.attachmentId)],
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

export const emailLog = sqliteTable(
  'email_log',
  {
    id: integer('id').primaryKey(),
    from: text('from_json', { mode: 'json' }).$type<EmailSender | null>(),
    replyTo: text('reply_to_json', { mode: 'json' }).$type<EmailRecipient[] | null>(),
    to: text('to_json', { mode: 'json' }).$type<EmailRecipient[]>().notNull(),
    template: text('template').notNull(),
    subject: text('subject').notNull(),
    provider: text('provider'),
    providerMessageId: text('provider_message_id'),
    providerRequestId: text('provider_request_id'),
    providerLatencyMs: integer('provider_latency_ms'),
    status: text('status', {
      enum: ['queued', 'sent', 'bounced', 'complained', 'failed'],
    })
      .notNull()
      .default('queued'),
    relatedType: text('related_type'),
    relatedId: integer('related_id'),
    attemptCount: integer('attempt_count').notNull().default(0),
    activeAttemptId: text('active_attempt_id'),
    attemptLeaseExpiresAt: text('attempt_lease_expires_at'),
    failureCode: text('failure_code').$type<EmailFailureCode | null>(),
    failureReason: text('failure_reason'),
    ...timestamps,
  },
  (table) => [
    index('email_log_status_created_id').on(table.status, table.createdAt, table.id),
    index('email_log_related_created_id')
      .on(table.relatedType, table.relatedId, table.createdAt, table.id)
      .where(sql`${table.relatedType} is not null`),
    index('email_log_provider_message_id')
      .on(table.provider, table.providerMessageId)
      .where(sql`${table.providerMessageId} is not null`),
    check(
      'email_log_to_json',
      sql`json_valid(${table.to}) and json_type(${table.to}) = 'array'
        and json_array_length(${table.to}) between 1 and 100`,
    ),
    check(
      'email_log_related_pair',
      sql`(${table.relatedType} is null) = (${table.relatedId} is null)`,
    ),
    check(
      'email_log_attempt_count_safe',
      sql`${table.attemptCount} between 0 and 9007199254740991`,
    ),
    check(
      'email_log_provider_latency_safe',
      sql`${table.providerLatencyMs} is null or ${table.providerLatencyMs} between 0 and 3000000`,
    ),
    check(
      'email_log_provider_request_id_safe',
      sql`${table.providerRequestId} is null or length(trim(${table.providerRequestId})) between 1 and 512`,
    ),
    check(
      'email_log_failure_reason_safe',
      sql`${table.failureReason} is null or (
        length(${table.failureReason}) between 1 and 128
        and ${table.failureReason} not glob '*[^A-Za-z0-9_:]*'
      )`,
    ),
    check(
      'email_log_delivery_details_status',
      sql`(
        (${table.providerRequestId} is null and ${table.providerLatencyMs} is null)
        or ${table.status} in ('sent','bounced','complained')
      ) and (
        ${table.failureReason} is null
        or (${table.status} = 'failed' and ${table.failureCode} = 'provider_rejected')
      )`,
    ),
    check(
      'email_log_attempt_lease_pair',
      sql`(${table.activeAttemptId} is null) = (${table.attemptLeaseExpiresAt} is null)`,
    ),
    check(
      'email_log_attempt_lease_expires_at_canonical',
      nullableCanonicalTimestamp(table.attemptLeaseExpiresAt),
    ),
    check('email_log_created_at_canonical', canonicalTimestamp(table.createdAt)),
    check('email_log_updated_at_canonical', canonicalTimestamp(table.updatedAt)),
  ],
)

export const emailTemplateVersions = sqliteTable(
  'email_template_versions',
  {
    templateKind: text('template_kind', {
      enum: [
        'invoice',
        'reminder',
        'thank_you',
        'auth_email_verification',
        'auth_password_reset',
      ],
    }).notNull(),
    version: integer('version').notNull(),
    subjectTemplate: text('subject_template').notNull(),
    textTemplate: text('text_template').notNull(),
    htmlTemplate: text('html_template'),
    unknownVariablePolicy: text('unknown_variable_policy', {
      enum: ['error', 'literal'],
    })
      .notNull()
      .default('error'),
    createdByUserId: integer('created_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.templateKind, table.version] }),
    check(
      'email_template_versions_version_safe',
      sql`${table.version} between 1 and 9007199254740991`,
    ),
    check(
      'email_template_versions_subject_safe',
      sql`length(trim(${table.subjectTemplate})) between 1 and 998`,
    ),
    check(
      'email_template_versions_text_safe',
      sql`length(trim(${table.textTemplate})) between 1 and 1000000`,
    ),
    check(
      'email_template_versions_html_safe',
      sql`${table.htmlTemplate} is null or length(trim(${table.htmlTemplate})) between 1 and 2000000`,
    ),
    check(
      'email_template_versions_created_at_canonical',
      canonicalTimestamp(table.createdAt),
    ),
  ],
)

export const emailTemplateHeads = sqliteTable(
  'email_template_heads',
  {
    templateKind: text('template_kind', {
      enum: [
        'invoice',
        'reminder',
        'thank_you',
        'auth_email_verification',
        'auth_password_reset',
      ],
    }).primaryKey(),
    currentVersion: integer('current_version').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.templateKind, table.currentVersion],
      foreignColumns: [
        emailTemplateVersions.templateKind,
        emailTemplateVersions.version,
      ],
    }).onDelete('restrict'),
    check(
      'email_template_heads_version_safe',
      sql`${table.currentVersion} between 1 and 9007199254740991`,
    ),
    check(
      'email_template_heads_updated_at_canonical',
      canonicalTimestamp(table.updatedAt),
    ),
  ],
)

export const emailTemplateCommands = sqliteTable(
  'email_template_commands',
  {
    commandId: text('command_id').primaryKey(),
    templateKind: text('template_kind', {
      enum: [
        'invoice',
        'reminder',
        'thank_you',
        'auth_email_verification',
        'auth_password_reset',
      ],
    }).notNull(),
    expectedVersion: integer('expected_version').notNull(),
    resultVersion: integer('result_version').notNull(),
    actorUserId: integer('actor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    inputFingerprint: text('input_fingerprint').notNull(),
    occurredAt: text('occurred_at').notNull(),
    result: text('result_json', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.templateKind, table.resultVersion],
      foreignColumns: [
        emailTemplateVersions.templateKind,
        emailTemplateVersions.version,
      ],
    }).onDelete('restrict'),
    check(
      'email_template_commands_id_format',
      sql`length(${table.commandId}) between 1 and 128
        and ${table.commandId} not glob '*[^A-Za-z0-9._:-]*'`,
    ),
    check(
      'email_template_commands_version_shape',
      sql`${table.expectedVersion} between 1 and 9007199254740991
        and ${table.resultVersion} = ${table.expectedVersion} + 1`,
    ),
    check(
      'email_template_commands_occurred_at_canonical',
      canonicalTimestamp(table.occurredAt),
    ),
    check(
      'email_template_commands_fingerprint_shape',
      sql`length(${table.inputFingerprint}) = 71
        and substr(${table.inputFingerprint}, 1, 7) = 'sha256:'
        and substr(${table.inputFingerprint}, 8) not glob '*[^0-9a-f]*'`,
    ),
    check(
      'email_template_commands_result_json',
      sql`json_valid(${table.result}) and json_type(${table.result}) = 'object'`,
    ),
  ],
)

export const senderIdentities = sqliteTable(
  'sender_identities',
  {
    id: integer('id').primaryKey(),
    email: text('email').notNull().unique(),
    displayName: text('display_name').notNull(),
    replyToEmail: text('reply_to_email'),
    provider: text('provider').notNull(),
    providerIdentity: text('provider_identity').notNull(),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    version: integer('version').notNull().default(0),
    archivedAt: text('archived_at'),
    createdByUserId: integer('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('sender_identities_default_unique')
      .on(table.isDefault)
      .where(sql`${table.isDefault} = 1 and ${table.archivedAt} is null`),
    uniqueIndex('sender_identities_provider_binding_unique').on(
      table.provider,
      table.providerIdentity,
      table.email,
    ),
    check(
      'sender_identities_version_safe',
      sql`${table.version} between 0 and 9007199254740991`,
    ),
    check(
      'sender_identities_created_at_canonical',
      canonicalTimestamp(table.createdAt),
    ),
    check(
      'sender_identities_updated_at_canonical',
      canonicalTimestamp(table.updatedAt),
    ),
    check(
      'sender_identities_archived_at_canonical',
      nullableCanonicalTimestamp(table.archivedAt),
    ),
  ],
)

export const senderIdentityEvidence = sqliteTable(
  'sender_identity_evidence',
  {
    senderIdentityId: integer('sender_identity_id')
      .notNull()
      .references(() => senderIdentities.id, { onDelete: 'restrict' }),
    evidenceVersion: integer('evidence_version').notNull(),
    source: text('source', {
      enum: ['provider_api', 'deployment_config'],
    }).notNull(),
    identityKind: text('identity_kind', {
      enum: ['email_address', 'domain'],
    }).notNull(),
    verificationStatus: text('verification_status', {
      enum: [
        'pending',
        'verified',
        'failed',
        'temporary_failure',
        'operator_configured',
      ],
    }).notNull(),
    dkimStatus: text('dkim_status', {
      enum: ['pending', 'verified', 'failed', 'not_applicable'],
    }).notNull(),
    mailFromDomain: text('mail_from_domain'),
    mailFromStatus: text('mail_from_status', {
      enum: ['pending', 'verified', 'failed', 'not_configured'],
    }).notNull(),
    observedAt: text('observed_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.senderIdentityId, table.evidenceVersion] }),
    index('sender_identity_evidence_latest').on(
      table.senderIdentityId,
      table.evidenceVersion,
    ),
    check(
      'sender_identity_evidence_version_safe',
      sql`${table.evidenceVersion} between 1 and 9007199254740991`,
    ),
    check(
      'sender_identity_evidence_observed_at_canonical',
      canonicalTimestamp(table.observedAt),
    ),
    check(
      'sender_identity_evidence_mail_from_shape',
      sql`(${table.mailFromDomain} is null) = (${table.mailFromStatus} = 'not_configured')`,
    ),
  ],
)

export const senderIdentityCommands = sqliteTable(
  'sender_identity_commands',
  {
    commandId: text('command_id').primaryKey(),
    commandKind: text('command_kind', {
      enum: [
        'sender.create',
        'sender.update',
        'sender.default',
        'sender.archive',
        'sender.evidence',
      ],
    }).notNull(),
    senderIdentityId: integer('sender_identity_id')
      .notNull()
      .references(() => senderIdentities.id, { onDelete: 'restrict' }),
    actorUserId: integer('actor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    inputFingerprint: text('input_fingerprint').notNull(),
    occurredAt: text('occurred_at').notNull(),
    result: text('result_json', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [
    check(
      'sender_identity_commands_id_format',
      sql`length(${table.commandId}) between 1 and 128
        and ${table.commandId} not glob '*[^A-Za-z0-9._:-]*'`,
    ),
    check(
      'sender_identity_commands_occurred_at_canonical',
      canonicalTimestamp(table.occurredAt),
    ),
    check(
      'sender_identity_commands_fingerprint_shape',
      sql`length(${table.inputFingerprint}) = 71
        and substr(${table.inputFingerprint}, 1, 7) = 'sha256:'
        and substr(${table.inputFingerprint}, 8) not glob '*[^0-9a-f]*'`,
    ),
    check(
      'sender_identity_commands_result_json',
      sql`json_valid(${table.result}) and json_type(${table.result}) = 'object'`,
    ),
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

export const outboxDeliveryReceipts = sqliteTable(
  'outbox_delivery_receipts',
  {
    subscriberId: text('subscriber_id').notNull(),
    eventId: text('event_id')
      .notNull()
      .references(() => eventOutbox.id, { onDelete: 'restrict' }),
    status: text('status', {
      enum: ['pending', 'processing', 'delivered', 'failed'],
    })
      .notNull()
      .default('pending'),
    attemptCount: integer('attempt_count').notNull().default(0),
    nextAttemptAt: text('next_attempt_at'),
    activeAttemptId: text('active_attempt_id'),
    attemptLeaseExpiresAt: text('attempt_lease_expires_at'),
    lastErrorCode: text('last_error_code', {
      enum: ['subscriber_timeout', 'subscriber_rejected'],
    }),
    deliveredAt: text('delivered_at'),
    failedAt: text('failed_at'),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.subscriberId, table.eventId] }),
    index('outbox_delivery_receipts_ready').on(
      table.subscriberId,
      table.status,
      table.nextAttemptAt,
      table.updatedAt,
      table.eventId,
    ),
    index('outbox_delivery_receipts_failures')
      .on(table.status, table.failedAt, table.subscriberId, table.eventId)
      .where(sql`${table.status} = 'failed'`),
    check(
      'outbox_delivery_receipts_subscriber_id_format',
      sql`length(${table.subscriberId}) between 1 and 128
        and ${table.subscriberId} not glob '*[^A-Za-z0-9._:-]*'`,
    ),
    check(
      'outbox_delivery_receipts_attempt_count_safe',
      sql`${table.attemptCount} between 0 and 9007199254740991`,
    ),
    check(
      'outbox_delivery_receipts_active_attempt_format',
      sql`${table.activeAttemptId} is null or (
        length(${table.activeAttemptId}) between 1 and 128
        and ${table.activeAttemptId} not glob '*[^A-Za-z0-9._:-]*'
      )`,
    ),
    check(
      'outbox_delivery_receipts_attempt_pair',
      sql`(${table.activeAttemptId} is null) = (${table.attemptLeaseExpiresAt} is null)`,
    ),
    check(
      'outbox_delivery_receipts_next_attempt_canonical',
      nullableCanonicalTimestamp(table.nextAttemptAt),
    ),
    check(
      'outbox_delivery_receipts_lease_canonical',
      nullableCanonicalTimestamp(table.attemptLeaseExpiresAt),
    ),
    check(
      'outbox_delivery_receipts_delivered_canonical',
      nullableCanonicalTimestamp(table.deliveredAt),
    ),
    check(
      'outbox_delivery_receipts_failed_canonical',
      nullableCanonicalTimestamp(table.failedAt),
    ),
    check('outbox_delivery_receipts_created_canonical', canonicalTimestamp(table.createdAt)),
    check('outbox_delivery_receipts_updated_canonical', canonicalTimestamp(table.updatedAt)),
    check(
      'outbox_delivery_receipts_timestamp_order',
      sql`julianday(${table.updatedAt}) >= julianday(${table.createdAt})`,
    ),
    check(
      'outbox_delivery_receipts_state_shape',
      sql`(
          ${table.status} = 'pending' and ${table.activeAttemptId} is null
          and ${table.deliveredAt} is null and ${table.failedAt} is null
        ) or (
          ${table.status} = 'processing' and ${table.activeAttemptId} is not null
          and ${table.nextAttemptAt} is null and ${table.deliveredAt} is null
          and ${table.failedAt} is null and ${table.attemptCount} > 0
        ) or (
          ${table.status} = 'delivered' and ${table.activeAttemptId} is null
          and ${table.nextAttemptAt} is null and ${table.lastErrorCode} is null
          and ${table.deliveredAt} is not null and ${table.failedAt} is null
        ) or (
          ${table.status} = 'failed' and ${table.activeAttemptId} is null
          and ${table.nextAttemptAt} is null and ${table.lastErrorCode} is not null
          and ${table.deliveredAt} is null and ${table.failedAt} is not null
        )`,
    ),
  ],
)

export const activityLog = sqliteTable(
  'activity_log',
  {
    eventId: text('event_id')
      .primaryKey()
      .references(() => eventOutbox.id, { onDelete: 'restrict' }),
    recordedAt: text('recorded_at').notNull(),
  },
  (table) => [
    index('activity_log_recorded_event').on(table.recordedAt, table.eventId),
    check('activity_log_recorded_at_canonical', canonicalTimestamp(table.recordedAt)),
  ],
)

export const invoiceCommandLedger = sqliteTable(
  'invoice_command_ledger',
  {
    invoiceId: integer('invoice_id').notNull(),
    commandId: text('command_id').notNull(),
    commandKind: text('command_kind', {
      enum: [
        'invoice.create',
        'invoice.delete',
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
    requestJson: text('request_json', { mode: 'json' }).$type<Record<string, unknown>>(),
    sourceManifestJson: text('source_manifest_json', { mode: 'json' }).$type<
      Record<string, unknown>
    >(),
    lineManifestJson: text('line_manifest_json', { mode: 'json' }).$type<
      Record<string, unknown>
    >(),
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
    check(
      'invoice_command_ledger_creation_manifests',
      sql`(${table.commandKind} = 'invoice.create' and coalesce((
          json_valid(${table.requestJson}) and json_type(${table.requestJson}) = 'object'
          and json_extract(${table.requestJson}, '$.schema_version') = 1
          and json_type(${table.requestJson}, '$.schema_version') = 'integer'
          and json_extract(${table.requestJson}, '$.expected_version') = 0
          and json_type(${table.requestJson}, '$.expected_version') = 'integer'
          and json_type(${table.requestJson}, '$.client_id') = 'integer'
          and json_extract(${table.requestJson}, '$.client_id') > 0
          and json_type(${table.requestJson}, '$.from') = 'text'
          and date(json_extract(${table.requestJson}, '$.from'))
            = json_extract(${table.requestJson}, '$.from')
          and json_type(${table.requestJson}, '$.to') = 'text'
          and date(json_extract(${table.requestJson}, '$.to'))
            = json_extract(${table.requestJson}, '$.to')
          and json_extract(${table.requestJson}, '$.from')
            <= json_extract(${table.requestJson}, '$.to')
          and json_type(${table.requestJson}, '$.project_ids') = 'array'
          and json_array_length(${table.requestJson}, '$.project_ids') > 0
          and (json_type(${table.requestJson}, '$.time_summary_type') in ('text','null')
            and (json_extract(${table.requestJson}, '$.time_summary_type') is null
              or json_extract(${table.requestJson}, '$.time_summary_type')
                in ('project','task','people','detailed')))
          and (json_type(${table.requestJson}, '$.expense_summary_type') in ('text','null')
            and (json_extract(${table.requestJson}, '$.expense_summary_type') is null
              or json_extract(${table.requestJson}, '$.expense_summary_type')
                in ('project','category','people','detailed')))
          and json_type(${table.requestJson}, '$.currency') = 'text'
          and length(json_extract(${table.requestJson}, '$.currency')) = 3
          and json_type(${table.requestJson}, '$.amount_cents') = 'integer'
          and json_extract(${table.requestJson}, '$.amount_cents') >= 0
          and json_type(${table.requestJson}, '$.line_count') = 'integer'
          and json_extract(${table.requestJson}, '$.line_count') > 0
          and json_type(${table.requestJson}, '$.time_entry_count') = 'integer'
          and json_extract(${table.requestJson}, '$.time_entry_count') >= 0
          and json_type(${table.requestJson}, '$.expense_count') = 'integer'
          and json_extract(${table.requestJson}, '$.expense_count') >= 0
          and json_valid(${table.sourceManifestJson})
          and json_type(${table.sourceManifestJson}) = 'object'
          and json_extract(${table.sourceManifestJson}, '$.schema_version') = 1
          and json_type(${table.sourceManifestJson}, '$.time_entries') = 'array'
          and json_type(${table.sourceManifestJson}, '$.expenses') = 'array'
          and json_valid(${table.lineManifestJson})
          and json_type(${table.lineManifestJson}) = 'object'
          and json_extract(${table.lineManifestJson}, '$.schema_version') = 1
          and json_type(${table.lineManifestJson}, '$.lines') = 'array'
        ), 0))
        or (${table.commandKind} <> 'invoice.create'
          and ${table.requestJson} is null and ${table.sourceManifestJson} is null
          and ${table.lineManifestJson} is null)`,
    ),
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

export const invoiceNumberSequence = sqliteTable(
  'invoice_number_sequence',
  {
    singleton: integer('singleton').primaryKey(),
    nextNumber: integer('next_number').notNull(),
  },
  (table) => [
    check('invoice_number_sequence_singleton', sql`${table.singleton} = 1`),
    check(
      'invoice_number_sequence_safe',
      sql`${table.nextNumber} between 1 and 9007199254740991`,
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
    timeEntryNotesMinimumLength: integer('time_entry_notes_minimum_length'),
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
    check(
      'user_assignments_time_entry_notes_minimum_length',
      sql`${table.timeEntryNotesMinimumLength} is null
        or ${table.timeEntryNotesMinimumLength} between 1 and 10000`,
    ),
  ],
)

export const timesheetSubmissions = sqliteTable(
  'timesheet_submissions',
  {
    id: integer('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    periodStart: text('period_start').notNull(),
    periodEnd: text('period_end').notNull(),
    status: text('status', { enum: ['unsubmitted', 'submitted', 'approved'] }).notNull(),
    origin: text('origin', {
      enum: ['native', 'harvest_import', 'legacy_backfill'],
    })
      .notNull()
      .default('native'),
    sourceStatus: text('source_status', { enum: ['submitted', 'approved'] }),
    sourceObservedAt: text('source_observed_at'),
    submittedByUserId: integer('submitted_by_user_id')
      .references(() => users.id, { onDelete: 'restrict' }),
    submittedAt: text('submitted_at'),
    reviewedByUserId: integer('reviewed_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    reviewedAt: text('reviewed_at'),
    rejectionReason: text('rejection_reason'),
    version: integer('version').notNull().default(0),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('timesheet_submissions_user_period_unique').on(
      table.userId,
      table.periodStart,
      table.periodEnd,
    ),
    index('timesheet_submissions_queue').on(
      table.status,
      sql`coalesce(${table.submittedAt}, ${table.sourceObservedAt})`,
      table.id,
    ),
    check(
      'timesheet_submissions_status_valid',
      sql`${table.status} in ('unsubmitted', 'submitted', 'approved')`,
    ),
    check('timesheet_submissions_period_start_date', sql`date(${table.periodStart}) is ${table.periodStart}`),
    check('timesheet_submissions_period_end_date', sql`date(${table.periodEnd}) is ${table.periodEnd}`),
    check('timesheet_submissions_period_order', sql`${table.periodEnd} >= ${table.periodStart}`),
    check(
      'timesheet_submissions_period_length',
      sql`julianday(${table.periodEnd}) - julianday(${table.periodStart}) between 0 and 30`,
    ),
    check(
      'timesheet_submissions_self_submit',
      sql`${table.submittedByUserId} is null or ${table.submittedByUserId} = ${table.userId}`,
    ),
    check('timesheet_submissions_version_safe', sql`${table.version} between 0 and 9007199254740991`),
    check(
      'timesheet_submissions_submitted_at_canonical',
      nullableCanonicalTimestamp(table.submittedAt),
    ),
    check(
      'timesheet_submissions_source_observed_at_canonical',
      nullableCanonicalTimestamp(table.sourceObservedAt),
    ),
    check('timesheet_submissions_reviewed_at_canonical', nullableCanonicalTimestamp(table.reviewedAt)),
    check(
      'timesheet_submissions_review_state_consistent',
      sql`(
        (${table.status} = 'submitted' AND ${table.reviewedByUserId} IS NULL
          AND ${table.reviewedAt} IS NULL AND ${table.rejectionReason} IS NULL
          AND ((${table.submittedByUserId} IS NOT NULL AND ${table.submittedAt} IS NOT NULL)
            OR (${table.origin} <> 'native' AND ${table.version} = 0
              AND ${table.sourceStatus} = 'submitted'
              AND ${table.submittedByUserId} IS NULL AND ${table.submittedAt} IS NULL)))
        OR (${table.status} = 'approved' AND ${table.rejectionReason} IS NULL AND (
          (${table.reviewedByUserId} IS NOT NULL AND ${table.reviewedAt} IS NOT NULL
            AND ((${table.submittedByUserId} IS NOT NULL AND ${table.submittedAt} IS NOT NULL)
              OR (${table.origin} <> 'native' AND ${table.sourceStatus} = 'submitted'
                AND ${table.submittedByUserId} IS NULL AND ${table.submittedAt} IS NULL)))
          OR (${table.origin} <> 'native' AND ${table.version} = 0
            AND ${table.sourceStatus} = 'approved'
            AND ${table.submittedByUserId} IS NULL AND ${table.submittedAt} IS NULL
            AND ${table.reviewedByUserId} IS NULL AND ${table.reviewedAt} IS NULL)
        ))
        OR (${table.status} = 'unsubmitted' AND ${table.reviewedByUserId} IS NOT NULL
          AND ${table.reviewedAt} IS NOT NULL AND ${table.rejectionReason} IS NOT NULL
          AND length(trim(${table.rejectionReason})) BETWEEN 1 AND 10000)
      )`,
    ),
    check(
      'timesheet_submissions_source_consistent',
      sql`(
        (${table.origin} = 'native' AND ${table.sourceStatus} IS NULL
          AND ${table.sourceObservedAt} IS NULL)
        OR (${table.origin} <> 'native' AND ${table.sourceStatus} IS NOT NULL
          AND ${table.sourceObservedAt} IS NOT NULL)
      )`,
    ),
    check('timesheet_submissions_created_at_canonical', canonicalTimestamp(table.createdAt)),
    check('timesheet_submissions_updated_at_canonical', canonicalTimestamp(table.updatedAt)),
  ],
)

export const timesheetLockWindows = sqliteTable(
  'timesheet_lock_windows',
  {
    id: integer('id').primaryKey(),
    kind: text('kind', { enum: ['manual_cutoff', 'weekly_deadline'] }).notNull(),
    periodStart: text('period_start'),
    periodEnd: text('period_end').notNull(),
    lockedByUserId: integer('locked_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    lockedAt: text('locked_at').notNull(),
    lockReason: text('lock_reason').notNull(),
    commandId: text('command_id'),
    inputFingerprint: text('input_fingerprint'),
    weekStartDay: text('week_start_day', { enum: ['saturday', 'sunday', 'monday'] }),
    deadlineDay: text('deadline_day', {
      enum: ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
    }),
    deadlineTime: text('deadline_time'),
    timezone: text('timezone'),
    unlockedByUserId: integer('unlocked_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    unlockedAt: text('unlocked_at'),
    unlockReason: text('unlock_reason'),
    version: integer('version').notNull().default(0),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('timesheet_lock_windows_weekly_fact')
      .on(table.periodStart, table.periodEnd)
      .where(sql`${table.kind} = 'weekly_deadline'`),
    uniqueIndex('timesheet_lock_windows_manual_command')
      .on(table.commandId)
      .where(sql`${table.commandId} is not null`),
    index('timesheet_lock_windows_active_dates')
      .on(table.periodEnd, table.periodStart)
      .where(sql`${table.unlockedAt} is null`),
    check(
      'timesheet_lock_windows_kind_valid',
      sql`${table.kind} in ('manual_cutoff','weekly_deadline')`,
    ),
    check(
      'timesheet_lock_windows_period_start_date',
      sql`${table.periodStart} is null or date(${table.periodStart}) is ${table.periodStart}`,
    ),
    check('timesheet_lock_windows_period_end_date', sql`date(${table.periodEnd}) is ${table.periodEnd}`),
    check(
      'timesheet_lock_windows_period_order',
      sql`${table.periodStart} is null or ${table.periodStart} <= ${table.periodEnd}`,
    ),
    check(
      'timesheet_lock_windows_reason_length',
      sql`length(trim(${table.lockReason})) between 1 and 10000`,
    ),
    check(
      'timesheet_lock_windows_command_shape',
      sql`(${table.commandId} is null and ${table.inputFingerprint} is null)
        or (length(${table.commandId}) between 1 and 128
          and ${table.commandId} not glob '*[^A-Za-z0-9._:-]*'
          and length(${table.inputFingerprint}) = 71
          and substr(${table.inputFingerprint}, 1, 7) = 'sha256:'
          and substr(${table.inputFingerprint}, 8) not glob '*[^0-9a-f]*')`,
    ),
    check(
      'timesheet_lock_windows_kind_shape',
      sql`(${table.kind} = 'manual_cutoff' and ${table.commandId} is not null
          and ${table.inputFingerprint} is not null)
        or (${table.kind} = 'weekly_deadline' and ${table.commandId} is null
          and ${table.inputFingerprint} is null)`,
    ),
    check('timesheet_lock_windows_locked_at_canonical', canonicalTimestamp(table.lockedAt)),
    check(
      'timesheet_lock_windows_unlocked_at_canonical',
      nullableCanonicalTimestamp(table.unlockedAt),
    ),
    check('timesheet_lock_windows_version', sql`${table.version} in (0, 1)`),
    check('timesheet_lock_windows_created_at_canonical', canonicalTimestamp(table.createdAt)),
    check('timesheet_lock_windows_updated_at_canonical', canonicalTimestamp(table.updatedAt)),
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
    approvalStatus: text('approval_status', {
      enum: ['unsubmitted', 'submitted', 'approved'],
    })
      .notNull()
      .default('unsubmitted'),
    timesheetSubmissionId: integer('timesheet_submission_id').references(
      () => timesheetSubmissions.id,
      { onDelete: 'restrict' },
    ),
    sourceApprovalStatus: text('source_approval_status', {
      enum: ['unsubmitted', 'submitted', 'approved'],
    }),
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
    index('time_entries_timesheet_submission_id')
      .on(table.timesheetSubmissionId)
      .where(sql`${table.timesheetSubmissionId} is not null`),
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
      'time_entries_approval_status_valid',
      sql`${table.approvalStatus} in ('unsubmitted', 'submitted', 'approved')`,
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
