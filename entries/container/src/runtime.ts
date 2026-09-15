import { sql } from 'drizzle-orm'
import { chmod, lstat, mkdir, realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
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
  createRecurringInvoiceEngine,
  createContainerReminderScheduler,
  captureActivityEvent,
  createTwoFactorService,
  createGeneralResourceRepository,
  createInvoiceGenerationService,
  createMoneyResourceRepository,
  createReportRepository,
  createModuleSettingsRepository,
  createTimesheetApprovalRepository,
  createTimesheetLockPolicyRepository,
  createTeamRepository,
  DrizzleTrackedResourceRepository,
  enrollInstanceOwnerPasswordContainer,
  listClientAncestors,
  listClientDescendants,
  migrateContainer,
  createBillLinkStore,
  createBillMirrorSource,
  createPayoutAccountStore,
  createWiseDeliveryStore,
  createStripeLinkStore,
  readAttachPreference,
  readFilesPreference,
  readOrganizationFilesPolicy,
  setInvoiceFilesPolicy,
  setOrganizationFilesPolicy,
  readJournalPreference,
  readOrganizationJournalPolicy,
  setInvoiceJournalPolicy,
  setOrganizationJournalPolicy,
  readOrganizationAttachPolicy,
  setInvoiceAttachPolicy,
  setOrganizationAttachPolicy,
  releaseInvoicedTimeEntries,
  recordCheckoutPayment,
  createThankYouPort,
  readThankYouPreference,
  readOrganizationThankYouPolicy,
  setInvoiceThankYouPolicy,
  setOrganizationThankYouPolicy,
  setBillDelivery,
  createQuickBooksMirrorSource,
  createQuickBooksStore,
  updateUserTimezone,
} from '@ezacto/db'
import {
  createApiSessionService,
  createInvoiceEmailOutboxSubscriber,
  createInvoiceThankYouSubscriber,
  thankYouInvoiceFromDeliveryContext,
  createPortalSessionService,
  createQueuedAuthMailer,
  createQueuedStaffMagicLinkMailer,
  type AttachmentRouteOptions,
  type UserPrincipal,
} from '@ezacto/api'
import {
  configuredEmailSender,
  createDeploymentSenderQueuedMailer,
  createQueuedMailer,
  createSenderBoundQueuedMailer,
  SenderIdentityUnavailableError,
  type HttpEmailProvider,
} from '@ezacto/mailer'
import { SmtpMailer } from '@ezacto/mailer/smtp'
import type {
  BandClaimBackfillPort,
  BrandAssetSurface,
  InstanceThemeSurface,
} from '@ezacto/api'
import type { AppEnv, RuntimeServices } from '../../worker/src/app.js'
import {
  createBillMirrorSubscriber,
  createBillRuntime,
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

export const createContainerRuntime = async (
  config: ContainerConfig,
  options: ContainerRuntimeOptions = {},
): Promise<ContainerRuntime> => {
  await ensureDataDirectory(config.dataDirectory)
  await assertDatabasePath(config.databasePath)
  const database = new BetterSqlite3(config.databasePath, { timeout: 5_000 })
  let queue: ContainerEmailQueue | undefined
  let outboxScheduler: ContainerOutboxScheduler | undefined
  try {
    prepareContainerDatabase(database)
    await chmod(config.databasePath, 0o600)

    const drizzle = createContainerDatabase(database)
    const timesheetLockPolicy = createTimesheetLockPolicyRepository(drizzle)
    const sessions = createApiSessionService(
      createContainerSessionStore(database),
    )
    const emailLog = createContainerEmailLogStore(database)
    const emailConfiguration = createContainerEmailConfigurationStore(database)
    const smtp =
      options.emailProvider ??
      new SmtpMailer({ url: config.smtp.url, from: config.smtp.from })
    const verify =
      options.verifyEmailProvider ??
      (smtp instanceof SmtpMailer ? () => smtp.verify() : undefined)
    if (verify !== undefined) await verify()
    queue = new ContainerEmailQueue(emailLog, smtp)
    const queuedMailer = createQueuedMailer(emailLog, queue)
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
            fetch: (request: Request) => fetch(request),
            now: () => new Date(),
          })

    // And the same Wise connection. A contractor paid by a self-hoster connects
    // their own account exactly as one paid by the hosted deployment does.
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

    const stripeLinks = createStripeLinkStore(drizzle)
    const stripe = createStripeRuntime({
      config: {
        apiKey: config.stripe?.apiKey,
        webhookSecret: config.stripe?.webhookSecret,
      },
      source: {
        readInvoice: async (invoiceId: number) => {
          const rows = await drizzle.all<{
            id: number
            number: string
            currency: string
            due: number
          }>(sql`SELECT id, number, currency, due_amount_cents AS due
                 FROM invoices WHERE id = ${invoiceId}`)
          const row = rows[0]
          return row === undefined
            ? null
            : { id: row.id, number: row.number, currency: row.currency, dueAmountCents: row.due }
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

    const outbox = createContainerOutboxService(database, {
      additionalSubscribers: [
        createInvoiceEmailOutboxSubscriber(moneyResources, organizationMailer),
        createInvoiceThankYouSubscriber(thankYou, organizationMailer),
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
    outboxScheduler = new ContainerOutboxScheduler(outbox)
    const objects = await createDiskAttachmentObjectStore(
      config.attachmentDirectory,
    )
    const brandAssets = await createContainerBrandAssetSurface(
      database,
      config.brandDirectory,
    )
    const instanceTheme = createContainerInstanceThemeSurface(database)

    const services: RuntimeServices = {
      bootstrap: (input) => bootstrapInstanceContainer(database, input),
      enrollOwnerPassword: (input) =>
        enrollInstanceOwnerPasswordContainer(database, input),
      tokens: createApiTokenStore(drizzle),
      generalResources: createGeneralResourceRepository(drizzle),
      clientTree: {
        ancestors: (clientId) => listClientAncestors(drizzle, clientId),
        descendants: (clientId) => listClientDescendants(drizzle, clientId),
      },
      team: createTeamRepository(drizzle),
      trackedResources: new DrizzleTrackedResourceRepository(
        drizzle,
        timesheetLockPolicy,
      ),
      profile: {
        updateTimezone: async (userId, timezone, occurredAt) => {
          await updateUserTimezone(drizzle, userId, timezone, occurredAt)
        },
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
      // Turning the document on and off. The preference existed before anything
      // could set it, which is a decision made on the operator's behalf that they
      // could not revisit (issue 626).
      invoiceDocumentPreference: {
        readInvoicePreference: (invoiceId: number, kind: 'document' | 'files') =>
          kind === 'document'
            ? readAttachPreference(drizzle, invoiceId)
            : readFilesPreference(drizzle, invoiceId),
        setInvoicePreference: (
          invoiceId: number,
          kind: 'document' | 'files',
          enabled: boolean | null,
        ) =>
          kind === 'document'
            ? setInvoiceAttachPolicy(drizzle, { invoiceId, enabled })
            : setInvoiceFilesPolicy(drizzle, { invoiceId, enabled }),
        readOrganizationPreference: (kind: 'document' | 'files') =>
          kind === 'document'
            ? readOrganizationAttachPolicy(drizzle)
            : readOrganizationFilesPolicy(drizzle),
        setOrganizationPreference: (kind: 'document' | 'files', enabled: boolean) =>
          kind === 'document'
            ? setOrganizationAttachPolicy(drizzle, enabled)
            : setOrganizationFilesPolicy(drizzle, enabled),
        // The work journal, whose answer is a level rather than a flag (647).
      readInvoiceJournal: (invoiceId: number) => readJournalPreference(drizzle, invoiceId),
      setInvoiceJournal: (invoiceId: number, level: 'detailed' | 'summary' | false | null) =>
        setInvoiceJournalPolicy(drizzle, { invoiceId, level }),
      readOrganizationJournal: () => readOrganizationJournalPolicy(drizzle),
      setOrganizationJournal: (level: 'detailed' | 'summary' | false) =>
        setOrganizationJournalPolicy(drizzle, level),
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
      activity: {
        capture: async (request) => {
          await captureActivityEvent(drizzle, request)
        },
      },
      reports: createReportRepository(drizzle),
      moduleSettings: createModuleSettingsRepository(drizzle),
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
      }),
      timesheetApprovals: createTimesheetApprovalRepository(drizzle),
      timesheetLockPolicy,
      cursorSigningKey: config.cursorSigningKey,
      passwordAuth,
      userEmails: passwordAuth,
      sessions,
      emailLog,
      emailConfiguration,
      senderIdentityVerifier: createSmtpSenderIdentityVerifier(config.smtp.from),
      outbox,
      identities: createContainerIdentityStore(database),
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
      ...(config.magicLinkSigningKey === undefined
        ? {}
        : {
            portalAuth: {
              service: createMagicLinkService({
                database: {
                  all: async (query: { sql: string; params: readonly unknown[] }) =>
                    database.prepare(query.sql).all(...query.params) as never[],
                },
                store: createContainerMagicLinkStore(database),
                signingKey: config.magicLinkSigningKey,
              }),
              sessions: createPortalSessionService(
                createContainerContactSessionStore(database),
              ),
              sessionStore: createContainerContactSessionStore(database),
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
          database.close()
        }
      },
    }
  } catch (error) {
    await outboxScheduler?.close().catch(() => undefined)
    await queue?.close().catch(() => undefined)
    if (database.open) database.close()
    throw error
  }
}
