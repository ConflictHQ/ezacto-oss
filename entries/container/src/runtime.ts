import { createStripePaymentAlertStore, prepareStripePaymentAlertNotifications } from '@ezacto/db'
import { createCalendarFeedService } from '@ezacto/db'
import { createDeelPaymentStatusStore } from '@ezacto/db'
import { createDeelPaymentStatusRuntime } from '@ezacto/integrations'
import { createDeelStageStore } from '@ezacto/db'
import { createDeelStagingRuntime } from '@ezacto/integrations'
import { moduleAvailability } from '@ezacto/api'
import { createOrganizationHolidayRepository } from '@ezacto/db'
import { demoDeployment } from '../../worker/src/app.js'
import { createWebhookSecretVault } from '@ezacto/core'
import { createWebhookService } from '@ezacto/db'
import { createNodeWebhookTransport } from '@ezacto/integrations/node-webhooks'
import {migrationLoadStatusProjection} from '@ezacto/db/queued-migrations'
import type {MigrationLoadStatus} from '@ezacto/core'
import { createInvoiceElevationStore, unlinkElevatedInvoiceTime } from '@ezacto/db'
import { createEstimateTemplateRepository } from '@ezacto/db'
import { createScheduledRunDispatchService } from '@ezacto/db'
import { prepareScheduledRunNotifications } from '@ezacto/db'
import { createContainerEmailSuppressionStore } from '@ezacto/db'
import type { ReminderProcessOptions } from '@ezacto/db'
import { createRuntimeAppleWeb } from '../../worker/src/apple-web.js'
import { createContainerAppleWebCustodyStore } from '@ezacto/db'
import { createPaymentRunsService, createScheduledRunsService, createScheduledJobsService, proposeDueScheduledJobs } from '@ezacto/db'
import { createContainerBrandAssetStore, createContainerInstanceThemeStore } from '@ezacto/db'
import { createWisePaymentProvider } from '@ezacto/integrations'
import { createContractorReviewStore, createStaffPaymentStore } from '@ezacto/db'
import { createMyPaymentsStore } from '@ezacto/db'
import { sql } from 'drizzle-orm'
import { chmod, lstat, mkdir, realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { createCsvImportStaging } from './csv-staging-service.js'
import { join } from 'node:path'
import {
  bootstrapInstanceContainer,
  createApiTokenStore,
  createAttachmentStore,
  createContainerContactSessionStore,
  createContainerDatabase,
  createContainerEmailLogStore,
  createContainerEmailConfigurationStore,
  createContainerIdentityStore,
  createContainerMagicLinkStore,
  createContainerOidcTransactionStore,
  createContainerOidcAppCodeStore,
  createContainerStaffMagicLinkStore,
  createContainerStaffUserDirectory,
  createMagicLinkService,
  createContainerOutboxService,
  createContainerPasswordAuthService,
  createContainerSessionStore,
  createContainerSsoProvisioningDomainStore,
  createContainerTwoFactorStore,
  backfillBandClaims,
  backfillCostRates,
  requestAccountDeletion,
  createRecurringInvoiceEngine,
  createContainerReminderScheduler,
  captureActivityEvent,
  createActivityRoll,
  createTwoFactorService,
  deriveTwoFactorEmailCodeKey,
  createGeneralResourceRepository,
  recoverProjectMissingRates,
  createInvoiceGenerationService,
  createMoneyResourceRepository,
  createReportRepository,
  createModuleSettingsRepository,
  createSignInMethodRepository,
  createAccountRetentionRepository,
  createAccountDeletionRequestRepository,
  createAccountClosureRepository,
  createAccountRetentionReviewRepository,
  createAppleLifecycleRepository,
  createAccountDeletionStatusRepository,
  createTimesheetApprovalRepository,
  createTimesheetLockPolicyRepository,
  createTeamRepository,
  DrizzleAllocationRepository,
  createPlaceholderAllocationRepository,
  DrizzleCalendarProposalRepository,
  DrizzleWorkItemRepository,
  DrizzleTrackedResourceRepository,
  enrollInstanceOwnerPasswordContainer,
  listClientAncestors,
  createClientRateCardRepository,
  listClientDescendants,
  migrateContainer,
  createBillLinkStore,
  createBillMirrorSource,
  createPayoutAccountStore,
  createWiseDeliveryStore,
  createStripeLinkStore,
  readAttachPreference,
  readAppendPreference,
  readOrganizationAppendPolicy,
  setInvoiceAppendPolicy,
  setOrganizationAppendPolicy,
  countInvoicePreviewsSince,
  readClientInvoiceSending,
  readInvoiceEmailDefaults,
  readInvoiceSenderCopy,
  readOrganizationAlwaysCc,
  saveClientInvoiceSending,
  setInvoiceSenderCopy,
  setOrganizationAlwaysCc,
  readFilesPreference,
  readOrganizationFilesPolicy,
  setInvoiceFilesPolicy,
  setOrganizationFilesPolicy,
  readJournalPreference,
  readOrganizationJournalPolicy,
  setInvoiceJournalPolicy,
  setOrganizationJournalPolicy,
  readInvoiceHoursReport,
  readInvoiceHoursReconciliation,
  releaseInvoiceLineTime,
  readJournalFormatsPreference,
  readOrganizationJournalFormats,
  setInvoiceJournalFormats,
  setOrganizationJournalFormats,
  readOrganizationAttachPolicy,
  setInvoiceAttachPolicy,
  setOrganizationAttachPolicy,
  releaseInvoicedTimeEntries,
  recordCheckoutPayment,
  createThankYouPort,
  createReminderPort,
  createReminderSettings,
  readInvoiceDefaults,
  createInvoiceViewLinkIssuer,
  createInvoiceViewService,
  invoiceViewLinkOrigin,
  readViewReceipts,
  updateInvoiceDefaults,
  readThankYouPreference,
  readOrganizationThankYouPolicy,
  setInvoiceThankYouPolicy,
  setOrganizationThankYouPolicy,
  evaluateProjectBudgetAlerts,
  prepareBudgetAlertMail,
  prepareTimeReminders,
  readUserNotifications,
  updateUserNotifications,
  readNotificationSettings,
  readTimesheetAutoApproval,
  runTimesheetAutoApproval,
  createScheduledActionStore,
  sweepExpiredRuns,
  updateTimesheetAutoApproval,
  updateNotificationSettings,
  setBillDelivery,
  createQuickBooksMirrorSource,
  createQuickBooksReconciliationSource,
  createQuickBooksStore,
  readUserIdentity,
  readUserTimezone,
  readEffectiveUserTimezone,
  updateUserTimezone,
  createContainerIdempotencyStore,
  createIdempotentSqlite,
} from '@ezacto/db'
import {
  createApiSessionService,
  createBudgetAlertSubscriber,
  createTimeReminderService,
  createNotificationSettingsService,
  createTimesheetAutoApprovalService,
  createDeploymentNotificationMailer,
  createInvoiceEmailOutboxSubscriber,
  createInvoiceThankYouSubscriber,
  thankYouInvoiceFromDeliveryContext,
  createPortalSessionService,
  createQueuedAccountDeletionMailer,
  createQueuedAuthMailer,
  createQueuedStaffMagicLinkMailer,
  createQueuedPortalMagicLinkMailer,
  createQueuedTwoFactorEmailCodeMailer,
  type AttachmentRouteOptions,
  type UserPrincipal,
  invoicePaymentUrlForMail,
  deriveIdempotencySecret,
  emailBrandFrom,
  withEmailBrand,
} from '@ezacto/api'
import {
  configuredEmailSender,
  createDeploymentSenderQueuedMailer,
  createQueuedMailer,
  createSenderBoundQueuedMailer,
  SenderIdentityUnavailableError,
  type HttpEmailProvider,
  EMAIL_LOG_KIND_TEMPLATES,
} from '@ezacto/mailer'
import { SmtpMailer } from '@ezacto/mailer/smtp'
import type {
  BandClaimBackfillPort,
  BrandAssetSurface,
  CostRateBackfillPort,
  InstanceThemeSurface,
} from '@ezacto/api'
import { workItemCredentialConfigured, type AppEnv, type RuntimeServices } from '../../worker/src/app.js'
import {
  createBillMirrorSubscriber,
  createBillRuntime,
  createScheduledBillReconciliation,
  createStripeRuntime,
  createQuickBooksMirrorSubscriber,
  createQuickBooksRuntime,
  createWiseRuntime,
} from '@ezacto/integrations'
import type { ContainerConfig } from './config.js'
import { createContainerBrandAssetSurface } from './brand-assets.js'
import { createContainerInstanceThemeSurface } from './instance-theme.js'
import { createDiskAttachmentObjectStore } from './disk-attachments.js'
import { ContainerEmailQueue } from './email-queue.js'
import { ContainerOutboxScheduler } from './outbox-scheduler.js'

const exists = (
  database: BetterSqlite3.Database,
  query: string,
  ...bindings: unknown[]
): boolean => database.prepare(query).get(...bindings) !== undefined

export const createContainerAttachmentOwnerAuthorizer = (
  database: BetterSqlite3.Database,
): AttachmentRouteOptions['authorizeOwnerAccess'] =>
  async ({ owner, parentId, principal }) => {
    switch (owner) {
      case 'invoice':
        return exists(database, 'SELECT 1 FROM invoices WHERE id = ?', parentId)
      case 'recurringInvoice':
        return exists(
          database,
          'SELECT 1 FROM recurring_invoices WHERE id = ?',
          parentId,
        )
      case 'estimate':
        return exists(database, 'SELECT 1 FROM estimates WHERE id = ?', parentId)
      case 'expense':
        return exists(
          database,
          `SELECT 1 FROM expenses
           WHERE id = ? AND user_id = ?
             AND COALESCE((
               SELECT json_extract(modules, '$.expenses')
               FROM organizations WHERE id = 1
             ), 0) = 1`,
          parentId,
          principal.userId,
        )
      case 'project':
        return canAccessProject(database, parentId, principal)
    }
  }

const canAccessProject = (
  database: BetterSqlite3.Database,
  projectId: number,
  principal: Readonly<UserPrincipal>,
): boolean => {
  if (
    principal.profile === 'administrator' ||
    principal.profile === 'executive_manager'
  ) {
    return exists(database, 'SELECT 1 FROM projects WHERE id = ?', projectId)
  }
  return exists(
    database,
    `SELECT 1 FROM projects project
     JOIN users viewer ON viewer.id = ? AND viewer.is_active = 1
     WHERE project.id = ? AND (
       viewer.has_access_to_all_future_projects = 1
       OR EXISTS (
         SELECT 1 FROM user_assignments assignment
         WHERE assignment.project_id = project.id
           AND assignment.user_id = viewer.id
           AND assignment.is_active = 1
       )
     )`,
    principal.userId,
    projectId,
  )
}

const assertPragma = (
  database: BetterSqlite3.Database,
  name: string,
  expected: string | number,
): void => {
  const value = database.pragma(name, { simple: true }) as unknown
  if (value !== expected) {
    throw new Error(`SQLite ${name} pragma did not take effect`)
  }
}

export const prepareContainerDatabase = (
  database: BetterSqlite3.Database,
): void => {
  database.pragma('journal_mode = WAL')
  database.pragma('synchronous = FULL')
  database.pragma('foreign_keys = ON')
  database.pragma('busy_timeout = 5000')
  database.pragma('wal_autocheckpoint = 1000')
  migrateContainer(database)
  if (database.prepare("SELECT 1 FROM migration_loads WHERE status<>'completed' AND (status<>'cancelled' OR started_at IS NOT NULL) LIMIT 1").get()) {
    throw new Error('Queued migration target is quarantined; finish or recover the import before serving this database.')
  }
  if(database.prepare('SELECT 1 FROM account_restore_quarantine WHERE id=1 AND quarantined=1').get())throw new Error('Restored privacy evidence must be reconciled before this instance serves traffic.')

  assertPragma(database, 'journal_mode', 'wal')
  assertPragma(database, 'synchronous', 2)
  assertPragma(database, 'foreign_keys', 1)
  assertPragma(database, 'busy_timeout', 5_000)
  assertPragma(database, 'wal_autocheckpoint', 1_000)

  const quickCheck = database.pragma('quick_check(1)', {
    simple: true,
  }) as unknown
  if (quickCheck !== 'ok') throw new Error('SQLite quick_check failed')
  if ((database.pragma('foreign_key_check') as unknown[]).length !== 0) {
    throw new Error('SQLite foreign_key_check failed')
  }
}

export interface ContainerRuntime {
  database: BetterSqlite3.Database
  services: RuntimeServices
  /** Passed to `createApp` beside the services; see `brand-assets.ts`. */
  brandAssets: BrandAssetSurface<AppEnv>
  instanceTheme: InstanceThemeSurface<AppEnv>
  drainOutbox(): ReturnType<RuntimeServices['outbox']['drain']>
  close(timeoutMs?: number): Promise<void>
}

export interface ContainerRuntimeOptions {
  emailProvider?: HttpEmailProvider
  verifyEmailProvider?: () => Promise<void>
}

/**
 * Attests only the exact SMTP mailbox already validated from deployment
 * configuration. This is not a DNS or provider verification claim.
 */
/**
 * Host and port only. `SMTP_URL` carries a password, so the URL itself must
 * never reach a log line, and an operator diagnosing unreachable mail needs the
 * endpoint rather than the credential anyway.
 */
const smtpEndpoint = (url: string): string => {
  try {
    const parsed = new URL(url)
    return parsed.port === '' ? parsed.hostname : `${parsed.hostname}:${parsed.port}`
  } catch {
    return 'the configured SMTP server'
  }
}

export const createSmtpSenderIdentityVerifier = (
  from: string,
): NonNullable<RuntimeServices['senderIdentityVerifier']> => {
  const configured = configuredEmailSender(from)
  return {
    provider: 'smtp',
    verify: async (identity) => {
      if (identity.archivedAt !== null) {
        throw new SenderIdentityUnavailableError('sender_identity_archived', identity.id)
      }
      if (identity.provider !== 'smtp') {
        throw new SenderIdentityUnavailableError('sender_provider_mismatch', identity.id)
      }
      const address = identity.email.normalize('NFC').trim().toLowerCase()
      const providerIdentity = identity.providerIdentity
        .normalize('NFC')
        .trim()
        .toLowerCase()
      if (address !== configured.email || providerIdentity !== configured.email) {
        throw new SenderIdentityUnavailableError(
          'sender_identity_binding_mismatch',
          identity.id,
        )
      }
      return {
        source: 'deployment_config',
        identityKind: 'email_address',
        verificationStatus: 'operator_configured',
        dkimStatus: 'not_applicable',
        mailFromDomain: null,
        mailFromStatus: 'not_configured',
        observedAt: new Date().toISOString(),
      }
    },
  }
}

const ensureDataDirectory = async (directory: string): Promise<void> => {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const [linkMetadata, canonical] = await Promise.all([
    lstat(directory),
    realpath(directory),
  ])
  if (
    linkMetadata.isSymbolicLink() ||
    !linkMetadata.isDirectory() ||
    canonical !== resolve(directory)
  ) {
    throw new TypeError('data directory must not contain symbolic links')
  }
  const userId = process.getuid?.()
  if (userId !== undefined && linkMetadata.uid !== userId) {
    throw new TypeError('data directory must be owned by the container user')
  }
  await chmod(directory, 0o700)
  if (((await stat(directory)).mode & 0o077) !== 0) {
    throw new TypeError('data directory permissions must exclude group and other users')
  }
}

const assertDatabasePath = async (path: string): Promise<void> => {
  try {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new TypeError('db.sqlite must be a regular file, not a symbolic link')
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return
    }
    throw error
  }
}

