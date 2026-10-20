import type { ReminderProcessOptions, ReminderProcessSummary } from '@ezacto/db/d1'
import { appleWebConfiguration } from './apple-web.js'
import { aggregateAppleCleanup, type AppleCleanupPort, type AppleLifecycleStore, type AppleWebCleanupPort } from '@ezacto/core'
import type { AccountDeletionStore, AccountClosureStore, AccountRetentionReviewStore, AccountDeletionStatusStore } from '@ezacto/core'
import type { PaymentRunsService, ScheduledRunsService } from '@ezacto/core'
import { workItemProviders, type WorkItemProviderId } from '@ezacto/core'
import { installPaymentRunRoutes } from '@ezacto/api'
import { installScheduledRunRoutes } from '@ezacto/api'
import { installStaffPaymentRoutes } from '@ezacto/api'
import type { StaffPaymentStore } from '@ezacto/core'
import { installMyPaymentRoutes } from '@ezacto/api'
import type { MyPaymentsStore } from '@ezacto/core'
import { captureException } from "@sentry/cloudflare";
import type { BillRuntime, DeelSyncRuntime, QuickBooksService, WiseRuntime } from "@ezacto/integrations";
import type {
  InvoiceDocumentPreferenceService,
  InvoiceDocumentPort,
  InvoiceSendingPort,
  InvoiceSendingService,
  InvoiceHoursReportService,
  InvoiceHoursReconciliationService,
  ThankYouPreferenceService,
  ReminderSettingsService,
  NotificationSettingsService,
  TimesheetAutoApprovalService,
  ProfileNotificationsPort,
  InvoiceDefaultsService,
  InvoiceViewRouteService,
  RecurringRepairService,
  InvoiceTimeClaimService,
  StripeService,
} from "@ezacto/api";
import type { PayoutAccountService } from "@ezacto/api";
import type { IdempotencyStore } from "@ezacto/api";
import {
  notFoundResponse,
  createApiApp,
  ApiError,
  assertValidCloudflareAccessConfig,
  assertValidGitHubProviderConfig,
  assertValidOidcProviderConfig,
  brandAssetPath,
  generateOpenApiDocument,
  installAttachmentRoutes,
  installBrandAssetRoutes,
  installBrandRoute,
  installInstanceThemeRoutes,
  installInstanceThemeStylesheetRoute,
  installClientTreeRoutes,
  installClientRateCardRoutes,
  type ClientRateCardRepository,
  installEmailHealthRoutes,
  installEmailLogRoutes,
  installEmailConfigurationRoutes,
  installGeneralResourceRoutes,
  installHarvestV2Routes,
  type HarvestTimeEntrySource,
  installMagicLinkRoutes,
  installModuleSettingsRoutes,
  installAppleRoutes,
  installAppleLifecycleRoutes,

  installAppleWebRoutes,
  type AppleWebLifecyclePort,
  installSignInMethodRoutes,
  installAccountRetentionRoutes,
  type AccountRetentionService,
  createSignInMethodPolicy,
  installGitHubRoutes,
  installMoneyResourceRoutes,
  installOidcRoutes,
  installStaffMagicLinkRoutes,
  installTwoFactorChallengeRoutes,
  installOutboxRoutes,
  installPasswordAuthRoutes,
  installPublicBrandAssetRoutes,
  installReportRoutes,
  installProfileRoutes,
  installAccountClosureRoutes,
  installAccountRetentionReviewRoutes,
  installAccountDeletionStatusRoutes,
  installSessionRoutes,
  installSsoDomainRoutes,
  installAllocationRoutes,
  installCalendarProposalRoutes,
  installWorkItemRoutes,
  installTrackedResourceRoutes,
  installTimesheetApprovalRoutes,
  installBackupStatusRoutes,
  installBackupDownloadMintRoute,
  installBackupDownloadRedeemRoute,
  installBillRoutes,
  installPayoutAccountRoutes,
  installInvoiceDocumentPreferenceRoutes,
  installInvoiceSendingRoutes,
  installInvoiceHoursReportRoutes,
  installInvoiceHoursReconciliationRoutes,
  installThankYouPreferenceRoutes,
  installReminderSettingsRoutes,
  installNotificationSettingsRoutes,
  installTimesheetAutoApprovalRoutes,
  installProfileNotificationRoutes,
  installInvoiceDefaultsRoutes,
  installInvoiceViewRoutes,
  installRecurringRepairRoutes,
  installInvoiceTimeClaimRoutes,
  installStripeRoutes,
  installStripeWebhookRoute,
  installMailgunWebhookRoute,
  installQuickBooksRoutes,
  installQuickBooksWebhookRoute,
  installWiseRoutes,
  installWiseWebhookRoute,
  installTimesheetLockPolicyRoutes,
  installTeamRoutes,
  installUserEmailRoutes,
  readJsonBody,
  SESSION_COOKIE_NAME,
  validationError,
  type ApiTokenService,
  type ApiSessionResolver,
  type AttachmentRouteOptions,
  type AuthMailer,
  type BrandAssetSurface,
  type InstanceThemeSurface,
  type ClientTreeReader,
  type CloudflareAccessVerifierConfig,
  type ApiSessionService,
  type GeneralResourceRouteOptions,
  type ModuleSettingsService,
  type SignInMethod,
  type SignInMethodService,
  type SignInMethodState,
  type EmailConfigurationRouteOptions,
  type MagicLinkRouteOptions,
  type ActivityRecorder,
  type ActivityRollPort,
  type TwoFactorEmailCodeMailer,
  type TwoFactorService,
  type AppleProviderConfig,
  type GitHubProviderConfig,
  type MoneyResourceRouteOptions,
  type OidcIdentityResolver,
  type OidcProviderConfig,
  type OidcTransactionStorePort,
  type OidcAppCodeStorePort,
  type StaffMagicLinkMailer,
  type AccountDeletionMailer,
  type BandClaimBackfillPort,
  type CostRateBackfillPort,
  type StaffMagicLinkStorePort,
  type StaffUserDirectory,
  type PasswordAuthService,
  type BackupStatusReader,
  type BackupDownloadService,
  type ReportReader,
  type SsoProvisioningDomainService,
  type UserEmailService,
  type AllocationRepository,
  type CalendarProposalRepository,
  type WorkItemRepository,
  type TrackedResourceRepository,
  type ProfileRepositoryPort,
  type TimesheetApprovalService,
  type TimesheetLockPolicyService,
  type TeamRouteOptions,
  type UserPrincipal,
  invoicePaymentUrlForSend,
} from '@ezacto/api'
import {
  demoAccounts,
  InstanceBootstrapConflictError,
  InstanceOwnerPasswordConflictError,
  type InstanceBootstrapInput,
  type InstanceBootstrapResult,
  type InstanceOwnerPasswordInput,
  type InstanceOwnerPasswordResult,
  type OutboxService,
  type RecurringInvoiceEngine,
} from '@ezacto/db/d1'
import {
  brandFromSources,
  instancePaletteContract,
  invoiceNumberIsAddressable,
  invoiceTabs,
  readDisplayPreferences,
  renderAppShell,
  renderAppleDisconnect,
  renderPortalEstimatesPage,
  renderPortalInvoicePage,
  type PortalInvoicePage,
  reportKindTabs,
  resolveDeploymentBrand,
  webAssets,
  type DemoSignInAccount,
  type SignInProvider,
} from '@ezacto/web'
import type {
  EmailLogPager,
  EmailLogStore,
  MailgunFeedbackService,
  QueuedEmailJob,
  SenderBoundQueuedMailer,
} from '@ezacto/mailer'
import { demoRefusal, demoRefuses } from './demo-lockdown.js'

/** Worker bindings stay entry-owned; the shared API package is runtime-agnostic. */
export type Env = {
  ENVIRONMENT: string
  RELEASE: string
}

export type AppEnv = Env & {
  APP_BASE_URL?: string
  OIDC_REDIRECT_ORIGIN?: string
  OIDC_GOOGLE_CLIENT_ID?: string
  OIDC_GOOGLE_CLIENT_SECRET?: string
  GITHUB_CLIENT_ID?: string
  GITHUB_CLIENT_SECRET?: string
  /**
   * Native Sign in with Apple. The expected `aud` of the identity token the
   * mobile app posts -- the iOS bundle identifier, and optionally a web
   * Services ID beside it (whitespace or comma separated). Absent means the
   * `/auth/apple` route is configured off and answers 404.
   */
  APPLE_CLIENT_ID?: string
  APPLE_WEB_ENABLED?: string
  APPLE_WEB_SERVICES_ID?: string
  APPLE_WEB_CAPABILITY_KEYS?: string
  APPLE_WEB_ACTIVE_KEY_ID?: string
  APPLE_WEB_ROUTING_SECRET?: string
  EZACTO_BOOTSTRAP_TOKEN?: string
  BRAND_NAME?: string
  BRAND_TAGLINE?: string
  BRAND_DESCRIPTION?: string
  BRAND_FAVICON?: string
  BRAND_WORDMARK_LIGHT?: string
  BRAND_WORDMARK_DARK?: string
  BRAND_EMAIL_SENDER_NAME?: string
  /**
   * The GitHub credential for work-item links (issue 1008). A deployment secret
   * named here and not by any request; connecting GitHub is refused without it.
   */
  GITHUB_WORK_ITEMS_CREDENTIAL?: string
  /**
   * Publishes sign-in credentials on the front page and lets the nightly cron
   * wipe the database. Both are refused outside a non-production environment
   * whatever this says -- see `demoDeployment`.
   */
  DEMO_MODE?: string
  /**
   * The recipient domains the public demo may email, comma-separated (#931).
   * A deploy-time variable from the deployment's own environment, never in the
   * repository, and read only where `demoDeployment` holds -- see
   * `demoMailDomains`.
   */
  DEMO_MAIL_ALLOWED_DOMAINS?: string
}

