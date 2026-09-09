import {
  createApiApp,
  ApiError,
  assertValidCloudflareAccessConfig,
  assertValidGitHubProviderConfig,
  assertValidOidcProviderConfig,
  generateOpenApiDocument,
  installAttachmentRoutes,
  installClientTreeRoutes,
  installEmailHealthRoutes,
  installEmailLogRoutes,
  installEmailConfigurationRoutes,
  installGeneralResourceRoutes,
  installMagicLinkRoutes,
  installModuleSettingsRoutes,
  installGitHubRoutes,
  installMoneyResourceRoutes,
  installOidcRoutes,
  installOutboxRoutes,
  installPasswordAuthRoutes,
  installReportRoutes,
  installSessionRoutes,
  installSsoDomainRoutes,
  installTrackedResourceRoutes,
  installTimesheetApprovalRoutes,
  installBackupStatusRoutes,
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
  type ClientTreeReader,
  type CloudflareAccessVerifierConfig,
  type ApiSessionService,
  type GeneralResourceRouteOptions,
  type ModuleSettingsService,
  type EmailConfigurationRouteOptions,
  type MagicLinkRouteOptions,
  type ActivityRecorder,
  type TwoFactorService,
  type GitHubProviderConfig,
  type MoneyResourceRouteOptions,
  type OidcIdentityResolver,
  type OidcProviderConfig,
  type OidcTransactionStorePort,
  type PasswordAuthService,
  type BackupStatusReader,
  type ReportReader,
  type SsoProvisioningDomainService,
  type UserEmailService,
  type TrackedResourceRepository,
  type TimesheetApprovalService,
  type TimesheetLockPolicyService,
  type TeamRouteOptions,
} from '@ezacto/api'
import {
  InstanceBootstrapConflictError,
  InstanceOwnerPasswordConflictError,
  type InstanceBootstrapInput,
  type InstanceBootstrapResult,
  type InstanceOwnerPasswordInput,
  type InstanceOwnerPasswordResult,
  type OutboxService,
} from '@ezacto/db/d1'
import {
  brandFromEnv,
  invoiceTabs,
  renderAppShell,
  reportKindTabs,
  webAssets,
  type SignInProvider,
} from '@ezacto/web'
import type {
  EmailLogStore,
  QueuedEmailJob,
  SenderBoundQueuedMailer,
} from '@ezacto/mailer'

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
  EZACTO_BOOTSTRAP_TOKEN?: string
  BRAND_NAME?: string
  BRAND_TAGLINE?: string
  BRAND_DESCRIPTION?: string
  BRAND_FAVICON?: string
  BRAND_WORDMARK_LIGHT?: string
  BRAND_WORDMARK_DARK?: string
  BRAND_EMAIL_SENDER_NAME?: string
}

export type WorkerEnv = AppEnv & {
  DB: D1Database
  /** Content-addressed attachment objects. Metadata remains in DB. */
  ATTACHMENTS?: R2Bucket
  API_CURSOR_SIGNING_KEY: string
  /**
   * Portal magic-link signing key. Absent means portal auth is off: the routes
   * hand out sessions, so an install with no key must not serve them rather
   * than serve them with a weak one.
   */
  MAGIC_LINK_SIGNING_KEY?: string
  /** Bound together with a provider implementation; absent deployments fail auth email closed. */
  EMAIL_QUEUE?: Queue<QueuedEmailJob>
  /** Optional Cloudflare Access provider; both values are required together. */
  ACCESS_TEAM_DOMAIN?: string
  ACCESS_POLICY_AUD?: string
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
  MAIL_FROM?: string
}

