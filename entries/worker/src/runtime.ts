import {
  bootstrapInstanceD1,
  createAttachmentStore,
  enrollInstanceOwnerPasswordD1,
  createApiTokenStore,
  createD1Database,
  createD1IdentityStore,
  createD1OidcTransactionStore,
  createD1OutboxService,
  createQuickBooksMirrorSource,
  createQuickBooksStore,
  createGeneralResourceRepository,
  createMoneyResourceRepository,
  listClientAncestors,
  listClientDescendants,
  createInvoiceGenerationService,
  createReportRepository,
  createModuleSettingsRepository,
  createTimesheetApprovalRepository,
  createTimesheetLockPolicyRepository,
  createTeamRepository,
  createD1EmailLogStore,
  createD1EmailConfigurationStore,
  createD1PasswordAuthService,
  createD1SessionStore,
  createD1SsoProvisioningDomainStore,
  DrizzleTrackedResourceRepository,
  getLatestBackupRuns,
  migrateD1,
  createD1ContactSessionStore,
  createD1MagicLinkStore,
  createMagicLinkService,
  createD1TwoFactorStore,
  createRecurringInvoiceEngine,
  createD1ReminderScheduler,
  captureActivityEvent,
  createTwoFactorService,
  createBillLinkStore,
  createBillMirrorSource,
  createPayoutAccountStore,
  createStripeLinkStore,
  releaseInvoicedTimeEntries,
  recordCheckoutPayment,
  setBillDelivery,
} from "@ezacto/db/d1";
import { createPortalSessionService } from "@ezacto/api";
import {
  createApiSessionService,
  createCloudflareAccessSessionResolver,
  createCloudflareAccessVerifier,
  createInvoiceEmailOutboxSubscriber,
} from "@ezacto/api";
import type {
  AttachmentObjectPort,
  AttachmentRouteOptions,
  CloudflareAccessFetch,
  CloudflareAccessVerifier,
  CloudflareAccessVerifierConfig,
} from "@ezacto/api";
import {
  MailgunMailer,
  SenderIdentityUnavailableError,
  SesMailer,
  configuredEmailSender,
  type HttpEmailProvider,
  type MailgunOptions,
  type SesMailerOptions,
} from "@ezacto/mailer";
import type { RuntimeServices } from "./app.js";
import { cloudflareAccessConfig, type WorkerEnv } from "./app.js";
import {
  createBillMirrorSubscriber,
  createBillRuntime,
  createStripeRuntime,
  createQuickBooksMirrorSubscriber,
  createQuickBooksRuntime,
} from "@ezacto/integrations";
import {
  createWorkerDeploymentAuthMailer,
  createWorkerOrganizationMailer,
} from "./email-queue.js";

const cursorSecretPattern = /^[A-Za-z0-9_-]+$/;
const cursorSecretBytes = 32;

const readiness = new WeakMap<object, Promise<void>>();

let cachedAccessVerifier:
  | {
      teamDomain: string;
      audience: string;
      verifier: CloudflareAccessVerifier;
    }
  | undefined;

const accessVerifier = (
  config: CloudflareAccessVerifierConfig,
): CloudflareAccessVerifier => {
  if (
    cachedAccessVerifier?.teamDomain === config.teamDomain &&
    cachedAccessVerifier.audience === config.audience
  ) {
    return cachedAccessVerifier.verifier;
  }
  const verifier = createCloudflareAccessVerifier(config);
  cachedAccessVerifier = {
    teamDomain: config.teamDomain,
    audience: config.audience,
    verifier,
  };
  return verifier;
};