export type WorkerEnv = AppEnv & {
  DB: D1Database
  /** Sentry DSN. Absent means error reporting is off (a no-op wrapper). */
  SENTRY_DSN?: string
  /** Content-addressed attachment objects. Metadata remains in DB. */
  ATTACHMENTS?: R2Bucket
  API_CURSOR_SIGNING_KEY: string
  /**
   * How many seconds a session's last-seen time, or an API token's last-used
   * time, may age before a signed-in request writes it again (#951). Unset is
   * 300; 0 writes on every request; at most 3600. Inside the interval an
   * authenticated read is a read, which is what keeps page views off the
   * database's write path.
   */
  LAST_SEEN_INTERVAL_SECONDS?: string
  /**
   * Portal magic-link signing key. Absent means portal auth is off: the routes
   * hand out sessions, so an install with no key must not serve them rather
   * than serve them with a weak one.
   */
  MAGIC_LINK_SIGNING_KEY?: string
  /**
   * Contact sign-in for the in-app portal, separate from the staff key above.
   * Absent everywhere by default: `clients.conflict.media` runs its own portal
   * worker with its own tokens and mailer, so nothing needs these routes today.
   * Kept switchable because central portal auth here is a direction worth
   * leaving open -- see PORTAL_ROUTES for what setting it does and does not do.
   */
  PORTAL_MAGIC_LINK_SIGNING_KEY?: string
  /** Bound together with a provider implementation; absent deployments fail auth email closed. */
  EMAIL_QUEUE?: Queue<QueuedEmailJob>
  /** Optional Cloudflare Access provider; both values are required together. */
  ACCESS_TEAM_DOMAIN?: string
  ACCESS_POLICY_AUD?: string
  /**
   * Intuit credentials. Both are Worker secrets; without them the QuickBooks
   * routes are not mounted at all.
   */
  QUICKBOOKS_CLIENT_ID?: string
  QUICKBOOKS_CLIENT_SECRET?: string
  /** From the webhooks page in the Intuit portal; without it no delivery is accepted. */
  QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN?: string
  /** `sandbox` reaches Intuit's test companies; anything else is live books. */
  QUICKBOOKS_ENVIRONMENT?: string
  /**
   * The organisation's own Wise API token. Without it the Wise routes are not
   * mounted, because a screen that cannot list a single destination is worse
   * than no screen.
   *
   * This is not an OAuth pair: the token authenticates as the business that
   * sends the money, and a contractor supplies a destination rather than a
   * grant.
   */
  WISE_TOKEN?: string
  /** Which profile pays, where the token reaches more than one. */
  WISE_PROFILE_ID?: string
  /**
   * The PEM Wise signs webhook deliveries with. Without it the webhook route is
   * not mounted at all: an unverifiable claim about money is not one to act on.
   */
  WISE_WEBHOOK_PUBLIC_KEY?: string
  /**
   * BILL credentials. All Worker secrets, and all four are needed before
   * anything can be sent: BILL has no OAuth, so there is no connect flow that
   * could obtain them and nothing for this system to rotate.
   *
   * `BILL_USERNAME` and `BILL_PASSWORD` take either an operator's BILL login or
   * the NAME and VALUE of an AP/AR sync token -- BILL reads both from the same
   * two fields. The sync token is the safer of the two and cannot have BILL
   * send the invoice email, which is what `BILL_REPLY_TO_USER_ID` selects: set
   * it and BILL emails the client, leave it and ezacto emails them with a BILL
   * payment link instead.
   */
  BILL_DEV_KEY?: string
  BILL_COMPANY_ID?: string
  BILL_USERNAME?: string
  BILL_PASSWORD?: string
  BILL_REPLY_TO_USER_ID?: string
  /** `sandbox` reaches BILL's test organisation; anything else is the real book. */
  BILL_ENVIRONMENT?: string
  /**
   * Stripe. The API key mints payment links; the signing secret is the whole
   * authorisation on the webhook, so without it every delivery is refused.
   * Both are Worker secrets.
   */
  STRIPE_API_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
  /**
   * Deel time sync (issue 103). Both are needed before anything is sent: the
   * API token, and the first day (ISO) whose approved time may be submitted.
   * The start date is the guard against a first run submitting every earlier
   * month that was paid by other means. Neither is wired through the stock
   * deploy workflow; set them as Worker secrets.
   */
  DEEL_TOKEN?: string
  DEEL_SYNC_START_DATE?: string
  /** SES credentials are Worker secrets; never place them in wrangler vars. */
  AWS_ACCESS_KEY_ID?: string
  AWS_SECRET_ACCESS_KEY?: string
  AWS_SESSION_TOKEN?: string
  /** Static SES routing/configuration values. */
  SES_REGION?: string
  SES_FROM?: string
  SES_CONFIGURATION_SET?: string
  MAILGUN_API_KEY?: string
  MAILGUN_DOMAIN?: string
  MAILGUN_REGION?: 'us' | 'eu'
  /**
   * Mailgun's HTTP webhook signing key (not the API key). Without it the
   * /webhooks/mailgun route is not mounted, so no unsigned post is accepted.
   */
  MAILGUN_WEBHOOK_SIGNING_KEY?: string
  MAIL_FROM?: string
}

export interface RuntimeServices {
  appleWebLifecycle?: AppleWebLifecyclePort
  bootstrap(input: InstanceBootstrapInput): Promise<InstanceBootstrapResult>
  enrollOwnerPassword(
    input: InstanceOwnerPasswordInput,
  ): Promise<InstanceOwnerPasswordResult>
  tokens: ApiTokenService
  generalResources: GeneralResourceRouteOptions['repository']
  /** Rooted reads of the client closure, behind the documented tree routes. */
  clientTree: ClientTreeReader
  team: TeamRouteOptions['repository']
  trackedResources: TrackedResourceRepository & HarvestTimeEntrySource
  /** Calendar events offered as time, accepted through `trackedResources` (issue 428). */
  calendarProposals: CalendarProposalRepository
  /** Planned hours per week and the capacity view (issue 1007). */
  allocations: AllocationRepository
  /** Issue tracker connections and the links to their items (issue 1008). */
  workItems: {
    repository: WorkItemRepository
    credentialConfigured(provider: WorkItemProviderId): boolean
  }
  profile: ProfileRepositoryPort
  isExpensesModuleEnabled(): Promise<boolean>
  moduleSettings: ModuleSettingsService
  /** Which ways in are switched on (issue 761). */
  accountDeletionRequests?: AccountDeletionStore
  accountClosure?: AccountClosureStore
  accountRetentionReview?: AccountRetentionReviewStore
  nativeAppleLifecycle?: AppleLifecycleStore
  appleWebCleanup?: AppleWebCleanupPort
  accountDeletionTracking?: AccountDeletionStatusStore
  accountRetention?: AccountRetentionService
  signInMethods: SignInMethodService
  /** The domains SSO may provision a user for, and their DNS challenges (#270). */
  ssoProvisioningDomains: SsoProvisioningDomainService
  /**
   * Adding a second address to an existing user (#269). The password service
   * implements it; the port stays narrow so the route asks for the one thing.
   */
  userEmails: UserEmailService
  isTeamModuleEnabled(): Promise<boolean>
  /** The `activity_log` switch; absent key means on, so evidence is never hidden by an upgrade. */
  isActivityLogModuleEnabled(): Promise<boolean>
  /** The operator roll of a finished activity year (issue 8). */
  activityRoll?: ActivityRollPort
  /**
   * Whether this organization lets a person read their own rates and take-home
   * (#520). Composed into `authentication` rather than a route's options: the
   * rule it feeds is `canViewMoneyField`, which every money serializer already
   * calls, so the answer belongs on the principal.
   */
  isOwnMoneyVisible(): Promise<boolean>
  timesheetApprovals: TimesheetApprovalService
  timesheetLockPolicy: TimesheetLockPolicyService
  moneyResources: MoneyResourceRouteOptions['service']
  invoiceGeneration: NonNullable<MoneyResourceRouteOptions['generation']>
  /**
   * Issues the invoice a recurring definition is due for. The whole engine
   * rather than the route's port, because the daily cron sweeps every due
   * definition through the same object the Generate button uses.
   */
  recurringInvoices: RecurringInvoiceEngine
  bandClaimBackfill: BandClaimBackfillPort
  costRateBackfill: CostRateBackfillPort
  reports: ReportReader
  /** The organisation's name, read fresh: `GET /api/v1/brand` and the mailers. */
  organizationName(): Promise<string>
  cursorSigningKey: Uint8Array
  /**
   * Idempotency keys (issue 952): the store a keyed write is recorded in, and
   * the secret its rows are found and sealed with. The entry wraps every data
   * request in `withIdempotency`; the app itself never sees either.
   */
  idempotency: { readonly store: IdempotencyStore; readonly secret: Uint8Array }
  passwordAuth: PasswordAuthService
  sessions: ApiSessionService
  /** Composite browser resolver when an optional edge identity provider is configured. */
  authenticationSessions?: ApiSessionResolver
  emailLog: EmailLogStore & EmailLogPager
  emailConfiguration: EmailConfigurationRouteOptions['service']
  senderIdentityVerifier?: EmailConfigurationRouteOptions['verifier']
  organizationMailer?: SenderBoundQueuedMailer
  outbox: OutboxService
  identities: OidcIdentityResolver
  oidcTransactions: OidcTransactionStorePort
  /** Present only where the native-app OIDC sign-in handoff is enabled. */
  oidcAppCodes?: OidcAppCodeStorePort
  /**
   * Staff (user) magic-link sign-in. Present only where a code-signing key and
   * a mailer both exist; the app-handoff leg also needs `oidcAppCodes`.
   */
  staffMagicLinks?: {
    users: StaffUserDirectory
    store: StaffMagicLinkStorePort
    /** Absent where magic-link is on but no email transport is configured. */
    mailer?: StaffMagicLinkMailer
    codeKey: Uint8Array
  }
  /** Deployment-brand sender for all authentication mail. */
  deploymentAuthMailer?: AuthMailer
  /** Tells the administrators of an account deletion request; absent without mail. */
  accountDeletionMailer?: AccountDeletionMailer
  attachments?: AttachmentRouteOptions
  /** Portal magic-link authentication for contacts. */
  portalAuth?: MagicLinkRouteOptions
  /** The second factor for signed-in users. Absent only where there is no store. */
  twoFactor?: TwoFactorService
  /** Sends the emailed second-factor code; absent without a mail queue (issue 770). */
  twoFactorEmailCodes?: TwoFactorEmailCodeMailer
  /** Where credential events are recorded. Absent leaves them unrecorded. */
  activity?: ActivityRecorder
  backupStatus?: BackupStatusReader
  /**
   * The signed download of a backup run (issue 39). Composed only where the
   * bundle exists to be read, and mounted only with the activity log: a copy of
   * the database that leaves without a record is the case the log is for.
   */
  backupDownloads?: BackupDownloadService
  /**
   * The QuickBooks connection. Absent where the deployment has no Intuit keys,
   * the same way the attachment routes are absent without object storage:
   * mounting a connect button that cannot connect is worse than not offering
   * one.
   */
  quickBooks?: QuickBooksService
  /**
   * A contractor's own Wise connection. Absent where the deployment has no Wise
   * keys, for the same reason as QuickBooks above.
   */
  wise?: WiseRuntime["service"]
  /**
   * Deliveries Wise pushes. Outside the authenticated surface; see the route.
   *
   * Present as soon as Wise is configured at all, before the signing key is,
   * because the key comes from a webhook page that cannot be finished without
   * an endpoint answering. Unverifiable deliveries are still refused.
   */
  wiseWebhook?: NonNullable<WiseRuntime["webhook"]>
  stripe?: StripeService
  /** Mailgun's bounce, complaint and delivery events; see the route. */
  mailgunFeedback?: MailgunFeedbackService
  invoiceTimeClaims?: InvoiceTimeClaimService
  invoiceDocumentPreference?: InvoiceDocumentPreferenceService
  /** The client's sending profile, the organization's copies, the dialog's defaults. */
  invoiceSending?: InvoiceSendingService
  /** Who an invoice email copies besides the people the sender typed. */
  invoiceEmailSending?: InvoiceSendingPort
  /** The invoice document composer, where the deployment keeps files. */
  invoiceDocuments?: InvoiceDocumentPort
  /** The work journal as a file on demand (issue 647); both entries compose it. */
  invoiceHoursReport?: InvoiceHoursReportService
  /** Billed hours against the entries an invoice claims (issue 924). */
  invoiceHoursReconciliation?: InvoiceHoursReconciliationService
  thankYouPreference?: ThankYouPreferenceService
  /** The organisation's default payment reminder policy (issue 801). */
  reminderSettings?: ReminderSettingsService
  /** Company settings for the mail the instance sends its own people (issue 934). */
  notificationSettings?: NotificationSettingsService
  /** The optional automatic approval of submitted timesheets (issue 1009). */
  timesheetAutoApproval?: TimesheetAutoApprovalService
  /**
   * Approves the submitted weeks the policy above has made due, a bounded batch
   * at a time. Called from the minute cron in the Worker and the outbox tick in
   * the container; a no-op while the policy is off.
   */
  timesheetAutoApprovalSweep?: {
    processDue(now: string): Promise<{
      readonly approved: readonly number[]
      readonly failed: readonly { readonly submissionId: number; readonly message: string }[]
    }>
  }
  invoiceDefaults?: InvoiceDefaultsService
  /**
   * The hosted invoice page and its receipts (issue 936). Both entries compose
   * it, so `entry-surface.ts` lists its three routes for both.
   */
  invoiceView?: InvoiceViewRouteService<PortalInvoicePage>
  /** Mints the link an invoice email carries, where the deployment has an origin to link to. */
  invoiceViewLinks?: NonNullable<MoneyResourceRouteOptions['invoiceViewLinks']>
  /** When invoice emails were first opened, for Settings > Deliveries. */
  invoiceViewReceipts?: (
    invoiceMessageIds: readonly number[],
  ) => Promise<ReadonlyMap<number, string>>
  /**
   * Sends the reminders that have come due. Called from the daily cron in the
   * Worker and from the outbox tick in the container; either way it is the
   * only thing that turns a scheduled row into mail.
   */
  reminders?: {
    processDue(now: string, options?: ReminderProcessOptions): Promise<ReminderProcessSummary>
  }
  /**
   * Looks for projects that have crossed the budget threshold they asked to be
   * told about (issue 934). Called from the minute cron in the Worker and from
   * the outbox tick in the container; the event it writes is what the mail
   * subscriber and the activity log are driven by.
   */
  budgetAlerts?: {
    evaluate(now: string): Promise<{ readonly opened: readonly unknown[]; readonly closed: number }>
  }
  /**
   * Time reminders and week-end submission reminders (issue 935). Called from
   * the minute cron in the Worker and from the outbox tick in the container.
   * Absent where the deployment has no mail to send them with.
   */
  timeReminders?: {
    processDue(now: string): Promise<{ readonly queued: number }>
  }
  /** A person's own reminder and digest preferences, edited under Settings. */
  profileNotifications?: ProfileNotificationsPort
  recurringRepair?: RecurringRepairService
  bill?: BillRuntime
  /** Deel time sync, run from the daily cron. Absent on the demo. */
  deelSync?: DeelSyncRuntime
  /**
   * The per-client opt-in. Separate from the runtime because turning it on is a
   * database write with no BILL call in it -- the runtime is the thing that
   * talks to BILL, and a setting an operator changes should not need it.
   */
  /** Administrator payment register, available without provider credentials. */
  paymentRuns?: PaymentRunsService
  scheduledRuns?: ScheduledRunsService
  staffPayments?: StaffPaymentStore
  /** A person's own payment summary (issue 100). */
  myPayments?: MyPaymentsStore
  /** Linking a person to their payout provider account (#421). */
  payoutAccounts?: PayoutAccountService
  billDelivery?: {
    isOptedIn(clientId: number): Promise<boolean>
    setOptedIn(clientId: number, enabled: boolean): Promise<boolean>
  }
  /** Named rate cards on client nodes, inherited down the tree (issue 34). */
  clientRateCards?: ClientRateCardRepository
}

