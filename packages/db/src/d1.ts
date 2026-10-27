export { createCalendarConnectionStore } from './calendar-connections.js'
export { createCalendarFeedService } from './calendar-feeds.js'
export { createDeelPaymentStatusStore } from './deel-payment-status.js'
export { createManagedBillConnectionStore } from './managed-bill.js'
export { createManagedQuickBooksGrantStore } from './managed-quickbooks.js'
export { createManagedQuickBooksLifecycleStore } from './managed-quickbooks-lifecycle.js'
export { createOffsiteBackupSyncService, type OffsiteBackupSettings } from './offsite-backups.js'
export { createScheduledJobsService, proposeDueScheduledJobs } from './scheduled-jobs.js'
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
  createD1IdempotencyStore,
  createIdempotentD1,
  runWithClaim,
  type IdempotencyClaim,
  type IdempotencyRecord,
  type IdempotencyStore,
  type IdempotentExecution,
  type SealedIdempotentResponse,
} from './idempotency.js'

export {
  createApiTokenStore,
  type ApiTokenStore,
  type CreateApiTokenStoreOptions,
} from './api-tokens.js'
export { createGeneralResourceRepository } from './general-resources.js'
export {
  listClientAncestors,
  listClientDescendants,
  readUserIdentity,
  readUserTimezone,
  readEffectiveUserTimezone,
  updateUserTimezone,
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
export { createMoneyResourceRepository, type InvoiceDocumentContext } from './money-resources.js'
export {
  createInvoiceGenerationService,
  InvoiceGenerationError,
  type BandedFeeLine,
  type GenerateBandedInvoiceRequest,
  type GenerateFreeFormInvoiceRequest,
  type GenerateInvoiceCommand,
  type GenerateInvoiceRequest,
  type GeneratedInvoice,
  type InvoiceBandClaim,
  type InvoiceGenerationService,
} from './invoice-generation.js'
export { createD1EmailFeedbackLedger } from './email-feedback-events.js'
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
  type OutboxDeliveryFilter,
  type OutboxDeliveryPageWindow,
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
export {
  createSignInMethodRepository,
  SIGN_IN_METHODS,
  type SignInMethod,
  type SignInMethodState,
} from './sign-in-methods.js'
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
  createD1OidcAppCodeStore,
  type CreateOidcAppCodeInput,
  type OidcAppCode,
  type OidcAppCodeCreation,
  type OidcAppCodeStore,
} from './oidc-app-codes.js'
export {
  createD1StaffMagicLinkStore,
  type CreateStaffMagicLinkInput,
  type StaffMagicLinkFlow,
  type StaffMagicLinkRedemption,
  type StaffMagicLinkCreation,
  type StaffMagicLinkStore,
} from './staff-magic-links.js'
export {
  createD1StaffUserDirectory,
  type StaffUser,
  type StaffUserDirectory,
} from './staff-user-directory.js'
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
  LAST_SEEN_INTERVAL_MS,
  lastSeenIntervalFromSeconds,
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
  createPayoutProviderEnablementStore,
  type PayoutProviderSetting,
} from './payout-provider-enablement.js'
export {
  createPayoutPreferenceStore,
  type PersonPayoutPreference,
  type PayoutPreferenceRosterRow,
} from './payout-preferences.js'
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
  readNotificationSettings,
  updateNotificationSettings,
  type NotificationSettings,
  type SubmissionReminderSchedule,
} from './notification-settings.js'
export { createScheduledActionStore, sweepExpiredRuns } from './scheduled-actions.js'
export { prepareTimeReminders, type TimeReminderInput } from './time-reminders.js'
export {
  readTimesheetAutoApproval,
  runTimesheetAutoApproval,
  updateTimesheetAutoApproval,
  type TimesheetAutoApprovalRun,
  type TimesheetAutoApprovalSettings,
} from './timesheet-auto-approval.js'
export { readUserNotifications, updateUserNotifications } from './profile-notifications.js'
export {
  evaluateProjectBudgetAlerts,
  prepareBudgetAlertMail,
  type BudgetAlertEvaluation,
  type BudgetAlertMailInput,
} from './project-budget-alerts.js'
export {
  createReminderPort,
  listReminderDeliveries,
  type ReminderInvoiceSource,
  type ReminderPortMessage,
} from './reminder-port.js'
export {
  readOrganizationReminderPolicy,
  reminderPolicyFrom,
  setOrganizationReminderPolicy,
  type ReminderPolicy,
} from './reminder-settings.js'
export {
  createReminderSettings,
  type InvoiceReminderAnswer,
  type ReminderSettings,
} from './reminder-preference.js'
export {
  readInvoiceDefaults,
  updateInvoiceDefaults,
  type InvoiceDefaults,
  type InvoiceDefaultsPatch,
} from './invoice-defaults.js'
export {
  allowViewLinkRequest,
  createInvoiceViewLinkIssuer,
  hashViewLinkToken,
  invoiceViewLinkOrigin,
  mintViewLinkToken,
  readInvoiceViewPage,
  readViewReceiptsEnabled,
  readViewReceipts,
  recordInvoiceView,
  viewLinkExpiry,
  type InvoiceViewLinkIssuer,
  type InvoiceViewPage,
} from './invoice-view-links.js'
export {
  createInvoiceViewService,
  type InvoiceViewPageData,
  type InvoiceViewService,
} from './invoice-view-service.js'
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
  readInvoiceHoursReport,
  readJournalFormatsPreference,
  readOrganizationJournalFormats,
  resolveJournalFormats,
  setInvoiceJournalFormats,
  setOrganizationJournalFormats,
  readOrganizationAttachPolicy,
  readAppendPreference,
  readOrganizationAppendPolicy,
  resolveAppendPolicy,
  setInvoiceAppendPolicy,
  setOrganizationAppendPolicy,
  type LayeredPreference,
  type StagedAttachment,
  invoiceDocumentFilename,
  invoiceDocumentKey,
  readAttachedDocument,
  readMessageAttachesPdf,
  recordAttachedDocument,
  resolveAttachPolicy,
  setInvoiceAttachPolicy,
  setOrganizationAttachPolicy,
  type AttachDecision,
  type AttachedDocument,
} from './invoice-documents.js'
export { readInvoiceHoursReconciliation } from './invoice-hours-reconciliation.js'
export {
  clientInvoiceExtraKinds,
  readClientInvoiceExtras,
  setClientInvoiceExtras,
  type ClientInvoiceExtraKind,
  type InvoiceExtraValue,
  type InvoiceExtras,
} from './invoice-extras.js'
export {
  countInvoicePreviewsSince,
  effectiveClientRecipients,
  readClientInvoiceSending,
  readInvoiceEmailDefaults,
  saveClientInvoiceSending,
  readClientInvoiceRecipients,
  readInvoiceSenderCopy,
  readOrganizationAlwaysCc,
  setClientInvoiceRecipients,
  setInvoiceSenderCopy,
  setOrganizationAlwaysCc,
  type ClientInvoiceRecipients,
  type InvoiceSenderCopy,
} from './invoice-sending.js'
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
  allowBackupDownloadRequest,
  backupDownloadLinkExpiry,
  consumeBackupDownloadLink,
  latestCompletedBackupRunId,
  mintBackupDownloadLink,
  type ConsumedBackupDownloadLink,
  type MintedBackupDownloadLink,
} from './backup-download-links.js'
export {
  BackupArchiveError,
  getBackupRun,
  openBackupArchive,
  r2BackupSource,
  type BackupArchiveErrorCode,
  type BackupObjectSource,
} from './backup-archive.js'
export {
  EPHEMERAL_TABLES,
  backupTables,
  BUNDLE_VERSION,
  completeBackupRun,
  exportBundle,
  failBackupRun,
  countBackupRuns,
  getBackupRunsSnapshot,
  getLatestBackupRuns,
  pageBackupRuns,
  recordBackupStart,
  SCHEMA_VERSION,
  shouldRunNightlyBackup,
  type BackupManifest,
  type BackupObjectStore,
  type BackupRunFilter,
  type BackupRunPageWindow,
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
export { migrateD1, migrationIds, assertCutoverMigrationLedger } from './migrate.js'
export { DrizzleCalendarProposalRepository } from './calendar-proposals.js'
export { DrizzleAllocationRepository } from './allocations.js'
export { DrizzleTimeOffRepository } from './time-off.js'
export { DrizzleWorkItemRepository } from './work-items.js'
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
export { createTwoFactorService, deriveTwoFactorEmailCodeKey } from './two-factor-service.js'
export {
  createRecurringInvoiceEngine,
  type RecurringGenerationPrincipal,
  type RecurringInvoiceEngine,
} from './recurring-invoice-engine.js'
export { backfillBandClaims } from './band-claim-backfill.js'
export { backfillCostRates } from './cost-rate-backfill.js'
export { captureActivityEvent } from './activity-log.js'
export { createActivityRoll } from './activity-partitions.js'
export { requestAccountDeletion } from './account-deletion.js'
export { createD1ReminderScheduler, type ReminderProcessOptions, type ReminderProcessSummary } from './reminders.js'

// The QuickBooks store is type-only against better-sqlite3, so it is safe to
// reach from the Worker entry -- the native driver never enters the bundle.
export {
  createQuickBooksStore,
  type QuickBooksConnectionRecord,
  type QuickBooksLinkRecord,
  type QuickBooksMirrorOutcomeKind,
  type QuickBooksMirrorOutcomeRecord,
  type QuickBooksStore,
} from './quickbooks.js'
export {
  createQuickBooksMirrorSource,
  createQuickBooksReconciliationSource,
} from './quickbooks-source.js'

export { createStaffPaymentStore } from './staff-payments.js'

export { createPaymentRunsService } from './payment-runs.js'

export { createScheduledRunsService } from './scheduled-runs.js'

export { createAccountRetentionRepository } from './account-retention.js'

export * from './account-deletion-requests.js'

export * from './account-closure.js'

export * from './account-deletion-status.js'

export * from './apple-lifecycle.js'

export { createAccountRetentionReviewRepository } from './account-retention-review.js'
export { createD1AppleWebCustodyStore } from './apple-web-custody.js'
export { createMyPaymentsStore } from './my-payments.js'

export * from './deel-time-sync.js'
export { createDeelCredentialSource, createManagedDeelConnectionStore } from './managed-deel.js'
export { createClientRateCardRepository } from './client-rate-cards.js'

export * from './contractor-review.js'

export { releaseInvoiceLineTime } from './invoice-time-release.js'

export * from './email-suppressions.js'

export * from './scheduled-run-notifications.js'

export * from './scheduled-run-dispatch.js'

export { executeInvoiceLifecycleCommand } from './invoice-state.js'
export { proposeMonthEndPack } from './month-end-pack.js'

export * from './estimate-templates.js'

export * from './invoice-elevations.js'

export * from './invoice-elevated-time.js'

export * from './organization-holidays.js'
export * from './webhooks.js'

export * from './project-missing-rates.js'

// Runtime infrastructure: callers must establish idempotence before use.
export { retryTransientD1IdempotentOperation } from './d1-idempotent-retry.js'

export * from './placeholder-allocations.js'
export { createResourceCalendarRepository } from './resource-calendar.js'

export { createDeelStageStore } from './deel-staging.js'

export { createCsvBrowserDatasetLedger } from './csv-browser-import.js'
export { csvStagingSessionFence } from './csv-staging-authority.js'
export { csvWorkerDatabase, type CsvWorkerExecution } from './csv-worker-database.js'
export { previewTimesheetLockedDates, type TimesheetLockPreviewWindow } from './timesheet-lock-policy.js'
export * from './stripe-payment-alerts.js'

export * from './bank-deposit-review.js'
export * from './calendar-oauth.js'

export { expireWorkerSnapshots, discardWorkerSnapshot } from './worker-backup-snapshot.js'

export { createCalendarOperatorCleanupStore } from './calendar-operator-cleanup.js'
