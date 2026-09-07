import { drizzle } from 'drizzle-orm/d1'
import * as schema from './schema.js'

/** Worker-safe adapter that does not pull the native better-sqlite3 driver. */
export const createD1Database = (database: D1Database) => drizzle(database, { schema })

export {
  assertStaticRecurringAttachmentPolicy,
  createAttachmentStore,
  sha256ContentHash,
  type AttachmentDatabase,
  type AttachmentFileInput,
  type AttachmentMetadataInput,
  type AttachmentRecord,
  type AttachmentStore,
  type CreateEstimateAttachmentInput,
  type CreateExpenseAttachmentInput,
  type CreateInvoiceAttachmentInput,
  type CreateProjectAttachmentInput,
  type CreateRecurringInvoiceAttachmentInput,
  type StaticRecurringAttachmentPolicyV1,
} from './attachments.js'

export {
  createApiTokenStore,
  type ApiTokenStore,
  type CreateApiTokenStoreOptions,
} from './api-tokens.js'
export { createGeneralResourceRepository } from './general-resources.js'
export {
  listClientAncestors,
  listClientDescendants,
  type ClientHierarchyNode,
} from './operations.js'
export { createTeamRepository } from './team.js'
export {
  createTimesheetApprovalRepository,
  TimesheetApprovalError,
  type TimesheetApprovalActor,
  type TimesheetSubmissionFilters,
  type TimesheetSubmissionDetailRecord,
  type TimesheetSubmissionEntryRecord,
  type TimesheetSubmissionExpenseRecord,
  type TimesheetSubmissionRecord,
  type TimesheetSubmissionSource,
  type TimesheetSubmissionStatus,
} from './timesheet-approvals.js'
export {
  createTimesheetLockPolicyRepository,
  DrizzleTimesheetLockPolicyRepository,
  TimesheetLockPolicyError,
  type TimesheetDeadline,
  type TimesheetDeadlineDay,
  type TimesheetLockKind,
  type TimesheetLockListWindow,
  type TimesheetLockPolicyActor,
  type TimesheetLockPolicyRepository,
  type TimesheetLockPolicySettings,
  type TimesheetLockWindowFilters,
  type TimesheetLockWindowRecord,
  type TimesheetLockWindowSource,
  type TimesheetPolicyLockResolution,
  type UpdateTimesheetLockPolicySettings,
} from './timesheet-lock-policy.js'
export { createMoneyResourceRepository } from './money-resources.js'
export {
  createInvoiceGenerationService,
  InvoiceGenerationError,
  type GenerateInvoiceCommand,
  type GenerateInvoiceRequest,
  type InvoiceGenerationService,
} from './invoice-generation.js'
export {
  createD1EmailLogStore,
  type EmailLogStoreOptions,
} from './email-log.js'
export {
  createD1EmailConfigurationStore,
  EmailConfigurationError,
  type EmailConfigurationStore,
  type EmailTestSendClaim,
  type EmailTestSendCommandRecord,
  type EmailTestSendFailureCode,
  type EmailTemplateVersionRecord,
  type SenderIdentityEvidenceRecord,
  type SenderIdentityRecord,
} from './email-configuration.js'
export {
  ACTIVITY_LOG_SUBSCRIBER_ID,
  createD1OutboxService,
  OUTBOX_DELIVERY_POLICY,
  type ActivityLogRecord,
  type OutboxDeliveryFailureCode,
  type OutboxDeliveryRecord,
  type OutboxDeliveryStatus,
  type OutboxDrainSummary,
  type OutboxEventRecord,
  type OutboxService,
  type OutboxServiceOptions,
  type OutboxSubscriber,
  type OutboxSubscriberContext,
} from './outbox.js'
export {
  createModuleSettingsRepository,
  type ModuleName,
  type ModuleState,
} from './module-settings.js'
export { createReportRepository, type ReportRepository } from './reports.js'
export { createD1IdentityStore, type IdentityStore, type IdentityStoreOptions } from './identity.js'
export {
  createD1OidcTransactionStore,
  type CreateOidcTransactionInput,
  type OidcTransaction,
  type OidcTransactionCreation,
  type OidcTransactionStore,
} from './oidc-transactions.js'
export {
  createD1PasswordAuthService,
  AuthRateLimitError,
  FirstRunSignupUnavailableError,
  InvalidAuthTokenError,
  type AuthDelivery,
  type PasswordAuthService,
  type PasswordAuthServiceOptions,
} from './password-auth.js'
export {
  createD1SessionStore,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
  type AuthenticatedSession,
  type IssuedSession,
  type SessionMetadata,
  type SessionRevocationReason,
  type SessionStore,
  type SessionStoreOptions,
} from './sessions.js'
export {
  createD1SsoProvisioningDomainStore,
  SsoProvisioningDomainError,
  type SsoProvisioningDomainErrorCode,
  type SsoProvisioningDomainRecord,
  type SsoProvisioningDomainStore,
  type SsoProvisioningDomainStoreOptions,
} from './sso-provisioning-domains.js'
export {
  bootstrapInstanceD1,
  enrollInstanceOwnerPasswordD1,
  InstanceBootstrapConflictError,
  InstanceOwnerPasswordConflictError,
  type InstanceBootstrapInput,
  type InstanceBootstrapResult,
  type InstanceOwnerPasswordInput,
  type InstanceOwnerPasswordResult,
} from './instance-bootstrap.js'
export {
  BACKUP_TABLES,
  BUNDLE_VERSION,
  completeBackupRun,
  exportBundle,
  failBackupRun,
  getLatestBackupRuns,
  recordBackupStart,
  SCHEMA_VERSION,
  shouldRunNightlyBackup,
  type BackupManifest,
  type BackupObjectStore,
  type BackupRunRecord,
} from './backup.js'
export { migrateD1, migrationIds } from './migrate.js'
export {
  DrizzleTrackedResourceRepository,
  type PolicySubject,
  type TrackedPolicyResolver,
} from './tracked-resource-repository.js'