export type Health = {
  status: 'ok'
  service: 'ezacto'
  environment: string
  release: string
}

const hasSessionCookie = (request: Request): boolean =>
  (request.headers.get('cookie') ?? '')
    .split(';')
    .map((part) => part.trim())
    .some((part) => {
      const separator = part.indexOf('=')
      return (
        separator > 0 &&
        part.slice(0, separator) === SESSION_COOKIE_NAME &&
        part.slice(separator + 1) !== ''
      )
    })

/**
 * The brand marks this instance holds, resolved for a shell render.
 *
 * A stored mark beats the deploy-time URL for its slot and the env vars stay
 * the fallback, so a deployment that already sets them renders what it rendered
 * before -- see `brandFromSources`.
 *
 * The read is on the page path, which does no other database work: the Worker
 * deliberately serves the shell from an app with no runtime services so that a
 * page render is never behind a migration. That is why the surface is threaded
 * with the request environment rather than composed into `RuntimeServices`, and
 * why its `list` answers with nothing rather than throwing when the table is
 * not there yet -- a brand lookup must never be the reason a page fails to
 * render. Caching it per isolate was considered and left out: it buys a
 * fraction of a millisecond and pays for it with an operator watching a stale
 * logo and wondering whether the upload worked.
 */
export const createApp = (
  services?: RuntimeServices,
  brandAssets?: BrandAssetSurface<AppEnv>,
  instanceTheme?: InstanceThemeSurface<AppEnv>,
  /**
   * How the shell learns which ways in are switched on when there are no
   * services -- which is every HTML page load, since those are not data
   * requests. Without it the card would keep offering a method the routes now
   * refuse (issue 761).
   */
  signInMethods?: { read(env: AppEnv): Promise<readonly SignInMethodState[] | null> },
) => {
  const cleanupPorts = ([services?.nativeAppleLifecycle, services?.appleWebCleanup] as (AppleCleanupPort | undefined)[]).filter((port): port is AppleCleanupPort => port !== undefined)
  const appleCleanup: AppleCleanupPort | undefined = cleanupPorts.length === 0 ? undefined : {
    async begin(userId,requestId) { for(const port of cleanupPorts) await port.begin(userId,requestId) },
    async status(requestId) { return aggregateAppleCleanup(await Promise.all(cleanupPorts.map(port=>port.status(requestId)))) },
  }
  const shellBrand = async (env: AppEnv) => {
    const stored = brandAssets === undefined ? [] : await brandAssets.list(env)
    return brandFromSources(
      env as unknown as Record<string, string | undefined>,
      stored.map((asset) => ({
        slot: asset.slot,
        url: brandAssetPath(asset.slot, asset.contentHash),
      })),
    )
  }
  /**
   * What the standalone portal pages take of the instance brand (issue 1011):
   * the light-ground mark, the favicon and whether a palette is linked.
   */
  const portalChrome = async (env: AppEnv) => {
    const [brand, themed] = await Promise.all([
      shellBrand(env),
      instanceTheme === undefined ? Promise.resolve(null) : instanceTheme.read(env),
    ])
    const resolved = resolveDeploymentBrand(brand)
    return {
      ...(resolved.wordmarkLight === undefined ? {} : { wordmarkLight: resolved.wordmarkLight }),
      ...(resolved.favicon === undefined ? {} : { favicon: resolved.favicon }),
      instanceTheme: themed !== null,
    }
  }
  /**
   * Everything a shell render needs from storage, read once and in parallel.
   *
   * Two lookups, and the page path is the one place in this app that must not
   * grow a serial database round trip per feature: the marks and the palette
   * are independent, so they are asked for together. `instanceTheme` is the
   * fact and not the colours -- the shell cannot carry those inline under its
   * own `style-src`, so it links a stylesheet, and it only links one where
   * there is a palette to serve.
   */
  /**
   * Everything every shell page needs, resolved in one place -- including which
   * ways in the sign-in card may offer (issue 761). Folding the sign-in surface
   * in here rather than leaving each page to call `configuredSignInProviders`
   * is what keeps twenty-six render sites from drifting apart on the question
   * of whether a method is live.
   *
   * And the person's display preferences, from their cookies: the scheme the
   * page is painted in has to be in the first byte, or a dark page flashes
   * white on every load. Every shell response is `no-store`, so a page that
   * varies by cookie is never served to anyone else.
   */
  const shellChrome = async (env: AppEnv, request: Request) => {
    const [brand, themed, enabled] = await Promise.all([
      shellBrand(env),
      instanceTheme === undefined
        ? Promise.resolve(null)
        : instanceTheme.read(env),
      services === undefined
        ? (signInMethods?.read(env) ?? Promise.resolve(null))
        : services.signInMethods.list(),
    ])
    const live = (method: SignInMethod): boolean =>
      enabled === null ||
      (enabled.find((state) => state.method === method)?.enabled ?? true)
    return {
      ...readDisplayPreferences(request.headers.get('cookie')),
      brand,
      instanceTheme: themed !== null,
      signInProviders: configuredSignInProviders(env).filter((provider) =>
        live(provider) && (provider !== 'apple' || services === undefined || services.appleWebLifecycle !== undefined),
      ),
      // The form is markup, and hiding markup is not a control -- the routes
      // refuse independently. This only stops the page offering a way in that
      // would be turned away.
      passwordSignIn: live('password'),
      // So the controls the demo refuses say so before they are clicked
      // (#931). The same caveat: `demo-lockdown.ts` is what refuses them.
      demo: demoDeployment(env),
      // And whether its mail is held to an allowlist, so the Send dialog can
      // say so. Never the list itself: anyone can open the demo, and a page
      // that named the approved domains would say where it can send.
      demoMailRestricted: demoMailDomains(env) !== null,
    }
  }

  return createApiApp<AppEnv>({
    // Every 5xx the API answers goes to Sentry with the request id the client
    // was handed (issue 807). A no-op until SENTRY_DSN is set, like the wrapper
    // in index.ts, and never given a request or response body.
    reportError: (error, requestId) => {
      captureException(error, { tags: { request_id: requestId } })
    },
    ...(services === undefined
      ? {}
      : {
          authentication: {
            tokens: services.tokens,
            sessions: services.authenticationSessions ?? services.sessions,
            ...(services.twoFactor === undefined
              ? {}
              : {
                  twoFactor: services.twoFactor,
                  twoFactorEmailCodes: services.twoFactorEmailCodes !== undefined,
                }),
            ...(services.activity === undefined
              ? {}
              : { activity: services.activity }),
            ownMoneyVisible: services.isOwnMoneyVisible,
          },
          installApi: (api) => {
            installSessionRoutes(api, services.sessions)
            installProfileRoutes(api, {
              repository: services.profile,
              ...(appleCleanup === undefined ? {} : { appleCleanup }),
              ...(services.accountDeletionTracking === undefined ? {} : { deletionTracking: services.accountDeletionTracking }),
              ...(services.accountDeletionRequests === undefined ? {} : { deletionStore: services.accountDeletionRequests }),
              clock: () => systemClock.now().instant,
              ...(services.accountDeletionMailer === undefined
                ? {}
                : { deletionMailer: services.accountDeletionMailer }),
            })
            if(services.accountRetentionReview) installAccountRetentionReviewRoutes(api,{store:services.accountRetentionReview,clock:()=>systemClock.now().instant,...(appleCleanup===undefined?{}:{appleCleanup})})
            if (services.accountClosure) installAccountClosureRoutes(api, { store: services.accountClosure, clock: () => systemClock.now().instant, ...(appleCleanup === undefined ? {} : { appleCleanup }), ...(services.appleWebCleanup === undefined ? {} : {performAppleCleanup:(requestId:string)=>services.appleWebCleanup!.perform(requestId)}) })
            // The organization's timezone decides where a calendar day begins,
            // for the logs a day range narrows.
            const organizationTimezone = async (): Promise<string> =>
              (await services.timesheetLockPolicy.settings()).timezone
            installEmailLogRoutes(api, services.emailLog, {
              cursorSigningKey: services.cursorSigningKey,
              timezone: organizationTimezone,
              ...(services.invoiceViewReceipts === undefined
                ? {}
                : { viewReceipts: services.invoiceViewReceipts }),
            })
            installEmailHealthRoutes(api, services.emailLog)
            installEmailConfigurationRoutes(api, {
              service: services.emailConfiguration,
              ...(services.senderIdentityVerifier === undefined
                ? {}
                : { verifier: services.senderIdentityVerifier }),
              ...(services.organizationMailer === undefined
                ? {}
                : { organizationMailer: services.organizationMailer }),
              clock: () => systemClock.now().instant,
            })
            installOutboxRoutes(api, services.outbox, {
              isActivityLogModuleEnabled: services.isActivityLogModuleEnabled,
              ...(services.activityRoll === undefined ? {} : { roll: services.activityRoll }),
              cursorSigningKey: services.cursorSigningKey,
              timezone: organizationTimezone,
            })
            installGeneralResourceRoutes(api, {
              repository: services.generalResources,
              cursorSigningKey: services.cursorSigningKey,
              isExpensesModuleEnabled: services.isExpensesModuleEnabled,
              isTeamModuleEnabled: services.isTeamModuleEnabled,
              teamRepository: services.team,
            })
            installClientTreeRoutes(api, services.clientTree)
            if (services.clientRateCards) installClientRateCardRoutes(api, { repository: services.clientRateCards, clock: systemClock })
            installTeamRoutes(api, {
              repository: services.team,
              costRateBackfill: services.costRateBackfill,
              cursorSigningKey: services.cursorSigningKey,
              isTeamModuleEnabled: services.isTeamModuleEnabled,
            })
            installTrackedResourceRoutes(api, {
              repository: services.trackedResources,
              clock: systemClock,
              cursorSigningKey: services.cursorSigningKey,
              isExpensesModuleEnabled: services.isExpensesModuleEnabled,
            })
            installAllocationRoutes(api, {
              repository: services.allocations,
              clock: systemClock,
              cursorSigningKey: services.cursorSigningKey,
            })
            installCalendarProposalRoutes(api, {
              repository: services.calendarProposals,
              clock: systemClock,
              cursorSigningKey: services.cursorSigningKey,
            })
            installWorkItemRoutes(api, {
              repository: services.workItems.repository,
              credentialConfigured: services.workItems.credentialConfigured,
              clock: () => systemClock.now().instant,
              cursorSigningKey: services.cursorSigningKey,
              ...(services.activity === undefined ? {} : { activity: services.activity }),
            })
            installTimesheetApprovalRoutes(api, {
              service: services.timesheetApprovals,
              cursorSigningKey: services.cursorSigningKey,
              clock: () => systemClock.now().instant,
            })
            installTimesheetLockPolicyRoutes(api, {
              service: services.timesheetLockPolicy,
              cursorSigningKey: services.cursorSigningKey,
              clock: () => systemClock.now().instant,
            })
            installMoneyResourceRoutes(api, {
              service: services.moneyResources,
              generation: services.invoiceGeneration,
              recurringGeneration: services.recurringInvoices,
              bandClaimBackfill: services.bandClaimBackfill,
              ...(services.organizationMailer === undefined
                ? {}
                : {
                    invoiceDelivery: {
                      configuration: services.emailConfiguration,
                      mailer: services.organizationMailer,
                      ...(services.invoiceDocuments === undefined
                        ? {}
                        : { documents: services.invoiceDocuments }),
                      ...(services.invoiceEmailSending === undefined
                        ? {}
                        : { sending: services.invoiceEmailSending }),
                    },
                  }),
              // The pay link the invoice email carries. Resolved here rather
              // than inside the money routes so those keep knowing nothing
              // about a payment provider; a deployment with neither BILL nor
              // Stripe passes nothing and the email renders as it always did.
              ...(services.invoiceViewLinks === undefined
                ? {}
                : { invoiceViewLinks: services.invoiceViewLinks }),
              ...(services.stripe === undefined && services.bill === undefined
                ? {}
                : {
                    invoicePaymentUrl: invoicePaymentUrlForSend({
                      ...(services.bill === undefined ? {} : { bill: services.bill }),
                      ...(services.stripe === undefined ? {} : { stripe: services.stripe }),
                    }),
                  }),
              cursorSigningKey: services.cursorSigningKey,
              clock: () => systemClock.now().instant,
            })
            installAttachmentRoutes(api, services.attachments)
            installReportRoutes(api, services.reports)
            if (services.paymentRuns !== undefined) installPaymentRunRoutes(api, services.paymentRuns)
            if (services.scheduledRuns !== undefined) installScheduledRunRoutes(api, services.scheduledRuns)
            if (services.staffPayments !== undefined) {
              installStaffPaymentRoutes(api, services.staffPayments)
            }
            if (services.myPayments !== undefined) installMyPaymentRoutes(api, services.myPayments)
            if (services.backupStatus !== undefined) {
              installBackupStatusRoutes(api, services.backupStatus, {
                cursorSigningKey: services.cursorSigningKey,
              })
            }
            if (services.backupDownloads !== undefined && services.activity !== undefined) {
              installBackupDownloadMintRoute(api, {
                service: services.backupDownloads,
                activity: services.activity,
                clock: () => systemClock.now().instant,
              })
            }
            if (services.quickBooks !== undefined) {
              installQuickBooksRoutes(api, services.quickBooks)
            }
            if (services.wise !== undefined) {
              installWiseRoutes(api, services.wise)
            }
            // Mounted whether or not BILL is reachable: there is nothing to
            // connect, so the honest answer to "is this configured?" is a
            // route that says so rather than a route that is missing.
            if (services.stripe !== undefined) {
              installStripeRoutes(api, services.stripe)
            }
            if (services.invoiceTimeClaims !== undefined) {
              installInvoiceTimeClaimRoutes(api, services.invoiceTimeClaims)
            }
            if (services.invoiceSending !== undefined) {
              installInvoiceSendingRoutes(api, {
                service: services.invoiceSending,
                clock: () => systemClock.now().instant,
                // The same mailer and senders the send itself is given above,
                // so the dialog's "can this email leave" is the send's answer.
                ...(services.organizationMailer === undefined
                  ? {}
                  : {
                      delivery: {
                        configuration: services.emailConfiguration,
                        mailer: services.organizationMailer,
                      },
                    }),
              })
            }
            if (services.invoiceDocumentPreference !== undefined) {
              installInvoiceDocumentPreferenceRoutes(
                api,
                services.invoiceDocumentPreference,
              )
            }
            if (services.invoiceHoursReport !== undefined) {
              installInvoiceHoursReportRoutes(api, services.invoiceHoursReport)
            }
            if (services.invoiceHoursReconciliation !== undefined) {
              installInvoiceHoursReconciliationRoutes(
                api,
                services.invoiceHoursReconciliation,
              )
            }
            if (services.recurringRepair !== undefined) {
              installRecurringRepairRoutes(api, services.recurringRepair, () =>
                new Date().toISOString(),
              )
            }
            if (services.thankYouPreference !== undefined) {
              installThankYouPreferenceRoutes(api, services.thankYouPreference)
            }
            if (services.reminderSettings !== undefined) {
              installReminderSettingsRoutes(api, services.reminderSettings)
            }
            if (services.notificationSettings !== undefined) {
              installNotificationSettingsRoutes(api, services.notificationSettings)
            }
            if (services.timesheetAutoApproval !== undefined) {
              installTimesheetAutoApprovalRoutes(api, {
                service: services.timesheetAutoApproval,
                clock: () => systemClock.now().instant,
                ...(services.activity === undefined ? {} : { activity: services.activity }),
              })
            }
            if (services.profileNotifications !== undefined) {
              installProfileNotificationRoutes(api, services.profileNotifications)
            }
            if (services.invoiceDefaults !== undefined) {
              installInvoiceDefaultsRoutes(api, services.invoiceDefaults)
            }
            if (services.payoutAccounts !== undefined) {
              installPayoutAccountRoutes(api, services.payoutAccounts)
            }
            if (services.bill !== undefined && services.billDelivery !== undefined) {
              const billRuntime = services.bill
              const billDelivery = services.billDelivery
              installBillRoutes(api, {
                status: () => billRuntime.status(),
                isOptedIn: (id) => billDelivery.isOptedIn(id),
                setOptedIn: (id, enabled) => billDelivery.setOptedIn(id, enabled),
              })
            }
            installModuleSettingsRoutes(api, {
              service: services.moduleSettings,
              clock: () => systemClock.now().instant,
            })
            if (services.accountRetention !== undefined) {
              installAccountRetentionRoutes(api, {
                service: services.accountRetention,
                clock: () => systemClock.now().instant,
              })
            }
            installSignInMethodRoutes(api, {
              service: services.signInMethods,
              configured: (bindings) => deployedSignInMethods(bindings as WorkerEnv),
              clock: () => systemClock.now().instant,
            })
            // Mounted only where the entry composes a brand surface, the way
            // the attachment routes are mounted only where object storage is
            // bound: without one there is nowhere for a mark to go.
            if (brandAssets !== undefined) {
              installBrandAssetRoutes(api, brandAssets, () => systemClock.now().instant)
            }
            // Mounted only where the entry composes a theme surface, the same
            // way the brand routes are: without one there is nowhere for a
            // palette to go.
            if (instanceTheme !== undefined) {
              installInstanceThemeRoutes(api, {
                surface: instanceTheme,
                contract: instancePaletteContract,
                clock: () => systemClock.now().instant,
              })
            }
            installBrandRoute(api, {
              organizationName: services.organizationName,
              assets: (env) => (brandAssets === undefined ? Promise.resolve([]) : brandAssets.list(env)),
              ...(instanceTheme === undefined
                ? {}
                : {
                    palette: async (env) =>
                      (await instanceTheme.read(env))?.palette ?? {},
                  }),
            })
            // The provisioning gate is enforced inside the identity store, so
            // this is the only way an instance gets from "provisions nothing"
            // to "provisions from the work domain". Unmounted, migration 0039
            // would leave every deployment closed with no way back open.
            installSsoDomainRoutes(api, {
              service: services.ssoProvisioningDomains,
              clock: () => systemClock.now().instant,
            })
            // The mailer is optional the same way the password routes' is: a
            // deployment without email answers 503 rather than not answering.
            installUserEmailRoutes(api, {
              service: services.userEmails,
              ...(services.deploymentAuthMailer === undefined
                ? {}
                : { deploymentMailer: services.deploymentAuthMailer }),
              clientKey: (request) =>
                request.headers.get('cf-connecting-ip') ?? 'unknown-client',
            })
          },
          installHarvestV2: (harvest) =>
            installHarvestV2Routes(harvest, {
              repository: services.generalResources,
              timeEntries: services.trackedResources,
              isTeamModuleEnabled: services.isTeamModuleEnabled,
              clock: () => systemClock.now().instant,
            }),
        }),
    installApp(app) {
      // What the public demo refuses (#931): ahead of every route, and after
      // authentication, so a stranger still meets a 401 and a visitor signed
      // into the demo meets the same 403 for every one of them. `/auth` too,
      // for the password reset that would lock the next visitor out. The list
      // and why each entry is on it are in `demo-lockdown.ts`.
      for (const surface of ['/api/v1/*', '/auth/*']) {
        app.use(surface, async (context, next) => {
          // Absent only where a test calls the app without bindings, which is
          // no deployment and so not the demo.
          const env = context.env as AppEnv | undefined
          // Whose session this is, for the one refusal that depends on it.
          // Unset on `/auth`, which is reached before anyone signs in.
          const principal = context.get('principal') as UserPrincipal | undefined
          const actingSession =
            principal?.authentication.kind === 'session'
              ? principal.authentication.sessionId
              : null
          if (
            env !== undefined &&
            demoDeployment(env) &&
            (await demoRefuses(context.req.raw, context.req.path, actingSession))
          ) {
            throw demoRefusal()
          }
          await next()
        })
      }
      // Before anything that needs a session, and outside the API surface: the
      // wordmark on the sign-in page is fetched by a browser that has none.
      if (brandAssets !== undefined) {
        installPublicBrandAssetRoutes(app, brandAssets)
      }
      // Linked from the sign-in page, which is fetched without a session, so it
      // sits outside the API surface for the same reason the marks do.
      if (instanceTheme !== undefined) {
        installInstanceThemeStylesheetRoute(app, instanceTheme)
      }
      // Stripe has no session with us, so this sits outside the authenticated
      // surface and the signature is the authorisation.
      if (services?.stripe !== undefined) {
        installStripeWebhookRoute(app, services.stripe)
      }
      // Mailgun has no session with us either, and the signature is the
      // authorisation. Mounted only where the signing key is configured.
      if (services?.mailgunFeedback !== undefined) {
        installMailgunWebhookRoute(app, services.mailgunFeedback)
      }
      // Intuit has no session with us either, and the signature is the
      // authorisation. It lived under /api/v1 until #739, where the
      // authentication middleware refused every delivery before the verifier
      // ran, so the payment sync received nothing.
      if (services?.quickBooks !== undefined) {
        installQuickBooksWebhookRoute(app, services.quickBooks)
      }
      // Wise likewise has no session with us, so the signature is the whole of
      // the authorisation and this sits beside Stripe's rather than under the
      // API surface.
      if (services?.wiseWebhook !== undefined) {
        installWiseWebhookRoute(app, services.wiseWebhook)
      }
      // The page a client reaches from the link in an emailed invoice (issue
      // 936). No session, so the link's token is the whole of the authorisation
      // and these sit outside the API surface, beside the webhooks.
      // The download of a backup behind a link an administrator minted (issue
      // 39). No session either: the token is the whole of the authorisation.
      if (services?.backupDownloads !== undefined && services.activity !== undefined) {
        installBackupDownloadRedeemRoute(app, {
          service: services.backupDownloads,
          activity: services.activity,
          clock: () => systemClock.now().instant,
          clientKey: (request) =>
            request.headers.get('cf-connecting-ip') ?? 'unknown-client',
        })
      }
      if (services?.invoiceView !== undefined) {
        installInvoiceViewRoutes(app, {
          service: services.invoiceView,
          clock: () => systemClock.now().instant,
          clientKey: (request) =>
            request.headers.get('cf-connecting-ip') ?? 'unknown-client',
          render: async (page, token, env) =>
            renderPortalInvoicePage(page, token, await portalChrome(env)),
          pageHeaders: {
            'content-security-policy': shellContentSecurityPolicy,
            'permissions-policy': 'camera=(), microphone=(), geolocation=()',
          },
        })
      }
      if (services !== undefined) {
        // One policy object, consulted by every sign-in family. Composing it
        // here rather than per route is what keeps "configured" and "enabled"
        // from being combined four slightly different ways.
        const signInPolicy = createSignInMethodPolicy({
          service: services.signInMethods,
          configured: (bindings) => deployedSignInMethods(bindings as WorkerEnv),
        })
        installOidcRoutes(app, {
          transactions: services.oidcTransactions,
          identities: services.identities,
          sessions: services.sessions,
          provider: oidcProvider,
          policy: signInPolicy,
          clientKey: (request) =>
            request.headers.get('cf-connecting-ip') ?? 'unknown-client',
          ...(services.oidcAppCodes === undefined
            ? {}
            : { appCodes: services.oidcAppCodes }),
          // The exchange redeems app codes from both federated sign-ins and the
          // staff magic link; only the second kind is a credential this
          // instance verified, so only it is gated.
          ...(services.twoFactor === undefined
            ? {}
            : {
                twoFactor: services.twoFactor,
                localAppCodeProviders: ['magic-link'],
              }),
        })
        installGitHubRoutes(app, {
          transactions: services.oidcTransactions,
          identities: services.identities,
          sessions: services.sessions,
          provider: (env) => githubProvider(env),
          policy: signInPolicy,
          clientKey: (request) =>
            request.headers.get('cf-connecting-ip') ?? 'unknown-client',
        })
        // Native Sign in with Apple. The app posts an Apple-signed identity
        // token and gets the ordinary session back; it reuses the shared
        // identity resolver and session issuer, so it needs no store of its
        // own. Configured off (404) until APPLE_CLIENT_ID names an audience.
        if (services.accountDeletionTracking) installAccountDeletionStatusRoutes(app, { store: services.accountDeletionTracking, clock: () => systemClock.now().instant, ...(appleCleanup === undefined ? {} : { appleCleanup }) })
        const nativeLifecycle=services.nativeAppleLifecycle===undefined?undefined:{store:services.nativeAppleLifecycle,origin:(env:AppEnv)=>env.APP_BASE_URL,clock:()=>systemClock.now().instant}
        if(nativeLifecycle)installAppleLifecycleRoutes(app,nativeLifecycle)
        installAppleRoutes(app, {
          ...(nativeLifecycle === undefined ? {} : { lifecycle: nativeLifecycle }),
          policy: signInPolicy,
          identities: services.identities,
          sessions: services.sessions,
          provider: (env) => appleProvider(env),
        })
        installAppleWebRoutes(app, {
          transactions: services.oidcTransactions,
          identities: services.identities,
          sessions: services.sessions,
          provider: appleWebConfiguration,
          lifecycle: () => services.appleWebLifecycle ?? null,
          policy: signInPolicy,
          clientKey: request => request.headers.get('cf-connecting-ip') ?? 'unknown-client',
          demoAccount: env => demoDeployment(env) ? demoAccounts.find(account => account.label === 'Teammate')!.userId : null,
          renderDisconnect: renderAppleDisconnect,
        })
        installPasswordAuthRoutes(app, {
          service: services.passwordAuth,
          sessions: services.sessions,
          policy: signInPolicy,
          // Issue 732. An operator who set a bootstrap token has said they will
          // claim this instance through it; leaving the open route mounted
          // beside that is a race they did not agree to run.
          firstRunClosed: (bindings) => {
            const token = (bindings as AppEnv).EZACTO_BOOTSTRAP_TOKEN
            return token !== undefined && token !== ''
          },
          ...(services.twoFactor === undefined
            ? {}
            : { twoFactor: services.twoFactor }),
          ...(services.twoFactorEmailCodes === undefined
            ? {}
            : { twoFactorEmailCodes: services.twoFactorEmailCodes }),
          ...(services.deploymentAuthMailer === undefined
            ? {}
            : { deploymentMailer: services.deploymentAuthMailer }),
          clientKey: (request) =>
            request.headers.get('cf-connecting-ip') ?? 'unknown-client',
        })
        // The leg that turns a challenge into a session. It mounts with the
        // factor itself, so there is no configuration in which a sign-in can be
        // challenged and then have nowhere to answer.
        if (services.twoFactor !== undefined) {
          installTwoFactorChallengeRoutes(app, {
            gate: services.twoFactor,
            sessions: services.sessions,
            ...(services.twoFactorEmailCodes === undefined
              ? {}
              : { emailCodes: services.twoFactorEmailCodes }),
          })
        }
        if (services.portalAuth !== undefined) {
          installMagicLinkRoutes(app, services.portalAuth)
          // The page a contact reads an estimate on and answers it (issue 1010).
          // It carries no session of its own: the emailed link's token arrives
          // in the fragment and the page spends it on /portal/verify. Mounted
          // with the routes it calls, so it exists exactly where they do.
          app.get('/portal/estimate-review', async (context) =>
            context.html(
              renderPortalEstimatesPage({
                brand: resolveDeploymentBrand(await shellBrand(context.env)).name,
                chrome: await portalChrome(context.env),
              }),
              200,
              {
                'cache-control': 'no-store',
                'content-security-policy': shellContentSecurityPolicy,
                'permissions-policy': 'camera=(), microphone=(), geolocation=()',
                'referrer-policy': 'no-referrer',
                'x-content-type-options': 'nosniff',
              },
            ),
          )
        }
        // The app-handoff leg mints a single-use OIDC app code, so staff
        // magic-link needs the same store the OIDC sign-in does.
        if (
          services.staffMagicLinks !== undefined &&
          services.oidcAppCodes !== undefined
        ) {
          installStaffMagicLinkRoutes(app, {
            users: services.staffMagicLinks.users,
            magicLinks: services.staffMagicLinks.store,
            sessions: services.sessions,
            appCodes: services.oidcAppCodes,
            policy: signInPolicy,
            ...(services.twoFactor === undefined
              ? {}
              : { twoFactor: services.twoFactor }),
            ...(services.staffMagicLinks.mailer === undefined
              ? {}
              : { mailer: services.staffMagicLinks.mailer }),
            codeKey: services.staffMagicLinks.codeKey,
            linkOrigin: (env) => redirectOrigin(env),
          })
        }
      }

      app.get('/healthz', (context) => {
        const body: Health = {
          status: 'ok',
          service: 'ezacto',
          environment: context.env.ENVIRONMENT,
          release: context.env.RELEASE,
        }
        return context.json(body, 200, { 'cache-control': 'no-store' })
      })

      app.get('/openapi/v1.json', (context) =>
        context.json(generateOpenApiDocument(), 200, {
          'cache-control': 'public, max-age=300',
        }),
      )

      if (services !== undefined) {
        app.post('/__ezacto/bootstrap', async (context) => {
          const expected = context.env.EZACTO_BOOTSTRAP_TOKEN
          if (expected === undefined || expected.length === 0) {
            throw new ApiError({
              status: 503,
              code: 'service_unavailable',
              message: 'Instance bootstrap is not enabled.',
            })
          }

          const authorization = context.req.header('authorization')
          const presented = authorization?.startsWith('Bearer ')
            ? authorization.slice('Bearer '.length)
            : ''
          if (!(await secureTokenEqual(expected, presented))) {
            context.header(
              'www-authenticate',
              'Bearer realm="ezacto-bootstrap"',
            )
            throw new ApiError({
              status: 401,
              code: 'authentication_required',
              message: 'Bootstrap authentication is required.',
            })
          }

          const input = await parseBootstrapBody(context)
          try {
            const result = await services.bootstrap({
              ...input,
              token: expected,
            })
            return context.json(
              {
                data: {
                  status: 'ready',
                  user_id: result.userId,
                  profile: result.profile,
                },
              },
              200,
              { 'cache-control': 'no-store' },
            )
          } catch (error) {
            if (error instanceof InstanceBootstrapConflictError) {
              throw new ApiError({
                status: 409,
                code: 'bootstrap_state_conflict',
                message:
                  'The instance identity state does not match this bootstrap.',
              })
            }
            if (error instanceof RangeError || error instanceof TypeError) {
              throw validationError([
                {
                  field: 'bootstrap',
                  code: 'invalid',
                  message: 'The bootstrap identity fields are invalid.',
                },
              ])
            }
            throw error
          }
        })

        app.post('/__ezacto/bootstrap/owner-password', async (context) => {
          const expected = context.env.EZACTO_BOOTSTRAP_TOKEN
          if (expected === undefined || expected.length === 0) {
            throw new ApiError({
              status: 503,
              code: 'service_unavailable',
              message: 'Instance bootstrap is not enabled.',
            })
          }

          const authorization = context.req.header('authorization')
          const presented = authorization?.startsWith('Bearer ')
            ? authorization.slice('Bearer '.length)
            : ''
          if (!(await secureTokenEqual(expected, presented))) {
            context.header(
              'www-authenticate',
              'Bearer realm="ezacto-bootstrap"',
            )
            throw new ApiError({
              status: 401,
              code: 'authentication_required',
              message: 'Bootstrap authentication is required.',
            })
          }

          const password = await parseBootstrapPasswordBody(context)
          try {
            const result = await services.enrollOwnerPassword({
              token: expected,
              password,
            })
            return context.json(
              {
                data: {
                  status: 'ready',
                  credential: 'password',
                  user_id: result.userId,
                  profile: result.profile,
                  owner_email: result.ownerEmail,
                },
              },
              200,
              { 'cache-control': 'no-store' },
            )
          } catch (error) {
            if (
              error instanceof Error &&
              error.name === 'PasswordDerivationOverloadedError'
            ) {
              context.header('retry-after', '1')
              throw new ApiError({
                status: 503,
                code: 'service_unavailable',
                message: 'Authentication is temporarily unavailable.',
              })
            }
            if (error instanceof InstanceOwnerPasswordConflictError) {
              throw new ApiError({
                status: 409,
                code: 'bootstrap_password_state_conflict',
                message:
                  'The owner password does not match this bootstrap state.',
              })
            }
            if (error instanceof RangeError || error instanceof TypeError) {
              throw validationError([
                {
                  field: 'password',
                  code: 'invalid',
                  message: 'The owner password does not meet the password policy.',
                },
              ])
            }
            throw error
          }
        })
      }

      app.get('/assets/ezacto.css', (context) =>
        context.body(webAssets.stylesheet, 200, {
          'cache-control': 'public, max-age=0, must-revalidate',
          'content-type': 'text/css; charset=utf-8',
        }),
      )

      app.get('/assets/ezacto.js', (context) =>
        context.body(webAssets.javascript, 200, {
          'cache-control': 'public, max-age=0, must-revalidate',
          'content-type': 'text/javascript; charset=utf-8',
        }),
      )

      app.get('/assets/portal-invoice.js', (context) =>
        context.body(webAssets.portalInvoiceJavascript, 200, {
          'cache-control': 'public, max-age=0, must-revalidate',
          'content-type': 'text/javascript; charset=utf-8',
        }),
      )

      app.get('/assets/portal-estimates.js', (context) =>
        context.body(webAssets.portalEstimatesJavascript, 200, {
          'cache-control': 'public, max-age=0, must-revalidate',
          'content-type': 'text/javascript; charset=utf-8',
        }),
      )

      app.get('/', async (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            ...(await shellChrome(context.env, context.req.raw)),
            demoAccounts: publishedDemoAccounts(context.env),
            sessionCookiePresent: hasSessionCookie(context.req.raw),
          }),
          200,
          {
            'cache-control': 'no-store',
            'content-security-policy': shellContentSecurityPolicy,
            'permissions-policy': 'camera=(), microphone=(), geolocation=()',
            'referrer-policy': 'same-origin',
            'x-content-type-options': 'nosniff',
          },
        ),
      )

      // The screen a person lands on when they want to know where things
      // stand. It is above the timesheet rather than instead of it: / remains
      // Time, and every figure here links into the section that owns it.
      app.get('/dashboard', async (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            ...(await shellChrome(context.env, context.req.raw)),
            activeSection: 'Home',
            view: 'dashboard',
            demoAccounts: publishedDemoAccounts(context.env),
            sessionCookiePresent: hasSessionCookie(context.req.raw),
          }),
          200,
          {
            'cache-control': 'no-store',
            'content-security-policy': shellContentSecurityPolicy,
            'permissions-policy': 'camera=(), microphone=(), geolocation=()',
            'referrer-policy': 'same-origin',
            'x-content-type-options': 'nosniff',
          },
        ),
      )

      app.get('/invoices/new', async (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            ...(await shellChrome(context.env, context.req.raw)),
            activeSection: 'Invoices',
            view: 'invoice-generation',
            demoAccounts: publishedDemoAccounts(context.env),
            sessionCookiePresent: hasSessionCookie(context.req.raw),
          }),
          200,
          {
            'cache-control': 'no-store',
            'content-security-policy': shellContentSecurityPolicy,
            'permissions-policy': 'camera=(), microphone=(), geolocation=()',
            'referrer-policy': 'same-origin',
            'x-content-type-options': 'nosniff',
          },
        ),
      )

      app.get('/approvals', async (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            ...(await shellChrome(context.env, context.req.raw)),
            activeSection: 'Approvals',
            view: 'timesheet-approvals',
            demoAccounts: publishedDemoAccounts(context.env),
            sessionCookiePresent: hasSessionCookie(context.req.raw),
          }),
          200,
          {
            'cache-control': 'no-store',
            'content-security-policy': shellContentSecurityPolicy,
            'permissions-policy': 'camera=(), microphone=(), geolocation=()',
            'referrer-policy': 'same-origin',
            'x-content-type-options': 'nosniff',
          },
        ),
      )

      app.get('/invoices', async (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            ...(await shellChrome(context.env, context.req.raw)),
            activeSection: 'Invoices',
            view: 'invoice-list',
            tabs: invoiceTabs('invoice-list'),
            demoAccounts: publishedDemoAccounts(context.env),
            sessionCookiePresent: hasSessionCookie(context.req.raw),
          }),
          200,
          {
            'cache-control': 'no-store',
            'content-security-policy': shellContentSecurityPolicy,
            'permissions-policy': 'camera=(), microphone=(), geolocation=()',
            'referrer-policy': 'same-origin',
            'x-content-type-options': 'nosniff',
          },
        ),
      )

      // Invoices' other three destinations, ahead of /invoices/:invoiceNumber so
      // a named tab is a tab and not an invoice numbered after it. The
      // strip ships before the screens behind it: a labelled empty pane says
      // where recurring invoices, retainers and sender configuration will live,
      // and an absent section says nothing at all.
      app.get('/invoices/recurring', async (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            ...(await shellChrome(context.env, context.req.raw)),
            activeSection: 'Invoices',
            view: 'invoice-recurring',
            tabs: invoiceTabs('invoice-recurring'),
            demoAccounts: publishedDemoAccounts(context.env),
            sessionCookiePresent: hasSessionCookie(context.req.raw),
          }),
          200,
          {
            'cache-control': 'no-store',
            'content-security-policy': shellContentSecurityPolicy,
            'permissions-policy': 'camera=(), microphone=(), geolocation=()',
            'referrer-policy': 'same-origin',
            'x-content-type-options': 'nosniff',
          },
        ),
      )

      // The recurring editor is a page of its own (a definition's line table
      // scrolled sideways inside a dialog), one view for both a new definition
      // and an existing one. Under the same strip, with Recurring current: it
      // is a step inside that tab, not a destination of its own.
      app.get('/invoices/recurring/new', async (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            ...(await shellChrome(context.env, context.req.raw)),
            activeSection: 'Invoices',
            view: 'invoice-recurring-editor',
            tabs: invoiceTabs('invoice-recurring'),
            demoAccounts: publishedDemoAccounts(context.env),
            sessionCookiePresent: hasSessionCookie(context.req.raw),
          }),
          200,
          {
            'cache-control': 'no-store',
            'content-security-policy': shellContentSecurityPolicy,
            'permissions-policy': 'camera=(), microphone=(), geolocation=()',
            'referrer-policy': 'same-origin',
            'x-content-type-options': 'nosniff',
          },
        ),
      )

      app.get('/invoices/recurring/:definitionId/edit', async (context) => {
        const rawDefinitionId = context.req.param('definitionId')
        const definitionId = Number(rawDefinitionId)
        if (
          !/^[1-9][0-9]*$/u.test(rawDefinitionId) ||
          !Number.isSafeInteger(definitionId)
        ) {
          return context.notFound()
        }
        return context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            ...(await shellChrome(context.env, context.req.raw)),
            activeSection: 'Invoices',
            view: 'invoice-recurring-editor',
            tabs: invoiceTabs('invoice-recurring'),
            demoAccounts: publishedDemoAccounts(context.env),
            sessionCookiePresent: hasSessionCookie(context.req.raw),
          }),
          200,
          {
            'cache-control': 'no-store',
            'content-security-policy': shellContentSecurityPolicy,
            'permissions-policy': 'camera=(), microphone=(), geolocation=()',
            'referrer-policy': 'same-origin',
            'x-content-type-options': 'nosniff',
          },
        )
      })

      app.get('/invoices/retainers', async (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            ...(await shellChrome(context.env, context.req.raw)),
            activeSection: 'Invoices',
            view: 'invoice-retainers',
            tabs: invoiceTabs('invoice-retainers'),
            demoAccounts: publishedDemoAccounts(context.env),
            sessionCookiePresent: hasSessionCookie(context.req.raw),
          }),
          200,
          {
            'cache-control': 'no-store',
            'content-security-policy': shellContentSecurityPolicy,
            'permissions-policy': 'camera=(), microphone=(), geolocation=()',
            'referrer-policy': 'same-origin',
            'x-content-type-options': 'nosniff',
          },
        ),
      )

      // Moved to Settings (issue 546). A bookmark and every link that shipped
      // still work: 301, the same way /settings/modules kept working when it
      // folded into /settings/company.
      app.get('/invoices/estimates', async (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            ...(await shellChrome(context.env, context.req.raw)),
            activeSection: 'Invoices',
            view: 'invoice-estimates',
            tabs: invoiceTabs('invoice-estimates'),
            demoAccounts: publishedDemoAccounts(context.env),
            sessionCookiePresent: hasSessionCookie(context.req.raw),
          }),
          200,
          {
            'cache-control': 'no-store',
            'content-security-policy': shellContentSecurityPolicy,
            'permissions-policy': 'camera=(), microphone=(), geolocation=()',
            'referrer-policy': 'same-origin',
            'x-content-type-options': 'nosniff',
          },
        ),
      )

      // Moved to Settings (issue 546). A bookmark and every link that shipped
      // still work: 301, the same way /settings/modules kept working when it
      // folded into /settings/company.
      app.get('/invoices/configure', (context) =>
        context.redirect('/settings/templates', 301),
      )

      app.get('/clients', async (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            ...(await shellChrome(context.env, context.req.raw)),
            activeSection: 'Clients',
            view: 'client-list',
            demoAccounts: publishedDemoAccounts(context.env),
            sessionCookiePresent: hasSessionCookie(context.req.raw),
          }),
          200,
          {
            'cache-control': 'no-store',
            'content-security-policy': shellContentSecurityPolicy,
            'permissions-policy': 'camera=(), microphone=(), geolocation=()',
            'referrer-policy': 'same-origin',
            'x-content-type-options': 'nosniff',
          },
        ),
      )

      app.get('/projects', async (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            ...(await shellChrome(context.env, context.req.raw)),
            activeSection: 'Projects',
            view: 'project-list',
            demoAccounts: publishedDemoAccounts(context.env),
            sessionCookiePresent: hasSessionCookie(context.req.raw),
          }),
          200,
          {
            'cache-control': 'no-store',
            'content-security-policy': shellContentSecurityPolicy,
            'permissions-policy': 'camera=(), microphone=(), geolocation=()',
            'referrer-policy': 'same-origin',
            'x-content-type-options': 'nosniff',
          },
        ),
      )

      app.get('/team', async (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            ...(await shellChrome(context.env, context.req.raw)),
            activeSection: 'Team',
            view: 'team-list',
            demoAccounts: publishedDemoAccounts(context.env),
            sessionCookiePresent: hasSessionCookie(context.req.raw),
          }),
          200,
          {
            'cache-control': 'no-store',
            'content-security-policy': shellContentSecurityPolicy,
            'permissions-policy': 'camera=(), microphone=(), geolocation=()',
            'referrer-policy': 'same-origin',
            'x-content-type-options': 'nosniff',
          },
        ),
      )

      app.get('/capacity', async (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            ...(await shellChrome(context.env, context.req.raw)),
            activeSection: 'Team',
            view: 'capacity',
            tabs: [
              { label: 'People', href: '/team' },
              { label: 'Capacity', href: '/capacity', current: true },
            ],
            demoAccounts: publishedDemoAccounts(context.env),
            sessionCookiePresent: hasSessionCookie(context.req.raw),
          }),
          200,
          {
            'cache-control': 'no-store',
            'content-security-policy': shellContentSecurityPolicy,
            'permissions-policy': 'camera=(), microphone=(), geolocation=()',
            'referrer-policy': 'same-origin',
            'x-content-type-options': 'nosniff',
          },
        ),
      )

      app.get('/tasks', async (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            ...(await shellChrome(context.env, context.req.raw)),
            activeSection: 'Tasks',
            view: 'task-list',
            demoAccounts: publishedDemoAccounts(context.env),
            sessionCookiePresent: hasSessionCookie(context.req.raw),
          }),
          200,
          {
            'cache-control': 'no-store',
            'content-security-policy': shellContentSecurityPolicy,
            'permissions-policy': 'camera=(), microphone=(), geolocation=()',
            'referrer-policy': 'same-origin',
            'x-content-type-options': 'nosniff',
          },
        ),
      )

      for (const paymentsPath of ['/payments','/payments/report']) app.get(paymentsPath, async (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            ...(await shellChrome(context.env, context.req.raw)),
            activeSection: 'Payments',
            view: 'staff-payments',
            tabs: [
              { label: 'People', href: '/team' },
              { label: 'Payments', href: '/payments', current: context.req.path === '/payments' },
              { label: 'Payments report', href: '/payments/report', current: context.req.path === '/payments/report' },
            ],
            demoAccounts: publishedDemoAccounts(context.env),
            sessionCookiePresent: hasSessionCookie(context.req.raw),
          }),
          200,
          {
            'cache-control': 'no-store',
            'content-security-policy': shellContentSecurityPolicy,
            'permissions-policy': 'camera=(), microphone=(), geolocation=()',
            'referrer-policy': 'same-origin',
            'x-content-type-options': 'nosniff',
          },
        ),
      )

      app.get('/my-payments', async (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            ...(await shellChrome(context.env, context.req.raw)),
            activeSection: 'Settings',
            view: 'my-payments',
            tabs: [],
            demoAccounts: publishedDemoAccounts(context.env),
            sessionCookiePresent: hasSessionCookie(context.req.raw),
          }),
          200,
          {
            'cache-control': 'no-store',
            'content-security-policy': shellContentSecurityPolicy,
            'permissions-policy': 'camera=(), microphone=(), geolocation=()',
            'referrer-policy': 'same-origin',
            'x-content-type-options': 'nosniff',
          },
        ),
      )

      for (const reportsPath of ['/reports', '/reports/saved']) app.get(reportsPath, async (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            ...(await shellChrome(context.env, context.req.raw)),
            activeSection: 'Reports',
            view: 'reports',
            tabs: reportKindTabs(context.req.path === '/reports/saved' ? 'saved' : (context.req.query('report') ?? null)),
            demoAccounts: publishedDemoAccounts(context.env),
            sessionCookiePresent: hasSessionCookie(context.req.raw),
          }),
          200,
          {
            'cache-control': 'no-store',
            'content-security-policy': shellContentSecurityPolicy,
            'permissions-policy': 'camera=(), microphone=(), geolocation=()',
            'referrer-policy': 'same-origin',
            'x-content-type-options': 'nosniff',
          },
        ),
      )

      app.get('/expenses', async (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            ...(await shellChrome(context.env, context.req.raw)),
            activeSection: 'Expenses',
            view: 'expense-list',
            demoAccounts: publishedDemoAccounts(context.env),
            sessionCookiePresent: hasSessionCookie(context.req.raw),
          }),
          200,
          {
            'cache-control': 'no-store',
            'content-security-policy': shellContentSecurityPolicy,
            'permissions-policy': 'camera=(), microphone=(), geolocation=()',
            'referrer-policy': 'same-origin',
            'x-content-type-options': 'nosniff',
          },
        ),
      )

      app.get('/expense-categories', async (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            ...(await shellChrome(context.env, context.req.raw)),
            activeSection: 'Expenses',
            view: 'expense-categories',
            demoAccounts: publishedDemoAccounts(context.env),
            sessionCookiePresent: hasSessionCookie(context.req.raw),
          }),
          200,
          {
            'cache-control': 'no-store',
            'content-security-policy': shellContentSecurityPolicy,
            'permissions-policy': 'camera=(), microphone=(), geolocation=()',
            'referrer-policy': 'same-origin',
            'x-content-type-options': 'nosniff',
          },
        ),
      )

      // Two destinations, split the way the settings themselves are: yours, and
      // everyone's. /settings/modules is kept because it shipped, and a URL
      // someone has open should not start 404ing to tidy a route table.
      app.get('/settings/user', async (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            ...(await shellChrome(context.env, context.req.raw)),
            activeSection: 'Settings',
            view: 'settings-user',
            demoAccounts: publishedDemoAccounts(context.env),
            sessionCookiePresent: hasSessionCookie(context.req.raw),
          }),
          200,
          {
            'cache-control': 'no-store',
            'content-security-policy': shellContentSecurityPolicy,
            'permissions-policy': 'camera=(), microphone=(), geolocation=()',
            'referrer-policy': 'same-origin',
            'x-content-type-options': 'nosniff',
          },
        ),
      )
      app.get('/settings/company', async (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            ...(await shellChrome(context.env, context.req.raw)),
            activeSection: 'Settings',
            view: 'settings-company',
            demoAccounts: publishedDemoAccounts(context.env),
            sessionCookiePresent: hasSessionCookie(context.req.raw),
          }),
          200,
          {
            'cache-control': 'no-store',
            'content-security-policy': shellContentSecurityPolicy,
            'permissions-policy': 'camera=(), microphone=(), geolocation=()',
            'referrer-policy': 'same-origin',
            'x-content-type-options': 'nosniff',
          },
        ),
      )

      app.get('/settings/templates', async (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            ...(await shellChrome(context.env, context.req.raw)),
            activeSection: 'Settings',
            view: 'settings-templates',
            demoAccounts: publishedDemoAccounts(context.env),
            sessionCookiePresent: hasSessionCookie(context.req.raw),
          }),
          200,
          {
            'cache-control': 'no-store',
            'content-security-policy': shellContentSecurityPolicy,
            'permissions-policy': 'camera=(), microphone=(), geolocation=()',
            'referrer-policy': 'same-origin',
            'x-content-type-options': 'nosniff',
          },
        ),
      )

      app.get('/settings/roles', async (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            ...(await shellChrome(context.env, context.req.raw)),
            activeSection: 'Settings',
            view: 'settings-roles',
            demoAccounts: publishedDemoAccounts(context.env),
            sessionCookiePresent: hasSessionCookie(context.req.raw),
          }),
          200,
          {
            'cache-control': 'no-store',
            'content-security-policy': shellContentSecurityPolicy,
            'permissions-policy': 'camera=(), microphone=(), geolocation=()',
            'referrer-policy': 'same-origin',
            'x-content-type-options': 'nosniff',
          },
        ),
      )

      app.get('/settings/activity', async (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            ...(await shellChrome(context.env, context.req.raw)),
            activeSection: 'Settings',
            view: 'settings-activity',
            demoAccounts: publishedDemoAccounts(context.env),
            sessionCookiePresent: hasSessionCookie(context.req.raw),
          }),
          200,
          {
            'cache-control': 'no-store',
            'content-security-policy': shellContentSecurityPolicy,
            'permissions-policy': 'camera=(), microphone=(), geolocation=()',
            'referrer-policy': 'same-origin',
            'x-content-type-options': 'nosniff',
          },
        ),
      )

      // The page shipped (issue 485) and the Settings strip and the palette
      // linked here, but no route served it, so the link answered "That page
      // does not exist".
      app.get('/settings/deliveries', async (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            ...(await shellChrome(context.env, context.req.raw)),
            activeSection: 'Settings',
            view: 'settings-deliveries',
            demoAccounts: publishedDemoAccounts(context.env),
            sessionCookiePresent: hasSessionCookie(context.req.raw),
          }),
          200,
          {
            'cache-control': 'no-store',
            'content-security-policy': shellContentSecurityPolicy,
            'permissions-policy': 'camera=(), microphone=(), geolocation=()',
            'referrer-policy': 'same-origin',
            'x-content-type-options': 'nosniff',
          },
        ),
      )

      // The URL this page shipped under. Redirect rather than delete: someone
      // has it bookmarked, and a 404 to tidy a route table is a poor trade.
      app.get('/settings/modules', (context) => context.redirect('/settings/company', 301))
      // Where the QuickBooks consent screen sends an operator back to. It never
      // existed as a page of its own; it is the accounting section (issue 800).
      app.get('/settings/integrations', (context) =>
        context.redirect('/settings/company#integrations', 301),
      )

      app.get('/expenses/:expenseId', async (context) => {
        const rawExpenseId = context.req.param('expenseId')
        const expenseId = Number(rawExpenseId)
        if (
          !/^[1-9][0-9]*$/u.test(rawExpenseId) ||
          !Number.isSafeInteger(expenseId)
        ) {
          return context.notFound()
        }
        return context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            ...(await shellChrome(context.env, context.req.raw)),
            activeSection: 'Expenses',
            view: 'expense-detail',
            demoAccounts: publishedDemoAccounts(context.env),
            sessionCookiePresent: hasSessionCookie(context.req.raw),
          }),
          200,
          {
            'cache-control': 'no-store',
            'content-security-policy': shellContentSecurityPolicy,
            'permissions-policy': 'camera=(), microphone=(), geolocation=()',
            'referrer-policy': 'same-origin',
            'x-content-type-options': 'nosniff',
          },
        )
      })

      app.get('/projects/:projectId', async (context) => {
        const rawProjectId = context.req.param('projectId')
        const projectId = Number(rawProjectId)
        if (
          !/^[1-9][0-9]*$/u.test(rawProjectId) ||
          !Number.isSafeInteger(projectId)
        ) {
          return context.notFound()
        }
        return context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            ...(await shellChrome(context.env, context.req.raw)),
            activeSection: 'Projects',
            view: 'project-detail',
            demoAccounts: publishedDemoAccounts(context.env),
            sessionCookiePresent: hasSessionCookie(context.req.raw),
          }),
          200,
          {
            'cache-control': 'no-store',
            'content-security-policy': shellContentSecurityPolicy,
            'permissions-policy': 'camera=(), microphone=(), geolocation=()',
            'referrer-policy': 'same-origin',
            'x-content-type-options': 'nosniff',
          },
        )
      })

      app.get('/team/:personId', async (context) => {
        const rawPersonId = context.req.param('personId')
        const personId = Number(rawPersonId)
        if (
          !/^[1-9][0-9]*$/u.test(rawPersonId) ||
          !Number.isSafeInteger(personId)
        ) {
          return context.notFound()
        }
        return context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            ...(await shellChrome(context.env, context.req.raw)),
            activeSection: 'Team',
            view: 'team-person',
            demoAccounts: publishedDemoAccounts(context.env),
            sessionCookiePresent: hasSessionCookie(context.req.raw),
          }),
          200,
          {
            'cache-control': 'no-store',
            'content-security-policy': shellContentSecurityPolicy,
            'permissions-policy': 'camera=(), microphone=(), geolocation=()',
            'referrer-policy': 'same-origin',
            'x-content-type-options': 'nosniff',
          },
        )
      })

      app.get('/clients/:clientId', async (context) => {
        const rawClientId = context.req.param('clientId')
        const clientId = Number(rawClientId)
        if (
          !/^[1-9][0-9]*$/u.test(rawClientId) ||
          !Number.isSafeInteger(clientId)
        ) {
          return context.notFound()
        }
        return context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            ...(await shellChrome(context.env, context.req.raw)),
            activeSection: 'Clients',
            view: 'client-detail',
            demoAccounts: publishedDemoAccounts(context.env),
            sessionCookiePresent: hasSessionCookie(context.req.raw),
          }),
          200,
          {
            'cache-control': 'no-store',
            'content-security-policy': shellContentSecurityPolicy,
            'permissions-policy': 'camera=(), microphone=(), geolocation=()',
            'referrer-policy': 'same-origin',
            'x-content-type-options': 'nosniff',
          },
        )
      })

      // An invoice's pages by record id. Every link the app draws addresses an
      // invoice by its number (below); these serve a number that cannot be a
      // path segment, and anything that still holds an id. The page reads the
      // invoice and moves the address bar onto its number.
      app.get('/invoices/by-id/:invoiceId', async (context) => {
        const rawInvoiceId = context.req.param('invoiceId')
        const invoiceId = Number(rawInvoiceId)
        if (
          !/^[1-9][0-9]*$/u.test(rawInvoiceId) ||
          !Number.isSafeInteger(invoiceId)
        ) {
          return context.notFound()
        }
        return context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            ...(await shellChrome(context.env, context.req.raw)),
            activeSection: 'Invoices',
            view: 'invoice-detail',
            demoAccounts: publishedDemoAccounts(context.env),
            sessionCookiePresent: hasSessionCookie(context.req.raw),
          }),
          200,
          {
            'cache-control': 'no-store',
            'content-security-policy': shellContentSecurityPolicy,
            'permissions-policy': 'camera=(), microphone=(), geolocation=()',
            'referrer-policy': 'same-origin',
            'x-content-type-options': 'nosniff',
          },
        )
      })

      app.get('/invoices/by-id/:invoiceId/edit', async (context) => {
        const rawInvoiceId = context.req.param('invoiceId')
        const invoiceId = Number(rawInvoiceId)
        if (
          !/^[1-9][0-9]*$/u.test(rawInvoiceId) ||
          !Number.isSafeInteger(invoiceId)
        ) {
          return context.notFound()
        }
        return context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            ...(await shellChrome(context.env, context.req.raw)),
            activeSection: 'Invoices',
            view: 'invoice-edit',
            demoAccounts: publishedDemoAccounts(context.env),
            sessionCookiePresent: hasSessionCookie(context.req.raw),
          }),
          200,
          {
            'cache-control': 'no-store',
            'content-security-policy': shellContentSecurityPolicy,
            'permissions-policy': 'camera=(), microphone=(), geolocation=()',
            'referrer-policy': 'same-origin',
            'x-content-type-options': 'nosniff',
          },
        )
      })

      // An invoice's page by its number, `/invoices/4021`: the name on the
      // document, and the address every link draws. A number is text -- "089"
      // is its own address -- and `invoiceNumberIsAddressable` is the one rule
      // for which numbers are, shared with the links, so a reserved segment
      // (`new`, the tabs above, `by-id`) is never read as one.
      app.get('/invoices/:invoiceNumber', async (context) => {
        if (!invoiceNumberIsAddressable(context.req.param('invoiceNumber'))) {
          return context.notFound()
        }
        return context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            ...(await shellChrome(context.env, context.req.raw)),
            activeSection: 'Invoices',
            view: 'invoice-detail',
            demoAccounts: publishedDemoAccounts(context.env),
            sessionCookiePresent: hasSessionCookie(context.req.raw),
          }),
          200,
          {
            'cache-control': 'no-store',
            'content-security-policy': shellContentSecurityPolicy,
            'permissions-policy': 'camera=(), microphone=(), geolocation=()',
            'referrer-policy': 'same-origin',
            'x-content-type-options': 'nosniff',
          },
        )
      })

      // The invoice editor: the document fields and every line on one page,
      // saved together, the way Harvest's Edit invoice worked. Addressed by the
      // invoice number like the detail page beside it.
      app.get('/invoices/:invoiceNumber/edit', async (context) => {
        if (!invoiceNumberIsAddressable(context.req.param('invoiceNumber'))) {
          return context.notFound()
        }
        return context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            ...(await shellChrome(context.env, context.req.raw)),
            activeSection: 'Invoices',
            view: 'invoice-edit',
            demoAccounts: publishedDemoAccounts(context.env),
            sessionCookiePresent: hasSessionCookie(context.req.raw),
          }),
          200,
          {
            'cache-control': 'no-store',
            'content-security-policy': shellContentSecurityPolicy,
            'permissions-policy': 'camera=(), microphone=(), geolocation=()',
            'referrer-policy': 'same-origin',
            'x-content-type-options': 'nosniff',
          },
        )
      })

      // Last, so every real route above has already claimed its path.
      //
      // One handler served both surfaces before this, which meant a browser at
      // a mistyped address got the API's JSON error object filling the viewport
      // with no way back (#557). The API keeps that body -- a machine caller
      // wants the code, not a page -- and everything else gets the shell it
      // would have got had the path existed.
      app.notFound(async (context) => {
        const path = context.req.path
        if (
          path === '/api/v1' ||
          path.startsWith('/api/v1/') ||
          path === '/harvest/v2' ||
          path.startsWith('/harvest/v2/')
        ) {
          return notFoundResponse(context)
        }
        return context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            ...(await shellChrome(context.env, context.req.raw)),
            demoAccounts: publishedDemoAccounts(context.env),
            sessionCookiePresent: hasSessionCookie(context.req.raw),
            view: 'not-found',
          }),
          404,
          {
            'cache-control': 'no-store',
            'content-security-policy': shellContentSecurityPolicy,
            'permissions-policy': 'camera=(), microphone=(), geolocation=()',
            'referrer-policy': 'same-origin',
            'x-content-type-options': 'nosniff',
          },
        )
      })
    },
  })
}