export const assertNoIncompletePrivacyRestore = async (directory: string): Promise<void> => {
  try { await lstat(resolve(directory, '.privacy-restore-incomplete')) }
  catch(error) { if(error instanceof Error && 'code' in error && error.code==='ENOENT') return; throw error }
  throw new Error('Incomplete physical restore: privacy evidence must be reconciled before startup')
}

export const createContainerRuntime = async (
  config: ContainerConfig,
  options: ContainerRuntimeOptions = {},
): Promise<ContainerRuntime> => {
  await ensureDataDirectory(config.dataDirectory)
  await assertNoIncompletePrivacyRestore(config.dataDirectory)
  await assertDatabasePath(config.databasePath)
  const handle = new BetterSqlite3(config.databasePath, { timeout: 5_000 })
  // Every store below writes through this: in a request that carries an
  // Idempotency-Key, each write commits with the key's claim (#952).
  const database = createIdempotentSqlite(handle)
  let csvStaging: Awaited<ReturnType<typeof createCsvImportStaging>> | undefined
  let csvSweep: ReturnType<typeof setInterval> | undefined
  let queue: ContainerEmailQueue | undefined
  let outboxScheduler: ContainerOutboxScheduler | undefined
  try {
    prepareContainerDatabase(database)
    await chmod(config.databasePath, 0o600)

    csvStaging = await createCsvImportStaging({database:handle,databasePath:config.databasePath,directory:join(config.dataDirectory,'csv-staging')})
    await csvStaging.sweep()
    csvSweep=setInterval(()=>{void csvStaging!.sweep().catch(()=>console.error('ezacto: private CSV expiry cleanup deferred'))},60_000)
    csvSweep.unref()
    const drizzle = createContainerDatabase(database)
    const deelPaymentStatus = createDeelPaymentStatusRuntime({ token: demoDeployment(config.appEnv) ? undefined : config.deel?.token, store: createDeelPaymentStatusStore(drizzle), fetch: (request: Request) => fetch(request), now: () => new Date() })
    const webhooks = createWebhookService(drizzle, {
      vault: !demoDeployment(config.appEnv) && config.webhookEncryptionKey ? await createWebhookSecretVault(config.webhookEncryptionKey) : null,
      transport: createNodeWebhookTransport(),
    })
    const timesheetLockPolicy = createTimesheetLockPolicyRepository(drizzle)
    const trackedResources = new DrizzleTrackedResourceRepository(drizzle, timesheetLockPolicy)
    const touch =
      config.lastSeenIntervalMs === undefined
        ? {}
        : { touchIntervalMs: config.lastSeenIntervalMs }
    const sessions = createApiSessionService(
      createContainerSessionStore(database, touch),
    )
    const emailLog = createContainerEmailLogStore(database, { kindTemplates: EMAIL_LOG_KIND_TEMPLATES })
    const emailConfiguration = createContainerEmailConfigurationStore(database)
    const smtp =
      options.emailProvider ??
      new SmtpMailer({ url: config.smtp.url, from: config.smtp.from })
    const verify =
      options.verifyEmailProvider ??
      (smtp instanceof SmtpMailer ? () => smtp.verify() : undefined)
    // Checked at startup because a wrong password is worth hearing about now
    // rather than at the first invoice -- but never fatal. Refusing to boot
    // over unreachable mail means a mail server that goes down at the wrong
    // moment stops the instance from coming back, and it means nobody can
    // evaluate ezacto without standing up SMTP first. An instance that runs and
    // cannot send beats an instance that does not run: the queue and the email
    // log exist precisely so a send can fail and be retried.
    if (verify !== undefined) {
      try {
        await verify()
      } catch (error) {
        console.warn(
          `ezacto: outbound mail is not reachable at ${smtpEndpoint(config.smtp.url)} ` +
            `(${error instanceof Error ? error.name : 'unknown error'}). ` +
            'The instance is starting; mail will be retried from the queue.',
        )
      }
    }
    const emailSuppressions = createContainerEmailSuppressionStore(database)
    const objects = await createDiskAttachmentObjectStore(
      config.attachmentDirectory,
    )
    queue = new ContainerEmailQueue(emailLog, smtp, emailSuppressions.lookup, async (reference) => {
      const object = await objects.get(reference.key)
      return object === null ? null : new Uint8Array(await new Response(object.body).arrayBuffer())
    })
    // HTML mail wears the instance header (#1011): read when each message
    // is queued, so a changed logo or colour reaches the next send.
    const brandAssetStore = createContainerBrandAssetStore(database)
    const instanceThemeStore = createContainerInstanceThemeStore(database)
    const queuedMailer = createQueuedMailer(
      emailLog,
      withEmailBrand(queue, async () =>
        emailBrandFrom(
          {
            assets: await brandAssetStore.list(),
            palette: (await instanceThemeStore.read())?.palette ?? null,
            organizationName:
              (
                database
                  .prepare('SELECT name FROM organizations WHERE id = 1')
                  .get() as { name: string } | undefined
              )?.name ?? 'Ezacto',
          },
          config.appBaseUrl,
        ),
      ),
    )
    // One service behind two ports: the password routes take it whole, the
    // add-an-address route takes only `addEmail`.
    const passwordAuth = createContainerPasswordAuthService(database)
    const moneyResources = createMoneyResourceRepository(drizzle)
    const organizationMailer = createSenderBoundQueuedMailer(
      emailConfiguration,
      queuedMailer,
      smtp.name,
      config.smtp.from,
    )
    // The mail the instance sends its own people (budget alerts, issue 934):
    // the deployment sender, on the same queue as the rest. The container
    // always has one.
    const notificationMailer = createDeploymentNotificationMailer(config.smtp.from, queuedMailer)
    // Time reminders and the week-end submission reminders (issue 935), on the
    // same sender, with the instance's own address for the links.
    const timeReminders = createTimeReminderService(
      {
        prepare: (now: string) =>
          prepareTimeReminders(drizzle, {
            now,
            from: notificationMailer.from,
            appUrl: config.appBaseUrl,
          }),
      },
      notificationMailer,
    )
    const stripeAlertNotices = createTimeReminderService({ prepare: (now: string) => prepareStripePaymentAlertNotifications(drizzle, { now, from: notificationMailer.from, appUrl: config.appBaseUrl }) }, notificationMailer)
    const scheduledRunNotices = createTimeReminderService(
      {
        prepare: (now: string) => prepareScheduledRunNotifications(drizzle, { reviewLinkSigningKey: config.cursorSigningKey,
          now, from: notificationMailer.from, appUrl: config.appBaseUrl,
        }),
      },
      notificationMailer,
    )
    const reminders = createContainerReminderScheduler(database)
    // The same connection the Worker composes. A self-hoster's QuickBooks is
    // the same QuickBooks, and the only thing this needs that the Worker has is
    // an outbound fetch.
    const quickBooks =
      config.quickBooks === undefined
        ? null
        : createQuickBooksRuntime({
            config: {
              clientId: config.quickBooks.clientId,
              clientSecret: config.quickBooks.clientSecret,
              webhookVerifierToken: config.quickBooks.webhookVerifierToken,
              environment: config.quickBooks.environment,
              appBaseUrl: config.appBaseUrl,
            },
            store: createQuickBooksStore(drizzle),
            source: createQuickBooksMirrorSource(drizzle, () => new Date()),
            reconciliation: createQuickBooksReconciliationSource(drizzle),
            fetch: (request: Request) => fetch(request),
            now: () => new Date(),
          })

    // And the same Wise connection. A contractor paid by a self-hoster connects
    // their own account exactly as one paid by the hosted deployment does.
    const paymentRuns = createPaymentRunsService(
      drizzle,
      config.wise === undefined
        ? null
        : createWisePaymentProvider({ token: config.wise.token, profileId: config.wise.profileId }),
    )
    const wise =
      config.wise === undefined
        ? null
        : createWiseRuntime({
            config: {
              token: config.wise.token,
              profileId: config.wise.profileId,
              webhookPublicKey: config.wise.webhookPublicKey,
            },
            accounts: (() => {
              const store = createPayoutAccountStore(drizzle)
              return {
                listForUser: (userId: number) => store.listForUser(userId),
                listForProvider: (provider: 'wise') => store.listForProvider(provider),
                awaitingDestination: (provider: 'wise') => store.awaitingDestination(provider),
                link: (input: {
                  userId: number
                  provider: 'wise'
                  externalId: string
                  kind?: 'account' | 'contact'
                  linkedByUserId: number
                  now: string
                }) => store.link(input),
                markVerified: (id: number, now: string) => store.markVerified(id, now),
                detach: (id: number, now: string) => store.detach(id, now),
              }
            })(),
            deliveries: createWiseDeliveryStore(drizzle),
            fetch: (input, init) => fetch(input as RequestInfo, init as RequestInit),
            now: () => new Date(),
          })

    const bill = createBillRuntime({
      config: {
        devKey: config.bill?.devKey,
        companyId: config.bill?.companyId,
        username: config.bill?.username,
        password: config.bill?.password,
        replyToUserId: config.bill?.replyToUserId,
        environment: config.bill?.environment,
      },
      links: createBillLinkStore(drizzle, () => new Date()),
      source: createBillMirrorSource(drizzle, () => new Date()),
      fetch: (request: Request) => fetch(request),
      now: () => new Date(),
    })

    const stripeAlerts = createStripePaymentAlertStore(drizzle)
    const stripeLinks = createStripeLinkStore(drizzle)
    const stripe = createStripeRuntime({
      config: {
        apiKey: config.stripe?.apiKey,
        webhookSecret: config.stripe?.webhookSecret,
      },
      source: {
        recordAlert: (input) => stripeAlerts.record(input, new Date().toISOString()),
        readInvoice: async (invoiceId: number) => {
          const rows = await drizzle.all<{
            id: number
            number: string
            currency: string
            due: number
            card: number
          }>(sql`SELECT id, number, currency, due_amount_cents AS due,
                   EXISTS (SELECT 1 FROM json_each(payment_options)
                           WHERE value = 'stripe_checkout') AS card
                 FROM invoices WHERE id = ${invoiceId}`)
          const row = rows[0]
          return row === undefined
            ? null
            : {
                id: row.id,
                number: row.number,
                currency: row.currency,
                dueAmountCents: row.due,
                acceptsCard: row.card === 1,
              }
        },
        readLink: (invoiceId: number) =>
          stripeLinks.read(invoiceId).then((link) =>
            link === null ? null : { paymentLinkId: link.paymentLinkId, url: link.url },
          ),
        saveLink: async (invoiceId: number, link: { paymentLinkId: string; url: string }) => {
          const saved = await stripeLinks.save({
            invoiceId,
            paymentLinkId: link.paymentLinkId,
            url: link.url,
            now: new Date().toISOString(),
          })
          return { paymentLinkId: saved.paymentLinkId, url: saved.url }
        },
        invoiceForLink: (paymentLinkId: string) => stripeLinks.invoiceFor(paymentLinkId),
        recordPayment: async (input: {
          invoiceId: number
          paymentIntentId: string
          amountCents: number
        }) => {
          await recordCheckoutPayment(drizzle, {
            invoiceId: input.invoiceId,
            provider: 'stripe',
            externalAccountId: 'stripe',
            accountDisplayName: 'Stripe',
            providerTransactionId: input.paymentIntentId,
            amountCents: input.amountCents,
            paidOn: new Date().toISOString().slice(0, 10),
            now: new Date().toISOString(),
          })
        },
      },
      fetch: (request: Request) => fetch(request),
      now: () => new Date(),
    })

    // The thank-you an invoice sends when it settles (issue 545). Subscribes to
    // `invoice.paid`, which the reducer emits only when the payment status
    // actually changes to paid, so a part payment reaches nothing here.
    const thankYou = createThankYouPort({
      database: drizzle,
      configuration: emailConfiguration,
      invoices: {
        read: async (invoiceId: number) => {
          const context = await moneyResources.getInvoiceDeliveryContext(invoiceId)
          return context === null ? null : thankYouInvoiceFromDeliveryContext(context)
        },
      },
      now: () => new Date().toISOString(),
    })

    // The reminder an overdue invoice sends (issue 801): the same port the
    // Worker composes, driven from the outbox tick below rather than a cron,
    // because the container has no other clock.
    const reminderPort = createReminderPort({
      database: drizzle,
      configuration: emailConfiguration,
      invoices: {
        read: async (invoiceId: number) => {
          const context = await moneyResources.getInvoiceDeliveryContext(invoiceId)
          return context === null ? null : thankYouInvoiceFromDeliveryContext(context)
        },
        paymentUrl: invoicePaymentUrlForMail({ bill, stripe }),
      },
      now: () => new Date().toISOString(),
    })
    const processDueReminders = (now: string, options: ReminderProcessOptions = {}) =>
      reminders.processReminders({
        ...options,
        now,
        send: async (reminder) => {
          const message = await reminderPort.prepare(reminder)
          if (message === null) throw new Error('reminder has nothing to send')
          if (organizationMailer?.enqueuePersisted === undefined) {
            throw new Error('reminder durable enqueue is unavailable')
          }
          await organizationMailer.enqueuePersisted(
            message.deliveryId,
            {
              senderIdentityId: message.senderIdentityId,
              senderIdentityVersion: message.senderIdentityVersion,
              senderEvidenceVersion: message.senderEvidenceVersion,
              from: { email: message.fromEmail, name: message.fromName },
              ...(message.replyToEmail === null ? {} : { replyTo: [{ email: message.replyToEmail }] }),
            },
            {
              to: message.to.map((person) =>
                person.name === '' ? { email: person.email } : { email: person.email, name: person.name },
              ),
              // Whoever the invoice copied is copied on its reminders.
              ...(message.cc.length === 0
                ? {}
                : {
                    cc: message.cc.map((person) =>
                      person.name === ''
                        ? { email: person.email }
                        : { email: person.email, name: person.name },
                    ),
                  }),
              template: `reminder:${String(message.templateVersion)}`,
              subject: message.subject,
              text: message.textBody,
              ...(message.htmlBody === null ? {} : { html: message.htmlBody }),
              related: { type: 'invoice', id: reminder.invoiceId },
            },
          )
        },
      })

    const outbox = createContainerOutboxService(database, {
      additionalSubscribers: [
        createInvoiceEmailOutboxSubscriber(moneyResources, organizationMailer),
        createInvoiceThankYouSubscriber(thankYou, organizationMailer),
        createBudgetAlertSubscriber(
          {
            prepare: (alertId: number) =>
              prepareBudgetAlertMail(drizzle, {
                alertId,
                from: notificationMailer.from,
                now: new Date().toISOString(),
              }),
          },
          notificationMailer,
        ),
        reminders.subscriber,
        // Without this the container would connect to QuickBooks and never
        // mirror anything -- the routes would work and no invoice would move.
        ...(quickBooks === null ? [] : [createQuickBooksMirrorSubscriber(quickBooks)]),
        createBillMirrorSubscriber(bill),
      ],
    })
    const organizationName = async () => {
      const row = database
        .prepare('SELECT name FROM organizations WHERE id = 1')
        .get() as { name: string } | undefined
      return row?.name ?? 'Ezacto'
    }
    // Payments made at BILL (issue 834). The poll is every fifteen seconds
    // and this walks BILL's receivables, so it is held to once an hour; the
    // Worker runs the same thing from an hourly cron. It never throws.
    const reconcileBillPayments = createScheduledBillReconciliation({
      reconcile: bill.reconcilePayments,
      everyMs: 3_600_000,
      report: (error) => {
        console.error('[container] BILL reconciliation failed', error)
      },
    })
    // Budget alerts (issue 934). The tick is every fifteen seconds and a pass
    // reads each alerting project's time, so it is held to once a minute, the
    // Worker's own cadence. A failed pass is reported and never stops the drain.
    const scheduledRunDispatch = createScheduledRunDispatchService(drizzle, {
      sender: async () => {
        await organizationMailer.assertAvailable()
        const sender = await emailConfiguration.resolveSenderIdentity()
        if (!sender?.evidence) throw new Error('A verified sender identity is required for month-end delivery.')
        return {
          senderIdentityId: sender.id, senderIdentityVersion: sender.version, senderEvidenceVersion: sender.evidence.version,
          from: { email: sender.email, name: sender.displayName },
          ...(sender.replyToEmail === null ? {} : { replyTo: [{ email: sender.replyToEmail }] }),
        }
      },
      enqueue: organizationMailer.enqueuePersisted!.bind(organizationMailer),
      readBytes: async (key: string) => {
        const object = await objects.get(key)
        return object === null ? null : new Uint8Array(await new Response(object.body).arrayBuffer())
      },
      now: () => new Date().toISOString(),
    })
    // The operator's invoices switch (issue 1254): where it is off the invoice
    // sweeps below do not run, and what they would have touched stays as is.
    const invoicesOn = moduleAvailability(config.appEnv).invoices
    let lastMinutePass = 0
    const minutePasses = async (): Promise<void> => {
      const at = Date.now()
      if (at - lastMinutePass < 60_000) return
      lastMinutePass = at
      const now = new Date(at).toISOString()
      try {
        await webhooks.processDue()
        await webhooks.purge()
      } catch {
        console.error('[container] webhook sweep failed')
      }
      try {
        await evaluateProjectBudgetAlerts(drizzle, now)
      } catch (error) {
        console.error('[container] budget alert evaluation failed', error)
      }
      // Time reminders (issue 935) are due on each person's own local minute,
      // so they are looked at every minute too.
      try {
        await timeReminders.processDue(now)
      } catch (error) {
        console.error('[container] time reminders failed', error)
      }
      // Automatic timesheet approval (issue 1009): a bounded batch of weeks the
      // policy has made due; a no-op while the policy is off.
      try {
        const run = await runTimesheetAutoApproval(drizzle, now)
        for (const failure of run.failed) {
          console.error('[container] automatic approval failed', failure.submissionId, failure.message)
        }
      } catch (error) {
        console.error('[container] automatic approval sweep failed', error)
      }
      if (!invoicesOn) return
      try { await deelPaymentStatus.refresh(null) } catch { console.error('[container] Deel payment status refresh failed') }
      try {
        const result = await proposeDueScheduledJobs(drizzle, now, objects)
        for (const failure of result.failed)
          console.error('[container] scheduled job proposal failed', failure.jobId, failure.message)
      } catch (error) {
        console.error('[container] scheduled job proposal sweep failed', error)
      }
      try {
        await stripeAlertNotices.processDue(now)
      } catch (error) {
        console.error('[container] Stripe alert notice failed', error)
      }
      try {
        await scheduledRunNotices.processDue(now)
      } catch (error) {
        console.error('[container] scheduled manifest notice failed', error)
      }
      try {
        const result = await scheduledRunDispatch.processDue(now)
        for (const failure of result.failed) console.error('[container] scheduled run item failed', failure)
      } catch (error) {
        console.error('[container] scheduled run dispatch failed', error)
      }
      // Proposed month-end runs past their deadline (issue 63); reports its
      // own failure and never stops the drain.
      await sweepExpiredRuns(createScheduledActionStore(drizzle), now, (error) => {
        console.error('[container] scheduled run expiry failed', error)
      })
    }
    outboxScheduler = new ContainerOutboxScheduler(outbox, {
      // Reminders that have come due go out on the same tick the outbox
      // drains, before it, so the sends they enqueue are drained in the same
      // pass. Cheap when nothing is due: one indexed read. The BILL receipts
      // it records are drained in the same pass too.
      beforeDrain: async () => {
        await paymentRuns.processDue(new Date().toISOString())
        await minutePasses()
        if (invoicesOn) await processDueReminders(new Date().toISOString())
        await reconcileBillPayments()
      },
    })
    const brandAssets = await createContainerBrandAssetSurface(
      database,
      config.brandDirectory,
    )
    const instanceTheme = createContainerInstanceThemeSurface(database)

    const services: RuntimeServices = {
      csvImportStaging:csvStaging.port,
      bootstrap: (input) => bootstrapInstanceContainer(database, input),
      enrollOwnerPassword: (input) =>
        enrollInstanceOwnerPasswordContainer(database, input),
      tokens: createApiTokenStore(drizzle, touch),
      projectMissingRates: { recover: input => recoverProjectMissingRates(drizzle, input, dates => timesheetLockPolicy.lockedDates(dates)) },
      generalResources: createGeneralResourceRepository(drizzle),
      clientTree: {
        ancestors: (clientId) => listClientAncestors(drizzle, clientId),
        descendants: (clientId) => listClientDescendants(drizzle, clientId),
      },
      team: createTeamRepository(drizzle),
      invoiceElevations: createInvoiceElevationStore(drizzle),
    invoiceTimeUnlink: (command, elevation, now) => unlinkElevatedInvoiceTime(drizzle, command, elevation, now),
    webhooks,
    migrationLoads: {status:async(id:string)=>database.prepare(`SELECT ${migrationLoadStatusProjection} FROM migration_loads WHERE id=?`).get(id) as MigrationLoadStatus|undefined??null},
    estimateTemplates: createEstimateTemplateRepository(drizzle),
    clientRateCards: createClientRateCardRepository(drizzle),
      trackedResources,
      calendarProposals: new DrizzleCalendarProposalRepository(drizzle, trackedResources),
      placeholderPlanning: createPlaceholderAllocationRepository(drizzle),
      allocations: new DrizzleAllocationRepository(drizzle),
      calendarFeeds: createCalendarFeedService(drizzle),
      resourceCalendar: createResourceCalendarRepository(drizzle),
      organizationHolidays: createOrganizationHolidayRepository(drizzle),
      workItems: {
        repository: new DrizzleWorkItemRepository(drizzle),
        credentialConfigured: (provider) =>
          workItemCredentialConfigured(config.appEnv, provider),
      },
      profile: {
        readTimezone: async (userId) => await readUserTimezone(drizzle, userId),
        readEffectiveTimezone: async (userId) => await readEffectiveUserTimezone(drizzle, userId),
        readIdentity: async (userId) => await readUserIdentity(drizzle, userId),
        updateTimezone: async (userId, timezone, occurredAt) => {
          await updateUserTimezone(drizzle, userId, timezone, occurredAt)
        },
        // Whether this person is copied on the invoice emails they send.
        readInvoiceCopy: async (userId) =>
          (await readInvoiceSenderCopy(drizzle, userId))?.copy ?? null,
        updateInvoiceCopy: async (userId, copy, occurredAt) => {
          await setInvoiceSenderCopy(drizzle, userId, copy, occurredAt)
        },
        // Records the ask and names who decides; changes nothing about the account.
        requestDeletion: (input) =>
          requestAccountDeletion(drizzle, {
            userId: input.userId,
            occurredAt: input.occurredAt,
            captureId: input.requestId,
          }),
      },
      isExpensesModuleEnabled: async () => {
        const row = database
          .prepare(
            `SELECT COALESCE(json_extract(modules, '$.expenses'), 0) AS enabled
             FROM organizations WHERE id = 1`,
          )
          .get() as { enabled: number } | undefined
        return row?.enabled === 1
      },
      // The #520 setting, read the same way the module gates beside it are.
      // Absent key means off, so a container that upgrades keeps every rate
      // where it was.
      isOwnMoneyVisible: async () => {
        const row = database
          .prepare(
            `SELECT COALESCE(json_extract(modules, '$.own_money'), 0) AS enabled
             FROM organizations WHERE id = 1`,
          )
          .get() as { enabled: number } | undefined
        return row?.enabled === 1
      },
      isActivityLogModuleEnabled: async () => {
        const row = database
          .prepare(
            `SELECT COALESCE(json_extract(modules, '$.activity_log'), 1) AS enabled
             FROM organizations WHERE id = 1`,
          )
          .get() as { enabled: number } | undefined
        return row === undefined || row.enabled === 1
      },
      isTeamModuleEnabled: async () => {
        const row = database
          .prepare(
            `SELECT COALESCE(json_extract(modules, '$.team'), 0) AS enabled
             FROM organizations WHERE id = 1`,
          )
          .get() as { enabled: number } | undefined
        return row?.enabled === 1
      },
      moneyResources,
      ...(quickBooks === null ? {} : { quickBooks: quickBooks.service }),
      ...(wise === null ? {} : { wise: wise.service }),
      ...(wise?.webhook === undefined ? {} : { wiseWebhook: wise.webhook }),
      paymentRuns,
      scheduledRunNotices,
      scheduledRunDispatch,
      scheduledJobs: createScheduledJobsService(drizzle),
      scheduledJobProposals: { processDue: (now: string) => proposeDueScheduledJobs(drizzle, now, objects) },
      scheduledRuns: createScheduledRunsService(drizzle, {reviewLinkSigningKey:config.cursorSigningKey}),
      staffPayments: createStaffPaymentStore(drizzle),
      deelPaymentStatus,
      deelStaging: createDeelStagingRuntime({token:demoDeployment(config.appEnv)?undefined:config.deel?.token,startDate:config.deel?.startDate,store:createDeelStageStore(drizzle),fetch:(request:Request)=>fetch(request),now:()=>new Date()}),
      contractorReview: createContractorReviewStore(drizzle),
      myPayments: createMyPaymentsStore(drizzle),
      payoutAccounts: (() => {
        const store = createPayoutAccountStore(drizzle)
        return {
          listForUser: (userId: number) => store.listForUser(userId),
          link: (input: {
            userId: number
            provider: 'deel' | 'wise'
            externalId: string
            linkedByUserId: number
          }) => store.link({ ...input, now: new Date().toISOString() }),
          read: (id: number) => store.read(id),
          detach: (id: number) => store.detach(id, new Date().toISOString()),
        }
      })(),
      stripe,
      invoiceProviderAlerts: stripeAlerts,
      stripeAlertNotices,
      // Turning the document on and off. The preference existed before anything
      // could set it, which is a decision made on the operator's behalf that they
      // could not revisit (issue 626).
      invoiceDocumentPreference: {
        readInvoicePreference: (invoiceId: number, kind: 'document' | 'files' | 'append') =>
          kind === 'document'
            ? readAttachPreference(drizzle, invoiceId)
            : kind === 'append'
              ? readAppendPreference(drizzle, invoiceId)
              : readFilesPreference(drizzle, invoiceId),
        setInvoicePreference: (
          invoiceId: number,
          kind: 'document' | 'files' | 'append',
          enabled: boolean | null,
        ) =>
          kind === 'document'
            ? setInvoiceAttachPolicy(drizzle, { invoiceId, enabled })
            : kind === 'append'
              ? setInvoiceAppendPolicy(drizzle, { invoiceId, enabled })
              : setInvoiceFilesPolicy(drizzle, { invoiceId, enabled }),
        readOrganizationPreference: (kind: 'document' | 'files' | 'append') =>
          kind === 'document'
            ? readOrganizationAttachPolicy(drizzle)
            : kind === 'append'
              ? readOrganizationAppendPolicy(drizzle)
              : readOrganizationFilesPolicy(drizzle),
        setOrganizationPreference: (kind: 'document' | 'files' | 'append', enabled: boolean) =>
          kind === 'document'
            ? setOrganizationAttachPolicy(drizzle, enabled)
            : kind === 'append'
              ? setOrganizationAppendPolicy(drizzle, enabled)
              : setOrganizationFilesPolicy(drizzle, enabled),
        // The work journal, whose answer is a level rather than a flag (647).
      readInvoiceJournal: (invoiceId: number) => readJournalPreference(drizzle, invoiceId),
      setInvoiceJournal: (invoiceId: number, level: 'detailed' | 'summary' | false | null) =>
        setInvoiceJournalPolicy(drizzle, { invoiceId, level }),
      readOrganizationJournal: () => readOrganizationJournalPolicy(drizzle),
      setOrganizationJournal: (level: 'detailed' | 'summary' | false) =>
        setOrganizationJournalPolicy(drizzle, level),
        // The files the journal goes as, at whichever level (647).
        readInvoiceJournalFormats: (invoiceId: number) =>
          readJournalFormatsPreference(drizzle, invoiceId),
        setInvoiceJournalFormats: (
          invoiceId: number,
          formats: readonly ('pdf' | 'csv' | 'xlsx')[] | null,
        ) => setInvoiceJournalFormats(drizzle, { invoiceId, formats }),
        readOrganizationJournalFormats: () => readOrganizationJournalFormats(drizzle),
        setOrganizationJournalFormats: (formats: readonly ('pdf' | 'csv' | 'xlsx')[]) =>
          setOrganizationJournalFormats(drizzle, formats),
    },
      // Who an invoice email reaches and what it carries, as standing rules.
      invoiceSending: {
        emailDefaults: (invoiceId: number, userId: number) =>
          readInvoiceEmailDefaults(drizzle, emailConfiguration, invoiceId, userId),
        readClientSending: (clientId: number) => readClientInvoiceSending(drizzle, clientId),
        saveClientSending: (
          clientId: number,
          change: Parameters<typeof saveClientInvoiceSending>[2],
          updatedAt: string,
        ) => saveClientInvoiceSending(drizzle, clientId, change, updatedAt),
        readAlwaysCc: () => readOrganizationAlwaysCc(drizzle),
        saveAlwaysCc: (addresses: Parameters<typeof setOrganizationAlwaysCc>[1]) =>
          setOrganizationAlwaysCc(drizzle, addresses),
      },
      invoiceEmailSending: {
        alwaysCc: () => readOrganizationAlwaysCc(drizzle),
        senderCopy: (userId: number) => readInvoiceSenderCopy(drizzle, userId),
        previewsSince: (invoiceId: number, since: string) =>
          countInvoicePreviewsSince(drizzle, invoiceId, since),
      },
      // The same journal as a download (647), from the same store the email
      // reads, so the file an operator checks is the file a client is sent.
      invoiceHoursReport: {
        readHoursReport: (invoiceId: number) => readInvoiceHoursReport(drizzle, invoiceId),
      },
      // Billed hours against the entries the invoice claims (issue 924).
      invoiceHoursReconciliation: {
        releaseLineTime: (command, actorUserId, now) => releaseInvoiceLineTime(drizzle, command, actorUserId, now),
      readHoursReconciliation: (invoiceId: number) =>
          readInvoiceHoursReconciliation(drizzle, invoiceId),
      },
      // Suppressing the thank-you for one invoice (issue 545), which is the
      // half that has to be reachable before the payment lands: some invoices
      // settle a dispute.
      // Definitions an import could not finish (issue 648). Live billing that
      // no screen could see and no route could repair until now.
      recurringRepair: {
        listIncomplete: () => moneyResources.listIncompleteRecurring(),
        complete: (id: number, terms: Parameters<typeof moneyResources.completeRecurring>[1]) =>
          moneyResources.completeRecurring(id, terms),
      },
      thankYouPreference: {
        readInvoiceThankYou: (invoiceId: number) => readThankYouPreference(drizzle, invoiceId),
        setInvoiceThankYou: (invoiceId: number, enabled: boolean | null) =>
          setInvoiceThankYouPolicy(drizzle, { invoiceId, enabled }),
        readOrganizationThankYou: () => readOrganizationThankYouPolicy(drizzle),
        setOrganizationThankYou: (enabled: boolean) =>
          setOrganizationThankYouPolicy(drizzle, enabled),
      },
      reminders: { processDue: processDueReminders },
      budgetAlerts: {
        evaluate: (now: string) => evaluateProjectBudgetAlerts(drizzle, now),
      },
      timeReminders,
      timesheetAutoApproval: createTimesheetAutoApprovalService({
        read: () => readTimesheetAutoApproval(drizzle),
        update: (actorUserId, patch) =>
          updateTimesheetAutoApproval(drizzle, actorUserId, patch, new Date().toISOString()),
      }),
      timesheetAutoApprovalSweep: {
        processDue: (now: string) => runTimesheetAutoApproval(drizzle, now),
      },
      profileNotifications: {
        read: (userId: number) => readUserNotifications(drizzle, userId),
        update: (userId: number, patch) =>
          updateUserNotifications(drizzle, userId, patch, new Date().toISOString()),
      },
      notificationSettings: createNotificationSettingsService({
      read: () => readNotificationSettings(drizzle),
      update: (patch) => updateNotificationSettings(drizzle, patch, new Date().toISOString()),
    }),
      reminderSettings: createReminderSettings(drizzle, reminders, () => new Date().toISOString()),
      // The hosted invoice page and its receipts (issue 936), mounted exactly
      // where the Worker mounts them. This entry keeps no rendered invoice
      // documents, so its page offers none to download.
      invoiceView: createInvoiceViewService({
        database: drizzle,
        paymentUrl: invoicePaymentUrlForMail({ bill, stripe }),
      }),
      ...(invoiceViewLinkOrigin(config.appBaseUrl) === null
        ? {}
        : {
            invoiceViewLinks: createInvoiceViewLinkIssuer(
              drizzle,
              invoiceViewLinkOrigin(config.appBaseUrl)!,
            ),
          }),
      invoiceViewReceipts: (invoiceMessageIds: readonly number[]) =>
        readViewReceipts(drizzle, invoiceMessageIds),
      // Invoices › Configure: what every invoice prints and every draft starts with.
      invoiceDefaults: {
        read: () => readInvoiceDefaults(drizzle),
        update: (patch: Parameters<typeof updateInvoiceDefaults>[1]) =>
          updateInvoiceDefaults(drizzle, patch, new Date().toISOString()),
      },
      // The same seam the Worker composes: both entries must answer this route
      // or `entry-surface.ts` fails the one that does and the one that does not.
      invoiceTimeClaims: {
        releaseInvoicedTime: async (invoiceId: number) => {
          const outcome = await releaseInvoicedTimeEntries(drizzle, invoiceId)
          return 'released' in outcome
            ? ({ kind: 'released', released: outcome.released } as const)
            : ({ kind: 'refused', reason: outcome.refused } as const)
        },
      },
      bill,
      billDelivery: {
        isOptedIn: (clientId: number) =>
          createBillMirrorSource(drizzle, () => new Date()).isOptedIn(clientId),
        setOptedIn: (clientId: number, enabled: boolean) =>
          setBillDelivery(drizzle, clientId, enabled),
      },
      invoiceGeneration: createInvoiceGenerationService(drizzle),
      recurringInvoices: createRecurringInvoiceEngine(drizzle),
      // #712. The container runs the same routes as the worker, so it carries
      // the same reader -- a backfill that worked only on one of them would be
      // an operation whose availability depended on where you happened to run.
      bandClaimBackfill: {
        backfill: (input: Parameters<BandClaimBackfillPort['backfill']>[0]) =>
          backfillBandClaims(drizzle, input),
      },
      // #750. Carried for the same reason as the claim backfill above.
      costRateBackfill: {
        backfill: (input: Parameters<CostRateBackfillPort['backfill']>[0]) =>
          backfillCostRates(drizzle, input),
      },
      activity: {
        capture: async (request) => {
          await captureActivityEvent(drizzle, request)
        },
      },
      activityRoll: createActivityRoll(drizzle, () => new Date().toISOString()),
      reports: createReportRepository(drizzle),
      moduleSettings: createModuleSettingsRepository(drizzle),
      signInMethods: createSignInMethodRepository(drizzle),
    accountRetention: createAccountRetentionRepository(drizzle),
    accountDeletionRequests: createAccountDeletionRequestRepository(drizzle),
    accountClosure: createAccountClosureRepository(drizzle),
    accountRetentionReview: createAccountRetentionReviewRepository(drizzle),
    nativeAppleLifecycle: createAppleLifecycleRepository(drizzle),
    accountDeletionTracking: createAccountDeletionStatusRepository(drizzle),
      organizationName,
      ssoProvisioningDomains:
        createContainerSsoProvisioningDomainStore(database),
      twoFactor: createTwoFactorService({
        store: createContainerTwoFactorStore(database),
        accountName: async (userId) =>
          (
            database
              .prepare(
                `SELECT address FROM user_emails
                   WHERE user_id = ? AND invalidated_at IS NULL AND verified_at IS NOT NULL
                   ORDER BY is_primary DESC, id LIMIT 1`,
              )
              .get(userId) as { address: string } | undefined
          )?.address ?? `user-${userId}`,
        issuer: config.appEnv.BRAND_NAME ?? 'ezacto',
        // The emailed second factor (issue 770); see the worker runtime.
        emailCodeKey: await deriveTwoFactorEmailCodeKey(config.cursorSigningKey),
        emailAddress: async (userId) =>
          (
            database
              .prepare(
                `SELECT address FROM user_emails
                   WHERE user_id = ? AND invalidated_at IS NULL AND verified_at IS NOT NULL
                   ORDER BY is_primary DESC, id LIMIT 1`,
              )
              .get(userId) as { address: string } | undefined
          )?.address ?? null,
      }),
      // The container always has a mailer.
      twoFactorEmailCodes: createQueuedTwoFactorEmailCodeMailer(
        createDeploymentSenderQueuedMailer(config.smtp.from, queuedMailer),
        organizationName,
      ),
      timesheetApprovals: createTimesheetApprovalRepository(drizzle),
      timesheetLockPolicy,
      cursorSigningKey: config.cursorSigningKey,
      idempotency: {
        // The handle itself: the store's own statements never carry a claim.
        store: createContainerIdempotencyStore(handle),
        secret: await deriveIdempotencySecret(config.cursorSigningKey),
      },
      passwordAuth,
      userEmails: passwordAuth,
      sessions,
      emailLog,
      emailSuppressions,
      emailConfiguration,
      senderIdentityVerifier: createSmtpSenderIdentityVerifier(config.smtp.from),
      outbox,
      identities: createContainerIdentityStore(database),
      ...createRuntimeAppleWeb(config.appEnv, createContainerAppleWebCustodyStore(database)),
      oidcTransactions: createContainerOidcTransactionStore(database),
      oidcAppCodes: createContainerOidcAppCodeStore(database),
      // Same opt-in as portalAuth below: mounted only with a code-signing key,
      // never with a weak one. The container always has a mailer.
      ...(config.magicLinkSigningKey === undefined
        ? {}
        : {
            staffMagicLinks: {
              users: createContainerStaffUserDirectory(database),
              store: createContainerStaffMagicLinkStore(database),
              mailer: createQueuedStaffMagicLinkMailer(
                createDeploymentSenderQueuedMailer(
                  config.smtp.from,
                  queuedMailer,
                ),
                organizationName,
              ),
              codeKey: config.magicLinkSigningKey,
            },
          }),
      // The container always has a mailer, so administrators always hear of it.
      accountDeletionMailer: createQueuedAccountDeletionMailer(
        createDeploymentSenderQueuedMailer(config.smtp.from, queuedMailer),
        organizationName,
      ),
      deploymentAuthMailer: createQueuedAuthMailer(
        createDeploymentSenderQueuedMailer(
          config.smtp.from,
          queuedMailer,
        ),
        emailConfiguration,
        organizationName,
        config.appBaseUrl,
      ),
      organizationMailer,
      // Opt-in on the presence of its key, exactly as the Worker's is. Without
      // one the routes are not mounted at all rather than mounted with a weak
      // secret -- they hand out sessions, so "configured badly" and "not
      // configured" must not look the same. Absent here, the container simply
      // had no portal at all (#374).
      ...(config.portalMagicLinkSigningKey === undefined
        ? {}
        : {
            portalAuth: {
              mailer: createQueuedPortalMagicLinkMailer(
                createDeploymentSenderQueuedMailer(config.smtp.from,queuedMailer),organizationName,config.appBaseUrl,
              ),
              service: createMagicLinkService({
                database: {
                  all: async (query: { sql: string; params: readonly unknown[] }) =>
                    database.prepare(query.sql).all(...query.params) as never[],
                },
                store: createContainerMagicLinkStore(database),
                signingKey: config.portalMagicLinkSigningKey,
              }),
              sessions: createPortalSessionService(
                createContainerContactSessionStore(database, touch),
              ),
              sessionStore: createContainerContactSessionStore(database, touch),
              estimates: {
                list: (clientId: number) => moneyResources.listCustomerEstimates(clientId),
                get: (clientId: number, estimateId: number) =>
                  moneyResources.getCustomerEstimate(clientId, estimateId),
                respond: (input) =>
                  moneyResources.respondToEstimate({ ...input, occurredAt: new Date().toISOString() }),
              },
            },
          }),
      attachments: {
        metadata: createAttachmentStore(drizzle),
        objects,
        authorizeOwnerAccess:
          createContainerAttachmentOwnerAuthorizer(database),
      },
    }
    outboxScheduler.start()

    let closed = false
    return {
      database,
      services,
      brandAssets,
      instanceTheme,
      drainOutbox: () => outboxScheduler!.drain(),
      async close(timeoutMs) {
        if (closed) return
        closed = true
        try {
          await outboxScheduler!.close(timeoutMs)
          await queue!.close(timeoutMs)
          database.pragma('wal_checkpoint(TRUNCATE)')
        } finally {
          if(csvSweep)clearInterval(csvSweep)
          csvStaging?.close()
          database.close()
        }
      },
    }
  } catch (error) {
    await outboxScheduler?.close().catch(() => undefined)
    await queue?.close().catch(() => undefined)
    if(csvSweep)clearInterval(csvSweep)
    csvStaging?.close()
    if (database.open) database.close()
    throw error
  }
}
import { createResourceCalendarRepository } from '@ezacto/db'