export const createWorkerSesMailer = (
  env: WorkerEnv,
  options: SesMailerOptions = {},
): SesMailer | null => {
  const configured = [
    env.AWS_ACCESS_KEY_ID,
    env.AWS_SECRET_ACCESS_KEY,
    env.AWS_SESSION_TOKEN,
    env.SES_REGION,
    env.SES_FROM,
    env.SES_CONFIGURATION_SET,
  ];
  if (configured.every((value) => value === undefined)) return null;
  if (
    env.AWS_ACCESS_KEY_ID === undefined ||
    env.AWS_SECRET_ACCESS_KEY === undefined ||
    env.SES_REGION === undefined ||
    env.SES_FROM === undefined
  ) {
    throw new TypeError(
      "SES requires AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, SES_REGION, and SES_FROM together",
    );
  }
  return new SesMailer(
    {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      region: env.SES_REGION,
      from: env.SES_FROM,
      ...(env.AWS_SESSION_TOKEN === undefined
        ? {}
        : { sessionToken: env.AWS_SESSION_TOKEN }),
      ...(env.SES_CONFIGURATION_SET === undefined
        ? {}
        : { configurationSet: env.SES_CONFIGURATION_SET }),
    },
    options,
  );
};

/**
 * Mailgun needs only an API key and a sending domain, so — unlike SES — a
 * partial configuration is nearly impossible to write by accident. Keep the
 * same all-or-nothing shape anyway: a half-set provider must fail closed here
 * rather than boot a worker that silently cannot send.
 */
export const createWorkerMailgunMailer = (
  env: WorkerEnv,
  options: MailgunOptions = {},
): MailgunMailer | null => {
  const configured = [env.MAILGUN_API_KEY, env.MAILGUN_DOMAIN, env.MAILGUN_REGION];
  if (configured.every((value) => value === undefined)) return null;
  if (env.MAILGUN_API_KEY === undefined || env.MAILGUN_DOMAIN === undefined) {
    throw new TypeError(
      "Mailgun requires MAILGUN_API_KEY and MAILGUN_DOMAIN together",
    );
  }
  if (
    env.MAILGUN_REGION !== undefined &&
    env.MAILGUN_REGION !== "us" &&
    env.MAILGUN_REGION !== "eu"
  ) {
    throw new TypeError("MAILGUN_REGION must be 'us' or 'eu'");
  }
  return new MailgunMailer(
    {
      apiKey: env.MAILGUN_API_KEY,
      domain: env.MAILGUN_DOMAIN,
      ...(env.MAILGUN_REGION === undefined ? {} : { region: env.MAILGUN_REGION }),
    },
    options,
  );
};

/**
 * One transport per deployment. Configuring both is a mistake worth refusing
 * loudly: whichever won silently would decide where every invoice came from.
 */
export const createWorkerMailProvider = (
  env: WorkerEnv,
  options: { ses?: SesMailerOptions; mailgun?: MailgunOptions } = {},
): HttpEmailProvider | null => {
  const mailgun = createWorkerMailgunMailer(env, options.mailgun);
  const ses = createWorkerSesMailer(env, options.ses);
  if (mailgun !== null && ses !== null) {
    throw new TypeError(
      "Configure either Mailgun or SES, not both; two transports cannot share one sender",
    );
  }
  return mailgun ?? ses;
};

/**
 * The address invitations, password resets and verification mail come from.
 * MAIL_FROM is provider-neutral; SES_FROM is accepted so an SES deployment
 * keeps working unchanged.
 */
export const resolveMailFrom = (env: WorkerEnv): string | undefined =>
  env.MAIL_FROM ?? env.SES_FROM;

/**
 * Attests only the exact address the deployment is configured to send from, on
 * the domain Mailgun is configured to send it through. Mailgun verifies a
 * sending domain rather than an individual mailbox, so there is no per-address
 * status to fetch: the authority here is the deployment's own configuration,
 * the same claim the SMTP verifier makes, and the DNS behind the domain stays
 * the operator's to own.
 */