const configuredCredential = (value: string | undefined): string | null => {
  if (value === undefined) return null
  const normalized = value.trim()
  return normalized === '' ? null : normalized
}

export const cloudflareAccessConfig = (
  env: WorkerEnv,
): CloudflareAccessVerifierConfig | null => {
  const teamDomain = configuredCredential(env.ACCESS_TEAM_DOMAIN)
  const audience = configuredCredential(env.ACCESS_POLICY_AUD)
  if (teamDomain === null && audience === null) return null
  if (teamDomain === null || audience === null) {
    throw new TypeError(
      'Cloudflare Access team domain and policy audience must be configured together',
    )
  }
  const config = { teamDomain, audience }
  assertValidCloudflareAccessConfig(config)
  return config
}

/**
 * Where the identity provider is told to send the browser back to.
 *
 * The rule this enforces is that the origin never comes from the request. A
 * redirect origin an attacker can influence is an account takeover: point it at
 * a host you control, and the authorization code arrives at your server instead
 * of ours. `APP_BASE_URL` is not trusted for the live environments for exactly
 * that reason -- it is reachable from too many places to be the thing an OIDC
 * redirect hangs on.
 *
 * It used to be a literal in this file, which enforced the rule and also put
 * one deployment's hostname in everyone's source. `OIDC_REDIRECT_ORIGIN` is set
 * at deploy time beside the rest of that deployment's configuration: a value a
 * request cannot reach, the same as a constant, but belonging to whoever is
 * running the install. Prod fails closed rather than falling back, because a
 * fallback here is the bug.
 */
