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
  brandAssetSlots,
  createD1BrandAssetStore,
  type BrandAssetRecord,
  type BrandAssetSlot,
  type BrandAssetStore,
  type BrandAssetWrite,
} from './brand-assets.js'
export {
  createD1InstanceThemeStore,
  type InstanceThemeRecord,
  type InstanceThemeStore,
  type InstanceThemeWrite,
} from './instance-theme.js'
export {
  createBillLinkStore,
  createBillMirrorSource,
  setBillDelivery,
} from './bill.js'
export {
  createStripeLinkStore,
  type StripeLinkRecord,
  type StripeLinkStore,
} from './stripe-links.js'
export {
  createPayoutTransferStore,
  type PayoutPlanEntry,
  type PayoutTransferRecord,
  type PayoutTransferStore,
} from './payout-transfers.js'
export {
  createPayoutAccountStore,
  payoutProviders,
  type PayoutAccountRecord,
  type PayoutAccountStore,
  type PayoutProvider,
} from './payout-accounts.js'
export {
  createWiseGrantStore,
  type WiseGrantOutcome,
  type WiseGrantRecord,
  type WiseGrantStore,
  type WiseOAuthStateRecord,
  type WiseStateClaim,
} from './wise-grants.js'
export {
  createWiseDeliveryStore,
  type WiseDeliveryClaim,
  type WiseDeliveryRecord,
  type WiseDeliveryStore,
  type WiseSettlement,
} from './wise-deliveries.js'
export {
  recordCheckoutPayment,
  type CheckoutPaymentInput,
  type CheckoutPaymentOutcome,
  type CheckoutProvider,
} from './checkout-payments.js'
export {
  readThankYouPreference,
  readOrganizationThankYouPolicy,
  setInvoiceThankYouPolicy,
  setOrganizationThankYouPolicy,
} from './automatic-thank-you.js'
export {
  createThankYouPort,
  type ThankYouInvoiceSource,
  type ThankYouPortMessage,
} from './thank-you-port.js'
export {
  readTimeEntryClaim,
  releaseInvoicedTimeEntries,
  type ReleaseOutcome,
  type TimeEntryClaim,
} from './release-invoiced-time.js'
export {
  readAttachPreference,
  readFilesPreference,
  readOrganizationFilesPolicy,
  setInvoiceFilesPolicy,
  setOrganizationFilesPolicy,
  readStagedAttachments,
  resolveFilesPolicy,
  resolveJournalPolicy,
  readInvoiceJournal,
  readJournalPreference,
  readOrganizationJournalPolicy,
  setInvoiceJournalPolicy,
  setOrganizationJournalPolicy,
  readOrganizationAttachPolicy,
  invoiceDocumentFilename,
  invoiceDocumentKey,
  readAttachedDocument,
  recordAttachedDocument,
  resolveAttachPolicy,
  setInvoiceAttachPolicy,
  setOrganizationAttachPolicy,
  type AttachDecision,
  type AttachedDocument,
} from './invoice-documents.js'
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
export {
  demoAccounts,
  demoClientProjects,
  demoRetainers,
  demoSeedStatements,
  type DemoAccount,
  type DemoSeedOptions,
  type DemoSeedStatement,
} from './demo-seed.js'
export {
  billDemoBacklog,
  createD1DemoResetDriver,
  DEMO_ORGANIZATION_NAME,
  PRESERVED_TABLES,
  runDemoReset,
  wipeAndSeedDemo,
  type DemoBillingSummary,
  type DemoResetDriver,
  type DemoResetOptions,
  type DemoResetSummary,
  type DemoWipeSummary,
} from './demo-reset.js'
export { migrateD1, migrationIds } from './migrate.js'
export {
  DrizzleTrackedResourceRepository,
  type PolicySubject,
  type TrackedPolicyResolver,
} from './tracked-resource-repository.js'

// Portal magic-link auth. On this subpath rather than the package index
// because the index reaches modules that import node:fs and node:path, and a
// worker bundle cannot resolve those -- the import that dragged them in failed
// the build rather than the typecheck, which is the slower way to find out.
export { createD1MagicLinkStore } from './magic-link-state.js'
export { createD1ContactSessionStore } from './contact-sessions.js'
export { createMagicLinkService } from './magic-link-service.js'
export { createD1TwoFactorStore } from './two-factor.js'
export { createTwoFactorService } from './two-factor-service.js'
export {
  createRecurringInvoiceEngine,
  type RecurringGenerationPrincipal,
  type RecurringInvoiceEngine,
} from './recurring-invoice-engine.js'
export { captureActivityEvent } from './activity-log.js'
export { createD1ReminderScheduler } from './reminders.js'

// The QuickBooks store is type-only against better-sqlite3, so it is safe to
// reach from the Worker entry -- the native driver never enters the bundle.
export {
  createQuickBooksStore,
  type QuickBooksConnectionRecord,
  type QuickBooksLinkRecord,
  type QuickBooksStore,
} from './quickbooks.js'
export { createQuickBooksMirrorSource } from './quickbooks-source.js'