export const createMailgunSenderIdentityVerifier = (
  emailProvider: MailgunMailer,
  from: string,
): NonNullable<RuntimeServices['senderIdentityVerifier']> => {
  const configured = configuredEmailSender(from);
  const sendingDomain = emailProvider.domain.normalize('NFC').trim().toLowerCase();
  return {
    provider: 'mailgun',
    verify: async (identity) => {
      if (identity.archivedAt !== null) {
        throw new SenderIdentityUnavailableError('sender_identity_archived', identity.id);
      }
      if (identity.provider !== 'mailgun') {
        throw new SenderIdentityUnavailableError('sender_provider_mismatch', identity.id);
      }
      const address = identity.email.normalize('NFC').trim().toLowerCase();
      const providerIdentity = identity.providerIdentity.normalize('NFC').trim().toLowerCase();
      // The address must be the one the deployment sends as, and its domain must
      // be the one Mailgun accepts. Either half alone would attest something the
      // transport will refuse at send time.
      if (
        address !== configured.email ||
        providerIdentity !== configured.email ||
        address.slice(address.lastIndexOf('@') + 1) !== sendingDomain
      ) {
        throw new SenderIdentityUnavailableError('sender_identity_binding_mismatch', identity.id);
      }
      return {
        source: 'deployment_config',
        identityKind: 'email_address',
        verificationStatus: 'operator_configured',
        dkimStatus: 'not_applicable',
        mailFromDomain: null,
        mailFromStatus: 'not_configured',
        observedAt: new Date().toISOString(),
      };
    },
  };
};

export const createSesSenderIdentityVerifier = (
  emailProvider: SesMailer,
): NonNullable<RuntimeServices['senderIdentityVerifier']> => ({
  provider: 'ses',
  verify: async (identity, signal) => {
    const health = await emailProvider.getIdentityHealth(
      identity.providerIdentity,
      signal,
    )
    const identityType = health.type?.toUpperCase()
    if (identityType !== 'EMAIL_ADDRESS' && identityType !== 'DOMAIN') {
      throw new Error('SES returned an unsupported sender identity type')
    }
    const dkimStatus =
      identityType === 'EMAIL_ADDRESS' &&
      !health.dkim.signingEnabled
        ? ('not_applicable' as const)
        : health.dkim.signingEnabled &&
            health.dkim.status?.toUpperCase() === 'SUCCESS'
          ? ('verified' as const)
          : health.dkim.status?.toUpperCase() === 'FAILED'
            ? ('failed' as const)
            : ('pending' as const)
    const mailFromStatus =
      health.mailFrom.domain === null
        ? ('not_configured' as const)
        : health.mailFrom.status?.toUpperCase() === 'SUCCESS'
          ? ('verified' as const)
          : health.mailFrom.status?.toUpperCase() === 'FAILED'
            ? ('failed' as const)
            : ('pending' as const)
    return {
      source: 'provider_api',
      identityKind:
        identityType === 'EMAIL_ADDRESS'
          ? ('email_address' as const)
          : ('domain' as const),
      verificationStatus: health.verifiedForSending
        ? ('verified' as const)
        : ('pending' as const),
      dkimStatus,
      mailFromDomain: health.mailFrom.domain,
      mailFromStatus,
      observedAt: new Date().toISOString(),
    }
  },
})

/**
 * Decode a canonical base64url secret. Text encodings are deliberately not
 * accepted: deployments must preserve the same key bytes across releases.
 */
export const parseCursorSigningKey = (encoded: string): Uint8Array => {
  if (
    typeof encoded !== "string" ||
    encoded.length === 0 ||
    encoded.length > 128 ||
    encoded.length % 4 === 1 ||
    !cursorSecretPattern.test(encoded)
  ) {
    throw new TypeError("API_CURSOR_SIGNING_KEY must be canonical base64url");
  }

  let binary: string;
  try {
    const padding = "=".repeat((4 - (encoded.length % 4)) % 4);
    binary = atob(encoded.replaceAll("-", "+").replaceAll("_", "/") + padding);
  } catch {
    throw new TypeError("API_CURSOR_SIGNING_KEY must be canonical base64url");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.byteLength !== cursorSecretBytes) {
    throw new TypeError(
      `API_CURSOR_SIGNING_KEY must decode to exactly ${cursorSecretBytes} bytes`,
    );
  }
  if (encodeBase64Url(bytes) !== encoded) {
    throw new TypeError("API_CURSOR_SIGNING_KEY must be canonical base64url");
  }
  return bytes;
};

const encodeBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
};