const redirectOrigin = (env: AppEnv): string => {
  const declared = configuredCredential(env.OIDC_REDIRECT_ORIGIN)
  if (declared !== null) return assertRedirectOrigin(declared)
  if (env.ENVIRONMENT === 'prod') {
    throw new TypeError('OIDC_REDIRECT_ORIGIN is required in prod')
  }
  if (env.ENVIRONMENT === 'dev') return 'https://ezacto.io'
  const configured = configuredCredential(env.APP_BASE_URL)
  if (configured === null) {
    throw new TypeError('APP_BASE_URL is required for OIDC outside live environments')
  }
  return configured
}

/**
 * An origin and nothing else: scheme and host, no credentials, no path, no
 * query. A URL carrying userinfo (`https://good.example@evil.example`) reads as
 * the trusted host to a person and resolves to the attacker's to a browser,
 * which is the whole trick, so it is refused rather than normalised.
 */
const assertRedirectOrigin = (value: string): string => {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new TypeError('OIDC_REDIRECT_ORIGIN must be an absolute URL')
  }
  if (parsed.protocol !== 'https:') {
    throw new TypeError('OIDC_REDIRECT_ORIGIN must be https')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new TypeError('OIDC_REDIRECT_ORIGIN must not carry credentials')
  }
  if (parsed.search !== '' || parsed.hash !== '' || parsed.pathname !== '/') {
    throw new TypeError('OIDC_REDIRECT_ORIGIN must be an origin, with no path or query')
  }
  return parsed.origin
}