export interface RuntimeServices {
  bootstrap(input: InstanceBootstrapInput): Promise<InstanceBootstrapResult>
  enrollOwnerPassword(
    input: InstanceOwnerPasswordInput,
  ): Promise<InstanceOwnerPasswordResult>
  tokens: ApiTokenService
  generalResources: GeneralResourceRouteOptions['repository']
  /** Rooted reads of the client closure, behind the documented tree routes. */
  clientTree: ClientTreeReader
  team: TeamRouteOptions['repository']
  trackedResources: TrackedResourceRepository
  isExpensesModuleEnabled(): Promise<boolean>
  moduleSettings: ModuleSettingsService
  /** The domains SSO may provision a user for, and their DNS challenges (#270). */
  ssoProvisioningDomains: SsoProvisioningDomainService
  /**
   * Adding a second address to an existing user (#269). The password service
   * implements it; the port stays narrow so the route asks for the one thing.
   */
  userEmails: UserEmailService
  isTeamModuleEnabled(): Promise<boolean>
  timesheetApprovals: TimesheetApprovalService
  timesheetLockPolicy: TimesheetLockPolicyService
  moneyResources: MoneyResourceRouteOptions['service']
  invoiceGeneration: NonNullable<MoneyResourceRouteOptions['generation']>
  /** Issues the invoice a recurring definition is due for. */
  recurringInvoices: NonNullable<MoneyResourceRouteOptions['recurringGeneration']>
  reports: ReportReader
  cursorSigningKey: Uint8Array
  passwordAuth: PasswordAuthService
  sessions: ApiSessionService
  /** Composite browser resolver when an optional edge identity provider is configured. */
  authenticationSessions?: ApiSessionResolver
  emailLog: EmailLogStore
  emailConfiguration: EmailConfigurationRouteOptions['service']
  senderIdentityVerifier?: EmailConfigurationRouteOptions['verifier']
  organizationMailer?: SenderBoundQueuedMailer
  outbox: OutboxService
  identities: OidcIdentityResolver
  oidcTransactions: OidcTransactionStorePort
  /** Deployment-brand sender for all authentication mail. */
  deploymentAuthMailer?: AuthMailer
  attachments?: AttachmentRouteOptions
  /** Portal magic-link authentication for contacts. */
  portalAuth?: MagicLinkRouteOptions
  /** The second factor for signed-in users. Absent only where there is no store. */
  twoFactor?: TwoFactorService
  /** Where credential events are recorded. Absent leaves them unrecorded. */
  activity?: ActivityRecorder
  backupStatus?: BackupStatusReader
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

export const createApp = (services?: RuntimeServices) =>
  createApiApp<AppEnv>({
    ...(services === undefined
      ? {}
      : {
          authentication: {
            tokens: services.tokens,
            sessions: services.authenticationSessions ?? services.sessions,
            ...(services.twoFactor === undefined
              ? {}
              : { twoFactor: services.twoFactor }),
            ...(services.activity === undefined
              ? {}
              : { activity: services.activity }),
          },
          installApi: (api) => {
            installSessionRoutes(api, services.sessions)
            installEmailLogRoutes(api, services.emailLog)
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
            installOutboxRoutes(api, services.outbox)
            installGeneralResourceRoutes(api, {
              repository: services.generalResources,
              cursorSigningKey: services.cursorSigningKey,
              isExpensesModuleEnabled: services.isExpensesModuleEnabled,
              isTeamModuleEnabled: services.isTeamModuleEnabled,
              teamRepository: services.team,
            })
            installClientTreeRoutes(api, services.clientTree)
            installTeamRoutes(api, {
              repository: services.team,
              cursorSigningKey: services.cursorSigningKey,
              isTeamModuleEnabled: services.isTeamModuleEnabled,
            })
            installTrackedResourceRoutes(api, {
              repository: services.trackedResources,
              clock: systemClock,
              cursorSigningKey: services.cursorSigningKey,
              isExpensesModuleEnabled: services.isExpensesModuleEnabled,
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
              ...(services.organizationMailer === undefined
                ? {}
                : {
                    invoiceDelivery: {
                      configuration: services.emailConfiguration,
                      mailer: services.organizationMailer,
                    },
                  }),
              cursorSigningKey: services.cursorSigningKey,
              clock: () => systemClock.now().instant,
            })
            installAttachmentRoutes(api, services.attachments)
            installReportRoutes(api, services.reports)
            if (services.backupStatus !== undefined) {
              installBackupStatusRoutes(api, services.backupStatus)
            }
            installModuleSettingsRoutes(api, {
              service: services.moduleSettings,
              clock: () => systemClock.now().instant,
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
        }),
    installApp(app) {
      if (services !== undefined) {
        installOidcRoutes(app, {
          transactions: services.oidcTransactions,
          identities: services.identities,
          sessions: services.sessions,
          provider: oidcProvider,
          clientKey: (request) =>
            request.headers.get('cf-connecting-ip') ?? 'unknown-client',
        })
        installGitHubRoutes(app, {
          transactions: services.oidcTransactions,
          identities: services.identities,
          sessions: services.sessions,
          provider: (env) => githubProvider(env),
          clientKey: (request) =>
            request.headers.get('cf-connecting-ip') ?? 'unknown-client',
        })
        installPasswordAuthRoutes(app, {
          service: services.passwordAuth,
          sessions: services.sessions,
          ...(services.deploymentAuthMailer === undefined
            ? {}
            : { deploymentMailer: services.deploymentAuthMailer }),
          clientKey: (request) =>
            request.headers.get('cf-connecting-ip') ?? 'unknown-client',
        })
        if (services.portalAuth !== undefined) {
          installMagicLinkRoutes(app, services.portalAuth)
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

      app.get('/', (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            brand: brandFromEnv(context.env),
            signInProviders: configuredSignInProviders(context.env),
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
      app.get('/dashboard', (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            brand: brandFromEnv(context.env),
            activeSection: 'Home',
            view: 'dashboard',
            signInProviders: configuredSignInProviders(context.env),
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

      app.get('/invoices/new', (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            brand: brandFromEnv(context.env),
            activeSection: 'Invoices',
            view: 'invoice-generation',
            signInProviders: configuredSignInProviders(context.env),
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

      app.get('/approvals', (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            brand: brandFromEnv(context.env),
            activeSection: 'Approvals',
            view: 'timesheet-approvals',
            signInProviders: configuredSignInProviders(context.env),
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

      app.get('/invoices', (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            brand: brandFromEnv(context.env),
            activeSection: 'Invoices',
            view: 'invoice-list',
            tabs: invoiceTabs('invoice-list'),
            signInProviders: configuredSignInProviders(context.env),
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

      // Invoices' other three destinations, ahead of /invoices/:invoiceId so a
      // named tab is a tab and not an invoice number that failed to parse. The
      // strip ships before the screens behind it: a labelled empty pane says
      // where recurring invoices, retainers and sender configuration will live,
      // and an absent section says nothing at all.
      app.get('/invoices/recurring', (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            brand: brandFromEnv(context.env),
            activeSection: 'Invoices',
            view: 'invoice-recurring',
            tabs: invoiceTabs('invoice-recurring'),
            signInProviders: configuredSignInProviders(context.env),
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

      app.get('/invoices/retainers', (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            brand: brandFromEnv(context.env),
            activeSection: 'Invoices',
            view: 'invoice-retainers',
            tabs: invoiceTabs('invoice-retainers'),
            signInProviders: configuredSignInProviders(context.env),
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

      app.get('/invoices/configure', (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            brand: brandFromEnv(context.env),
            activeSection: 'Invoices',
            view: 'invoice-configure',
            tabs: invoiceTabs('invoice-configure'),
            signInProviders: configuredSignInProviders(context.env),
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

      app.get('/clients', (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            brand: brandFromEnv(context.env),
            activeSection: 'Clients',
            view: 'client-list',
            signInProviders: configuredSignInProviders(context.env),
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

      app.get('/projects', (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            brand: brandFromEnv(context.env),
            activeSection: 'Projects',
            view: 'project-list',
            signInProviders: configuredSignInProviders(context.env),
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

      app.get('/team', (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            brand: brandFromEnv(context.env),
            activeSection: 'Team',
            view: 'team-list',
            signInProviders: configuredSignInProviders(context.env),
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

      app.get('/tasks', (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            brand: brandFromEnv(context.env),
            activeSection: 'Tasks',
            view: 'task-list',
            signInProviders: configuredSignInProviders(context.env),
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

      app.get('/reports', (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            brand: brandFromEnv(context.env),
            activeSection: 'Reports',
            view: 'reports',
            tabs: reportKindTabs(context.req.query('report') ?? null),
            signInProviders: configuredSignInProviders(context.env),
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

      app.get('/expenses', (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            brand: brandFromEnv(context.env),
            activeSection: 'Expenses',
            view: 'expense-list',
            signInProviders: configuredSignInProviders(context.env),
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

      app.get('/expense-categories', (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            brand: brandFromEnv(context.env),
            activeSection: 'Expenses',
            view: 'expense-categories',
            signInProviders: configuredSignInProviders(context.env),
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
      app.get('/settings/user', (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            brand: brandFromEnv(context.env),
            activeSection: 'Settings',
            view: 'settings-user',
            signInProviders: configuredSignInProviders(context.env),
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
      app.get('/settings/company', (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            brand: brandFromEnv(context.env),
            activeSection: 'Settings',
            view: 'settings-company',
            signInProviders: configuredSignInProviders(context.env),
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

      app.get('/settings/activity', (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            brand: brandFromEnv(context.env),
            activeSection: 'Settings',
            view: 'settings-activity',
            signInProviders: configuredSignInProviders(context.env),
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

      app.get('/expenses/:expenseId', (context) => {
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
            brand: brandFromEnv(context.env),
            activeSection: 'Expenses',
            view: 'expense-detail',
            signInProviders: configuredSignInProviders(context.env),
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

      app.get('/projects/:projectId', (context) => {
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
            brand: brandFromEnv(context.env),
            activeSection: 'Projects',
            view: 'project-detail',
            signInProviders: configuredSignInProviders(context.env),
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

      app.get('/team/:personId', (context) => {
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
            brand: brandFromEnv(context.env),
            activeSection: 'Team',
            view: 'team-person',
            signInProviders: configuredSignInProviders(context.env),
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

      app.get('/clients/:clientId', (context) => {
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
            brand: brandFromEnv(context.env),
            activeSection: 'Clients',
            view: 'client-detail',
            signInProviders: configuredSignInProviders(context.env),
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

      app.get('/invoices/:invoiceId', (context) => {
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
            brand: brandFromEnv(context.env),
            activeSection: 'Invoices',
            view: 'invoice-detail',
            signInProviders: configuredSignInProviders(context.env),
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
    },
  })

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
  return providers
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