const requireDatabase = (env: WorkerEnv): D1Database => {
  const database = env.DB;
  if (
    database === undefined ||
    typeof database !== "object" ||
    typeof database.prepare !== "function" ||
    typeof database.batch !== "function" ||
    typeof database.exec !== "function"
  ) {
    throw new TypeError("DB must be a D1 database binding");
  }
  return database;
};

/**
 * D1 itself serializes each ledger-leading migration batch. The isolate cache
 * only removes repeat checks after success; failures are evicted and retried.
 */
export const ensureRuntimeDatabaseReady = async (
  database: D1Database,
): Promise<void> => {
  const identity = database as object;
  const pending = readiness.get(identity);
  if (pending !== undefined) return pending;

  const migration = migrateD1(database).catch((error: unknown) => {
    if (readiness.get(identity) === migration) readiness.delete(identity);
    throw error;
  });
  readiness.set(identity, migration);
  return migration;
};

export const createR2AttachmentObjectStore = (
  bucket: R2Bucket,
): AttachmentObjectPort => ({
  async put(key, bytes, contentType) {
    // A hash-derived key is immutable. If another request already stored these
    // bytes, retain its metadata instead of letting a conflicting upload rewrite
    // the shared object before durable metadata convergence rejects the request.
    // R2 metadata is deliberately non-authoritative: downloads set headers from
    // the immutable database file-object identity owned by the attachment route.
    try {
      await bucket.put(key, bytes, {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType },
      });
    } catch (error) {
      // Some local/older R2 implementations surface the failed precondition as
      // an exception instead of the documented null result. Presence proves
      // the immutable key already converged; unrelated storage failures escape.
      if ((await bucket.head(key)) === null) throw error;
    }
  },
  async get(key) {
    const object = await bucket.get(key);
    return object === null ? null : { body: object.body };
  },
});