/** Application-owned provider registry. Request input never selects an issuer. */
export const oidcProvider = (
  key: string,
  env: AppEnv,
): OidcProviderConfig | null => {
  if (key !== 'google') return null
  const clientId = configuredCredential(env.OIDC_GOOGLE_CLIENT_ID)
  const clientSecret = configuredCredential(env.OIDC_GOOGLE_CLIENT_SECRET)
  if (clientId === null && clientSecret === null) return null
  if (clientId === null || clientSecret === null) {
    throw new TypeError('Google OIDC client id and secret must be configured together')
  }
  return {
    issuer: 'https://accounts.google.com',
    clientId,
    clientSecret,
    redirectOrigin: redirectOrigin(env),
    clientAuthentication: 'client_secret_post',
    idTokenSigningAlgorithm: 'RS256',
    scopes: ['openid', 'email', 'profile'],
  }
}

/** GitHub OAuth2 provider. Not OIDC; uses /user and /user/emails endpoints. */
export const githubProvider = (
  env: AppEnv,
): GitHubProviderConfig | null => {
  const clientId = configuredCredential(env.GITHUB_CLIENT_ID)
  const clientSecret = configuredCredential(env.GITHUB_CLIENT_SECRET)
  if (clientId === null && clientSecret === null) return null
  if (clientId === null || clientSecret === null) {
    throw new TypeError('GitHub client id and secret must be configured together')
  }
  return {
    clientId,
    clientSecret,
    redirectOrigin: redirectOrigin(env),
  }
}

/**
 * Native Sign in with Apple. Not an OAuth pair and not a redirect flow: the
 * mobile app already holds an Apple-signed identity token, so the only thing
 * a deployment supplies is the audience that token must carry -- the app's
 * bundle identifier, optionally with a web Services ID beside it. Absent means
 * the route stays configured off and answers 404.
 */
export const appleProvider = (env: AppEnv): AppleProviderConfig | null => {
  const clientId = configuredCredential(env.APPLE_CLIENT_ID)
  if (clientId === null) return null
  return { clientId }
}

/**
 * Whether this deployment is the public demo.
 *
 * Two conditions, and the environment is the one that matters: `DEMO_MODE` is
 * an operator's switch and `ENVIRONMENT` is the deployment's identity, so a
 * `DEMO_MODE` left set on a production worker publishes nothing and wipes
 * nothing. Everything demo-shaped in this codebase asks this function, so
 * there is one place to read to know what it takes.
 */
export const workItemCredentialConfigured = (env: AppEnv, provider: WorkItemProviderId): boolean => {
  const value = env[workItemProviders[provider].credentialSecret]
  return typeof value === 'string' && value !== ''
}

export const demoDeployment = (env: AppEnv): boolean =>
  env.ENVIRONMENT !== 'prod' && env.DEMO_MODE === 'true'