export const createD1AttachmentOwnerAuthorizer =
  (database: D1Database): AttachmentRouteOptions["authorizeOwnerAccess"] =>
  async ({ owner, parentId, principal }) => {
    const exists = async (
      statement: string,
      ...bindings: unknown[]
    ): Promise<boolean> =>
      (await database
        .prepare(statement)
        .bind(...bindings)
        .first<{ authorized: number }>()) !== null;

    switch (owner) {
      case "invoice":
        return exists(
          "SELECT 1 AS authorized FROM invoices WHERE id = ?",
          parentId,
        );
      case "recurringInvoice":
        return exists(
          "SELECT 1 AS authorized FROM recurring_invoices WHERE id = ?",
          parentId,
        );
      case "estimate":
        return exists(
          "SELECT 1 AS authorized FROM estimates WHERE id = ?",
          parentId,
        );
      case "expense":
        return exists(
          `SELECT 1 AS authorized FROM expenses
           WHERE id = ? AND user_id = ?
             AND COALESCE((
               SELECT json_extract(modules, '$.expenses')
               FROM organizations WHERE id = 1
             ), 0) = 1`,
          parentId,
          principal.userId,
        );
      case "project":
        if (
          principal.profile === "administrator" ||
          principal.profile === "executive_manager"
        ) {
          return exists(
            "SELECT 1 AS authorized FROM projects WHERE id = ?",
            parentId,
          );
        }
        return exists(
          `SELECT 1 AS authorized FROM projects project
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
          parentId,
        );
    }
  };

export const createRuntimeServices = async (
  env: WorkerEnv,
  options: {
    emailProvider?: HttpEmailProvider;
    ses?: SesMailerOptions;
    mailgun?: MailgunOptions;
    cloudflareAccessFetch?: CloudflareAccessFetch;
  } = {},
): Promise<RuntimeServices> => {
  const database = requireDatabase(env);
  const cursorSigningKey = parseCursorSigningKey(env.API_CURSOR_SIGNING_KEY);
  // Portal magic-link auth is opt-in on the presence of its key. An install
  // that has not set one does not serve the routes at all, rather than serving
  // them with a weak or absent secret -- the routes hand out sessions, so
  // "configured badly" and "not configured" must not look the same.
  const magicLinkSigningKey =
    env.MAGIC_LINK_SIGNING_KEY === undefined || env.MAGIC_LINK_SIGNING_KEY === ""
      ? undefined
      : parseCursorSigningKey(env.MAGIC_LINK_SIGNING_KEY);
  await ensureRuntimeDatabaseReady(database);
  const drizzle = createD1Database(database);
  const timesheetLockPolicy = createTimesheetLockPolicyRepository(drizzle);
  const sessions = createApiSessionService(createD1SessionStore(database));
  const identities = createD1IdentityStore(database);
  const access = cloudflareAccessConfig(env);
  const authenticationSessions =
    access === null
      ? sessions
      : createCloudflareAccessSessionResolver({
          sessions,
          identities,
          verifier:
            options.cloudflareAccessFetch === undefined
              ? accessVerifier(access)
              : createCloudflareAccessVerifier({
                  ...access,
                  fetch: options.cloudflareAccessFetch,
                }),
        });
  const emailLog = createD1EmailLogStore(database);
  const emailConfiguration = createD1EmailConfigurationStore(database);
  const emailProvider =
    options.emailProvider ??
    createWorkerMailProvider(env, {
      ...(options.ses === undefined ? {} : { ses: options.ses }),
      ...(options.mailgun === undefined ? {} : { mailgun: options.mailgun }),
    });
  const organizationName = async () => {
    const row = await database
      .prepare('SELECT name FROM organizations WHERE id = 1')
      .first<{ name: string }>();
    if (row === null) throw new Error('organization is unavailable');
    return row.name;
  };
  const emailTransportReady =
    env.EMAIL_QUEUE !== undefined &&
    emailProvider !== null;
  const emailQueueReady =
    emailTransportReady && env.APP_BASE_URL !== undefined;
  const mailFrom = resolveMailFrom(env);
  const deploymentAuthMailer =
    !emailQueueReady || mailFrom === undefined
      ? undefined
      : createWorkerDeploymentAuthMailer(
          env.EMAIL_QUEUE!,
          emailLog,
          mailFrom,
          emailConfiguration,
          organizationName,
          env.APP_BASE_URL!,
        );
  const organizationMailer =
    !emailTransportReady
      ? undefined
      : createWorkerOrganizationMailer(
          env.EMAIL_QUEUE!,
          emailLog,
          emailProvider.name,
          emailConfiguration,
        );
  // One service behind two ports: the password routes take it whole, the
  // add-an-address route takes only `addEmail`.
  const passwordAuth = createD1PasswordAuthService(database);
  const moneyResources = createMoneyResourceRepository(drizzle);
  // The reminder scheduler is an outbox subscriber, not a service: it schedules
  // a reminder when an invoice is sent and cancels the pending ones when it is
  // paid or written off. Unsubscribed, `reminder_policy` is accepted and stored
  // and `scheduled_reminders` stays permanently empty.
  const reminders = createD1ReminderScheduler(database);

  // Composed only where the deployment carries Intuit keys. Without them the
  // QuickBooks routes are not mounted at all, because a connect button that
  // cannot connect is worse than no button -- `entry-surface.ts` declares that
  // gating so both halves of the contract guard know about it.
  const quickBooks =
    env.QUICKBOOKS_CLIENT_ID === undefined || env.QUICKBOOKS_CLIENT_SECRET === undefined
      ? null
      : createQuickBooksRuntime({
          config: {
            clientId: env.QUICKBOOKS_CLIENT_ID,
            clientSecret: env.QUICKBOOKS_CLIENT_SECRET,
            webhookVerifierToken: env.QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN,
            environment: env.QUICKBOOKS_ENVIRONMENT,
            appBaseUrl: env.APP_BASE_URL,
          },
          store: createQuickBooksStore(drizzle),
          source: createQuickBooksMirrorSource(drizzle, () => new Date()),
          fetch: (request: Request) => fetch(request),
          now: () => new Date(),
        });

  // Composed whenever the deployment carries BILL credentials. Unlike
  // QuickBooks there is nothing to connect -- BILL has no OAuth -- so the
  // routes mount either way and say whether they can reach anything; what
  // changes with the credential is only whether a mirror can run.
  const bill = createBillRuntime({
    config: {
      devKey: env.BILL_DEV_KEY,
      companyId: env.BILL_COMPANY_ID,
      username: env.BILL_USERNAME,
      password: env.BILL_PASSWORD,
      replyToUserId: env.BILL_REPLY_TO_USER_ID,
      environment: env.BILL_ENVIRONMENT,
    },
    links: createBillLinkStore(drizzle, () => new Date()),
    source: createBillMirrorSource(drizzle, () => new Date()),
    fetch: (request: Request) => fetch(request),
    now: () => new Date(),
  })

  // Stripe. Composed always -- the runtime answers `configured: false` without
  // a key, which is what the route reports, rather than the route disappearing.
  const stripeLinks = createStripeLinkStore(drizzle)
  const stripe = createStripeRuntime({
    config: {
      apiKey: env.STRIPE_API_KEY,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    },
    source: {
      readInvoice: async (invoiceId: number) => {
        const rows = await database
          .prepare(
            `SELECT id, number, currency, due_amount_cents AS due
             FROM invoices WHERE id = ?`,
          )
          .bind(invoiceId)
          .all<{ id: number; number: string; currency: string; due: number }>()
        const row = rows.results[0]
        return row === undefined
          ? null
          : {
              id: row.id,
              number: row.number,
              currency: row.currency,
              dueAmountCents: row.due,
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
          // One Stripe account per instance, so a constant names it.
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

  const outbox = createD1OutboxService(database, {
    additionalSubscribers: [
      createInvoiceEmailOutboxSubscriber(moneyResources, organizationMailer),
      reminders.subscriber,
      ...(quickBooks === null ? [] : [createQuickBooksMirrorSubscriber(quickBooks)]),
      createBillMirrorSubscriber(bill),
    ],
  });
  return {
    bootstrap: (input) => bootstrapInstanceD1(database, input),
    enrollOwnerPassword: (input) =>
      enrollInstanceOwnerPasswordD1(database, input),
    tokens: createApiTokenStore(drizzle),
    generalResources: createGeneralResourceRepository(drizzle),
    clientTree: {
      ancestors: (clientId) => listClientAncestors(drizzle, clientId),
      descendants: (clientId) => listClientDescendants(drizzle, clientId),
    },
    team: createTeamRepository(drizzle),
    moneyResources,
    invoiceGeneration: createInvoiceGenerationService(drizzle),
    recurringInvoices: createRecurringInvoiceEngine(drizzle),
    // Sign-ins, token grants and revocations, exports and restores. Without
    // this the activity log can answer what happened to an invoice and not who
    // signed in and took a copy of the database. The capture result is the
    // written row, which the port has no use for.
    activity: {
      capture: async (request) => {
        await captureActivityEvent(drizzle, request);
      },
    },
    trackedResources: new DrizzleTrackedResourceRepository(
      drizzle,
      timesheetLockPolicy,
    ),
    isExpensesModuleEnabled: async () => {
      const row = await database
        .prepare(
          `SELECT COALESCE(json_extract(modules, '$.expenses'), 0) AS enabled
           FROM organizations WHERE id = 1`,
        )
        .first<{ enabled: number | boolean }>();
      return row?.enabled === 1 || row?.enabled === true;
    },
    moduleSettings: createModuleSettingsRepository(drizzle),
    organizationName,
    ssoProvisioningDomains: createD1SsoProvisioningDomainStore(database),
    // The #520 organisation setting, read the same way the other two module
    // gates are. Default off is the absence of the key: an instance that
    // upgrades has no `own_money` in its modules JSON and COALESCE answers 0,
    // so nobody starts seeing their rates because a deploy happened.
    isOwnMoneyVisible: async () => {
      const row = await database
        .prepare(
          `SELECT COALESCE(json_extract(modules, '$.own_money'), 0) AS enabled
           FROM organizations WHERE id = 1`,
        )
        .first<{ enabled: number | boolean }>();
      return row?.enabled === 1 || row?.enabled === true;
    },
    isTeamModuleEnabled: async () => {
      const row = await database
        .prepare(
          `SELECT COALESCE(json_extract(modules, '$.team'), 0) AS enabled
           FROM organizations WHERE id = 1`,
        )
        .first<{ enabled: number | boolean }>();
      return row?.enabled === 1 || row?.enabled === true;
    },
    timesheetApprovals: createTimesheetApprovalRepository(drizzle),
    timesheetLockPolicy,
    reports: createReportRepository(drizzle),
    cursorSigningKey,
    passwordAuth,
    userEmails: passwordAuth,
    sessions,
    authenticationSessions,
    emailLog,
    emailConfiguration,
    // Unlike portal auth, the second factor is opt-in on nothing: it holds no
    // deployment secret to get wrong, and a factor no one can turn on is not a
    // safe default -- it is the feature missing.
    twoFactor: createTwoFactorService({
      store: createD1TwoFactorStore(database),
      accountName: async (userId) =>
        (
          await database
            .prepare(
              `SELECT address FROM user_emails
                 WHERE user_id = ? AND invalidated_at IS NULL AND verified_at IS NOT NULL
                 ORDER BY is_primary DESC, id LIMIT 1`,
            )
            .bind(userId)
            .first<{ address: string }>()
        )?.address ?? `user-${userId}`,
      issuer: env.BRAND_NAME === undefined || env.BRAND_NAME === "" ? "ezacto" : env.BRAND_NAME,
    }),
    ...(magicLinkSigningKey === undefined
      ? {}
      : {
          portalAuth: {
            service: createMagicLinkService({
              database: {
                all: async (query: { sql: string; params: readonly unknown[] }) =>
                  (await database
                    .prepare(query.sql)
                    .bind(...query.params)
                    .all()).results as never[],
              },
              store: createD1MagicLinkStore(database),
              signingKey: magicLinkSigningKey,
            }),
            sessions: createPortalSessionService(createD1ContactSessionStore(database)),
            sessionStore: createD1ContactSessionStore(database),
          },
        }),
    ...(emailProvider instanceof SesMailer
      ? { senderIdentityVerifier: createSesSenderIdentityVerifier(emailProvider) }
      : emailProvider instanceof MailgunMailer && mailFrom !== undefined
        ? {
            senderIdentityVerifier: createMailgunSenderIdentityVerifier(
              emailProvider,
              mailFrom,
            ),
          }
        : {}),
    outbox,
    backupStatus: {
      latestRuns: (limit: number) => getLatestBackupRuns(database, limit),
    },
    // Composed only where the deployment carries Intuit keys. Without them the
    // routes are not mounted, because a connect button that cannot connect is
    // worse than no button -- `entry-surface.ts` declares that gating so both
    // halves of the contract guard know about it.
    ...(quickBooks === null ? {} : { quickBooks: quickBooks.service }),
    payoutAccounts: (() => {
      const store = createPayoutAccountStore(drizzle)
      return {
        listForUser: (userId: number) => store.listForUser(userId),
        link: async (input: {
          userId: number
          provider: 'deel' | 'wise'
          externalId: string
          linkedByUserId: number
        }) =>
          store.link({ ...input, now: new Date().toISOString() }),
        read: (id: number) => store.read(id),
        detach: (id: number) => store.detach(id, new Date().toISOString()),
      }
    })(),
    stripe,
    // Releasing is refused while the invoice stands; the store reports why
    // rather than letting a trigger abort reach the caller as a 500.
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
    identities,
    oidcTransactions: createD1OidcTransactionStore(database),
    ...(deploymentAuthMailer === undefined ? {} : { deploymentAuthMailer }),
    ...(organizationMailer === undefined ? {} : { organizationMailer }),
    ...(env.ATTACHMENTS === undefined
      ? {}
      : {
          attachments: {
            metadata: createAttachmentStore(drizzle),
            objects: createR2AttachmentObjectStore(env.ATTACHMENTS),
            authorizeOwnerAccess: createD1AttachmentOwnerAuthorizer(database),
          },
        }),
  };
};