/**
 * The recipient domains the public demo may deliver mail to (#931), or null
 * where this deployment is not the demo and mail goes wherever it is addressed.
 *
 * The demo prints its own administrator's password, so anything it can send,
 * anyone can send -- from the sender the operator's real mail shares. It keeps
 * a real transport, because its operator tests mail on it before production,
 * and delivers only to the domains `DEMO_MAIL_ALLOWED_DOMAINS` lists. On the
 * demo an unset or empty list is no domain at all: it delivers nothing. Lower
 * case, a leading `@` dropped, each domain once.
 *
 * Server-side only. Nothing that reaches a browser may carry it -- a visitor
 * who could read the list off the demo would know where it can send.
 */
export const demoMailDomains =(env: AppEnv): readonly string[] | null => {
  if (!demoDeployment(env)) return null
  return [
    ...new Set(
      (env.DEMO_MAIL_ALLOWED_DOMAINS ?? '')
        .split(',')
        .map((domain) => domain.trim().toLowerCase().replace(/^@/u, ''))
        .filter((domain) => domain !== ''),
    ),
  ]
}

/**
 * Longest an API token minted on the demo may live.
 *
 * ezacto.io publishes its own credentials, so a token issued there is one that
 * any visitor could have made, and the browser extension asks for exactly such
 * a token to put the timer on a toolbar. A day is the cadence the demo is
 * rebuilt on: long enough that a sitting is never interrupted, short enough
 * that nothing minted during one outlives it. Ordinary instances have no
 * ceiling -- see `createApiTokenStore`.
 */
export const DEMO_API_TOKEN_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000

/** The accounts a demo prints on its own sign-in page, and nothing anywhere else. */
export const publishedDemoAccounts = (env: AppEnv): readonly DemoSignInAccount[] | undefined =>
  demoDeployment(env)
    ? demoAccounts.map((account) => ({
        label: account.label,
        email: account.email,
        password: account.password,
        describes: account.describes,
      }))
    : undefined

/** Public shell availability contains provider keys only, never credentials. */
export const configuredSignInProviders = (
  env: AppEnv,
): readonly SignInProvider[] => {
  const providers: SignInProvider[] = []
  try {
    const google = oidcProvider('google', env)
    if (google !== null) {
      assertValidOidcProviderConfig(google)
      providers.push('google')
    }
  } catch {
    // A partial or invalid deployment configuration must not advertise a flow
    // that cannot start. The fixed provider route continues to fail closed.
  }
  try {
    const github = githubProvider(env)
    if (github !== null) {
      assertValidGitHubProviderConfig(github)
      providers.push('github')
    }
  } catch {
    // Same fail-closed policy as Google above.
  }
  if (env.APPLE_WEB_ENABLED === 'true' && appleWebConfiguration(env) !== null) providers.push('apple')
  return providers
}

/**
 * What this deployment has credentials for, which is the other half of whether
 * a sign-in method may run (issue 761). Password needs nothing configured --
 * it is native -- so it is always available and only the setting decides it.
 */
export const deployedSignInMethods = (
  env: AppEnv & { MAGIC_LINK_SIGNING_KEY?: string },
): readonly SignInMethod[] => {
  const methods: SignInMethod[] = ['password']
  if (env.MAGIC_LINK_SIGNING_KEY !== undefined && env.MAGIC_LINK_SIGNING_KEY !== '') {
    methods.push('magic_link')
  }
  for (const provider of configuredSignInProviders(env)) methods.push(provider)
  // Either native or web configuration makes Apple an available method.
  if (appleProvider(env) !== null && !methods.includes('apple')) methods.push('apple')
  return methods
}

type BootstrapBody = Omit<InstanceBootstrapInput, 'token'>

const bootstrapFields = [
  'organization_name',
  'owner_first_name',
  'owner_last_name',
  'owner_email',
] as const

const parseBootstrapBody = async (
  context: Parameters<typeof readJsonBody>[0],
): Promise<BootstrapBody> => {
  const body = await readJsonBody<unknown>(context, { maxBytes: 8 * 1024 })
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw validationError([
      { field: 'body', code: 'invalid', message: 'body must be a JSON object' },
    ])
  }
  const record = body as Record<string, unknown>
  const allowed = new Set<string>(bootstrapFields)
  const fields = [
    ...bootstrapFields
      .filter(
        (field) =>
          typeof record[field] !== 'string' || record[field].trim() === '',
      )
      .map((field) => ({
        field,
        code: 'required',
        message: `${field} must be a non-empty string`,
      })),
    ...Object.keys(record)
      .filter((field) => !allowed.has(field))
      .map((field) => ({
        field,
        code: 'unknown',
        message: `${field} is not accepted`,
      })),
  ]
  if (fields.length > 0) throw validationError(fields)
  return {
    organizationName: record.organization_name as string,
    ownerFirstName: record.owner_first_name as string,
    ownerLastName: record.owner_last_name as string,
    ownerEmail: record.owner_email as string,
  }
}

const parseBootstrapPasswordBody = async (
  context: Parameters<typeof readJsonBody>[0],
): Promise<string> => {
  const body = await readJsonBody<unknown>(context, { maxBytes: 8 * 1024 })
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw validationError([
      { field: 'body', code: 'invalid', message: 'body must be a JSON object' },
    ])
  }
  const record = body as Record<string, unknown>
  const fields = [
    ...(typeof record.password === 'string'
      ? []
      : [
          {
            field: 'password',
            code: 'required',
            message: 'password must be a string',
          },
        ]),
    ...Object.keys(record)
      .filter((field) => field !== 'password')
      .map((field) => ({
        field,
        code: 'unknown',
        message: `${field} is not accepted`,
      })),
  ]
  if (fields.length > 0) throw validationError(fields)
  return record.password as string
}

const secureTokenEqual = async (
  expected: string,
  presented: string,
): Promise<boolean> => {
  const digest = async (value: string): Promise<Uint8Array> =>
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
    )
  const [left, right] = await Promise.all([digest(expected), digest(presented)])
  let difference = left.length ^ right.length
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ (right[index] ?? 0)
  }
  return difference === 0
}

const systemClock = {
  now() {
    const instant = new Date().toISOString()
    return {
      instant,
      date: instant.slice(0, 10),
      time: instant.slice(11, 16),
    }
  },
}

const shellContentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "connect-src 'self'",
  "img-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')
