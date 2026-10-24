import { retryTransientD1IdempotentOperation } from '@ezacto/db/d1'
import { createOrganizationHolidayRepository } from '@ezacto/db/d1'
import { createWebhookSecretVault } from '@ezacto/core'
import { createWebhookService } from '@ezacto/db/d1'
import { createWorkerWebhookTransport } from '@ezacto/integrations'
import { createQueuedMigrationStore } from '@ezacto/db/queued-migrations'
import { createInvoiceElevationStore, unlinkElevatedInvoiceTime } from '@ezacto/db/d1'
import { createEstimateTemplateRepository } from '@ezacto/db/d1'
import { createWorkerOffsiteBackups } from './offsite-backups.js'
import { createScheduledRunDispatchService } from '@ezacto/db/d1'
import { prepareScheduledRunNotifications } from '@ezacto/db/d1'
import { createD1EmailSuppressionStore } from '@ezacto/db/d1'
import type { ReminderProcessOptions } from '@ezacto/db/d1'
import { createRuntimeAppleWeb } from './apple-web.js'
import { createD1AppleWebCustodyStore } from '@ezacto/db/d1'
import { captureException } from '@sentry/cloudflare'
import { createPaymentRunsService, createScheduledRunsService, createScheduledJobsService, proposeDueScheduledJobs } from '@ezacto/db/d1'
import { createWisePaymentProvider } from '@ezacto/integrations'
import { createContractorReviewStore, createStaffPaymentStore } from '@ezacto/db/d1'
import { createMyPaymentsStore } from '@ezacto/db/d1'
import {
  bootstrapInstanceD1,
  createAttachmentStore,
  enrollInstanceOwnerPasswordD1,
  createApiTokenStore,
  createD1Database,
  readUserIdentity,
  readUserTimezone,
  readEffectiveUserTimezone,
  updateUserTimezone,
  createD1IdentityStore,
  createD1OidcTransactionStore,
  createD1OidcAppCodeStore,
  createD1StaffMagicLinkStore,
  createD1StaffUserDirectory,
  createD1OutboxService,
  createQuickBooksMirrorSource,
  createQuickBooksReconciliationSource,
  createQuickBooksStore,
  createGeneralResourceRepository,
  recoverProjectMissingRates,
  createMoneyResourceRepository,
  listClientAncestors,
  createClientRateCardRepository,
  listClientDescendants,
  createInvoiceGenerationService,
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
  createD1EmailLogStore,
  createD1EmailFeedbackLedger,
  createD1EmailConfigurationStore,
  createD1PasswordAuthService,
  createD1SessionStore,
  lastSeenIntervalFromSeconds,
  createD1SsoProvisioningDomainStore,
  DrizzleAllocationRepository,
  DrizzleCalendarProposalRepository,
  DrizzleWorkItemRepository,
  DrizzleTrackedResourceRepository,
  allowBackupDownloadRequest,
  consumeBackupDownloadLink,
  getBackupRun,
  latestCompletedBackupRunId,
  mintBackupDownloadLink,
  openBackupArchive,
  r2BackupSource,
  countBackupRuns,
  getBackupRunsSnapshot,
  getLatestBackupRuns,
  pageBackupRuns,
  migrateD1,
  createD1ContactSessionStore,
  createD1MagicLinkStore,
  createMagicLinkService,
  createD1TwoFactorStore,
  backfillBandClaims,
  backfillCostRates,
  requestAccountDeletion,
  createRecurringInvoiceEngine,
  createD1ReminderScheduler,
  captureActivityEvent,
  createActivityRoll,
  createTwoFactorService,
  deriveTwoFactorEmailCodeKey,
  createBillLinkStore,
  createBillMirrorSource,
  createPayoutAccountStore,
  createPayoutProviderEnablementStore,
  createPayoutPreferenceStore,
  createWiseDeliveryStore,
  createDeelSyncSettingsStore,
  createDeelSyncStore,
  createStripeLinkStore,
  readAttachPreference,
  readFilesPreference,
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
  updateInvoiceDefaults,
  createInvoiceViewLinkIssuer,
  createInvoiceViewService,
  invoiceViewLinkOrigin,
  readViewReceipts,
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
  updateNotificationSettings,
  readTimesheetAutoApproval,
  runTimesheetAutoApproval,
  createScheduledActionStore,
  sweepExpiredRuns,
  updateTimesheetAutoApproval,
  setBillDelivery,
  createD1IdempotencyStore,
  createIdempotentD1,
} from "@ezacto/db/d1";
import { createPortalSessionService, type BandClaimBackfillPort, type CostRateBackfillPort } from "@ezacto/api";
import { deriveIdempotencySecret, emailBrandFrom, withEmailBrand } from "@ezacto/api";
import {
  createApiSessionService,
  createCloudflareAccessSessionResolver,
  createCloudflareAccessVerifier,
  createBudgetAlertSubscriber,
  createTimeReminderService,
  createNotificationSettingsService,
  createTimesheetAutoApprovalService,
  createInvoiceEmailOutboxSubscriber,
  createInvoiceThankYouSubscriber,
  thankYouInvoiceFromDeliveryContext,
  invoicePaymentUrlForMail,
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
  createMailgunFeedbackService,
  SesMailer,
  configuredEmailSender,
  createRecipientAllowlistQueue,
  type EmailQueue,
  type HttpEmailProvider,
  type MailgunOptions,
  type SesMailerOptions,
  EMAIL_LOG_KIND_TEMPLATES,
} from "@ezacto/mailer";
import { createInvoiceDocumentPort } from './invoice-documents.js';
import type { AppEnv, RuntimeServices } from "./app.js";
import { workerBrandAssetSurface } from "./brand-assets.js";
import { workerInstanceThemeSurface } from "./instance-theme.js";
import {
  cloudflareAccessConfig,
  DEMO_API_TOKEN_MAX_LIFETIME_MS,
  demoDeployment,
  workItemCredentialConfigured,
  demoMailDomains,
  type WorkerEnv,
} from "./app.js";
import {
  createBillMirrorSubscriber,
  createBillRuntime,
  createStripeRuntime,
  createQuickBooksMirrorSubscriber,
  createQuickBooksRuntime,
  createWiseRuntime,
  createDeelSyncRuntime,
} from "@ezacto/integrations";
import {
  createCloudflareEmailQueue,
  createWorkerDeploymentAuthMailer,
  createWorkerAccountDeletionMailer,
  createWorkerNotificationMailer,
  createWorkerOrganizationMailer,
  createWorkerStaffMagicLinkMailer,
  createWorkerPortalMagicLinkMailer,
  createWorkerTwoFactorEmailCodeMailer,
} from "./email-queue.js";
import { demoRefusal } from "./demo-lockdown.js";

const cursorSecretPattern = /^[A-Za-z0-9_-]+$/;
const cursorSecretBytes = 32;

const readyDatabases = new WeakSet<object>();
const ordinaryDatabases = new WeakSet<object>();

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
 * only removes repeat checks after success. Pending D1 I/O belongs to the
 * initiating request: sharing its promise can strand another request when that
 * invocation ends. Concurrent cold requests run their own atomic ledger check;
 * a failure or canceled request never marks the database ready.
 */
export const ensureRuntimeDatabaseReady = async (
  database: D1Database,
): Promise<void> => {
  const identity = database as object;
  if (readyDatabases.has(identity)) return;
  await migrateD1(database);
  if (
    await database
      .prepare('SELECT 1 FROM account_restore_quarantine WHERE id=1 AND quarantined=1')
      .first()
  ) {
    throw new Error('Restored privacy evidence must be reconciled before this instance serves traffic.');
  }
  readyDatabases.add(identity);
};

/** Empty destinations are rechecked until a normal instance is irreversibly populated. */
export const ensureOrdinaryMigrationAccess = async (database: D1Database, cachePopulated = true): Promise<void> => {
  if (cachePopulated && ordinaryDatabases.has(database)) return;
  // Both observations belong to one SQL snapshot: an import cannot win between them.
  const access = await createQueuedMigrationStore(database).access();
  if (access.blocked) throw new Error("Queued migration target is quarantined.");
  if (cachePopulated && access.populated) ordinaryDatabases.add(database);
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

/** The secrets that let this deployment reach a payment or accounting provider. */
type ProviderCredentials = Pick<
  WorkerEnv,
  | "QUICKBOOKS_CLIENT_ID"
  | "QUICKBOOKS_CLIENT_SECRET"
  | "QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN"
  | "WISE_TOKEN"
  | "WISE_PROFILE_ID"
  | "WISE_WEBHOOK_PUBLIC_KEY"
  | "BILL_DEV_KEY"
  | "BILL_COMPANY_ID"
  | "BILL_USERNAME"
  | "BILL_PASSWORD"
  | "BILL_REPLY_TO_USER_ID"
  | "STRIPE_API_KEY"
  | "STRIPE_WEBHOOK_SECRET"
  | "MAILGUN_WEBHOOK_SIGNING_KEY"
  | "DEEL_TOKEN"
  | "DEEL_SYNC_START_DATE"
>;

/**
 * None at all on the public demo (#931), whatever secrets the deployment
 * carries. Every runtime below is composed from this, so on the demo each one
 * reports itself unconfigured: QuickBooks and Wise are not mounted, BILL and
 * Stripe say they are not set up and mint no link, no mirror subscribes, no
 * payout can be quoted, and the hourly and minutely crons have no account to
 * call. The routes that would change any of it are refused outright as well --
 * see `demo-lockdown.ts` -- but this is the half that holds for code paths
 * nobody thought to list.
 */
export const providerCredentials = (env: WorkerEnv): ProviderCredentials =>
  demoDeployment(env) ? {} : env;

/**
 * Object storage the demo reads and never writes (#931). The upload routes are
 * refused before they get here; this refuses with the same answer whatever
 * route reaches it, including one added after that list was written.
 */
const readOnlyObjects = (objects: AttachmentObjectPort): AttachmentObjectPort => ({
  get: (key) => objects.get(key),
  put: async () => {
    throw demoRefusal();
  },
});

export const createRuntimeServices = async (
  env: WorkerEnv,
  options: {
    emailProvider?: HttpEmailProvider;
    ses?: SesMailerOptions;
    mailgun?: MailgunOptions;
    cloudflareAccessFetch?: CloudflareAccessFetch;
    /** Scheduled ticks retry only ledger-fenced readiness, never service effects. */
    retryReadiness?: boolean;
  } = {},
): Promise<RuntimeServices> => {
  const binding = requireDatabase(env);
  // Every service below writes through this: in a request that carries an
  // Idempotency-Key, each write commits with the key's claim (issue 952).
  // Stable per binding, so the readiness cache below still keys on it.
  const database = createIdempotentD1(binding);
  const demo = demoDeployment(env);
  const credentials = providerCredentials(env);
  const cursorSigningKey = parseCursorSigningKey(env.API_CURSOR_SIGNING_KEY);
  // Portal magic-link auth is opt-in on the presence of its key. An install
  // that has not set one does not serve the routes at all, rather than serving
  // them with a weak or absent secret -- the routes hand out sessions, so
  // "configured badly" and "not configured" must not look the same.
  const magicLinkSigningKey =
    env.MAGIC_LINK_SIGNING_KEY === undefined || env.MAGIC_LINK_SIGNING_KEY === ""
      ? undefined
      : parseCursorSigningKey(env.MAGIC_LINK_SIGNING_KEY);
  // Its own key, not the staff one. Sharing `MAGIC_LINK_SIGNING_KEY` meant
  // turning staff magic-link on also turned on a contact-auth surface that the
  // standalone portal worker superseded and nothing calls.
  const portalMagicLinkSigningKey =
    env.PORTAL_MAGIC_LINK_SIGNING_KEY === undefined ||
    env.PORTAL_MAGIC_LINK_SIGNING_KEY === ""
      ? undefined
      : parseCursorSigningKey(env.PORTAL_MAGIC_LINK_SIGNING_KEY);
  if (options.retryReadiness) {
    await retryTransientD1IdempotentOperation(() => ensureRuntimeDatabaseReady(database));
  } else {
    await ensureRuntimeDatabaseReady(database);
  }
  // The nightly demo wipe can make a populated database empty again.
  await ensureOrdinaryMigrationAccess(binding, !demo);
  const drizzle = createD1Database(database);
  const timesheetLockPolicy = createTimesheetLockPolicyRepository(drizzle);
  const trackedResources = new DrizzleTrackedResourceRepository(drizzle, timesheetLockPolicy);
  const touchIntervalMs = lastSeenIntervalFromSeconds(env.LAST_SEEN_INTERVAL_SECONDS);
  const sessions = createApiSessionService(
    createD1SessionStore(database, { touchIntervalMs }),
  );
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
  const emailLog = createD1EmailLogStore(database, { kindTemplates: EMAIL_LOG_KIND_TEMPLATES });
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
  // Where every message this deployment composes goes next, and so the one
  // place the demo holds them to its allowlist (#931): composed, validated and
  // logged as anywhere, then queued for the allowed recipients alone, or ended
  // `failed` where none is allowed. Every mailer below is built on this, so a
  // mail path added later is held to the list without anyone remembering it.
  const mailDomains = demoMailDomains(env);
  const emailQueue: EmailQueue | undefined =
    env.EMAIL_QUEUE === undefined
      ? undefined
      : withEmailBrand(
          mailDomains === null
            ? createCloudflareEmailQueue(env.EMAIL_QUEUE)
            : createRecipientAllowlistQueue(
                createCloudflareEmailQueue(env.EMAIL_QUEUE),
                emailLog,
                mailDomains,
              ),
          // HTML mail wears the instance header (#1011): read when each
          // message is queued, so a changed logo or colour reaches the next send.
          async () =>
            env.APP_BASE_URL === undefined
              ? null
              : emailBrandFrom(
                  {
                    assets: await workerBrandAssetSurface.list(env as AppEnv),
                    palette: (await workerInstanceThemeSurface.read(env as AppEnv))?.palette ?? null,
                    organizationName: await organizationName(),
                  },
                  env.APP_BASE_URL,
                ),
        );
  const mailFrom = resolveMailFrom(env);
  const deploymentAuthMailer =
    !emailQueueReady || mailFrom === undefined
      ? undefined
      : createWorkerDeploymentAuthMailer(
          emailQueue!,
          emailLog,
          mailFrom,
          emailConfiguration,
          organizationName,
          env.APP_BASE_URL!,
        );
  const staffMagicLinkMailer =
    !emailQueueReady || mailFrom === undefined
      ? undefined
      : createWorkerStaffMagicLinkMailer(
          emailQueue!,
          emailLog,
          mailFrom,
          organizationName,
        );
  const portalMagicLinkMailer =
    !emailQueueReady || mailFrom === undefined ? undefined : createWorkerPortalMagicLinkMailer(
      emailQueue!, emailLog, mailFrom, organizationName, env.APP_BASE_URL!,
    );
  const twoFactorEmailCodeMailer =
    !emailQueueReady || mailFrom === undefined
      ? undefined
      : createWorkerTwoFactorEmailCodeMailer(
          emailQueue!,
          emailLog,
          mailFrom,
          organizationName,
        );
  const accountDeletionMailer =
    !emailQueueReady || mailFrom === undefined
      ? undefined
      : createWorkerAccountDeletionMailer(
          emailQueue!,
          emailLog,
          mailFrom,
          organizationName,
        );
  const organizationMailer =
    !emailTransportReady
      ? undefined
      : createWorkerOrganizationMailer(
          emailQueue!,
          emailLog,
          emailProvider.name,
          emailConfiguration,
        );
  // The mail the instance sends its own people (budget alerts, issue 934). On
  // the deployment sender, so it needs the same From and queue the sign-in mail
  // does; without them the alert is still recorded and shown in the activity
  // log, and there is simply nobody to mail it through.
  const notificationMailer =
    !emailQueueReady || mailFrom === undefined
      ? undefined
      : createWorkerNotificationMailer(emailQueue!, emailLog, mailFrom);
  // Time reminders and the week-end submission reminders (issue 935): the
  // same deployment sender, and the instance's own address for the links.
  const timeReminders =
    notificationMailer === undefined || env.APP_BASE_URL === undefined
      ? undefined
      : createTimeReminderService(
          {
            prepare: (now: string) =>
              prepareTimeReminders(drizzle, {
                now,
                from: notificationMailer.from,
                appUrl: env.APP_BASE_URL!,
              }),
          },
          notificationMailer,
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
    credentials.QUICKBOOKS_CLIENT_ID === undefined ||
    credentials.QUICKBOOKS_CLIENT_SECRET === undefined
      ? null
      : createQuickBooksRuntime({
          config: {
            clientId: credentials.QUICKBOOKS_CLIENT_ID,
            clientSecret: credentials.QUICKBOOKS_CLIENT_SECRET,
            webhookVerifierToken: credentials.QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN,
            environment: env.QUICKBOOKS_ENVIRONMENT,
            appBaseUrl: env.APP_BASE_URL,
          },
          store: createQuickBooksStore(drizzle),
          source: createQuickBooksMirrorSource(drizzle, () => new Date()),
          reconciliation: createQuickBooksReconciliationSource(drizzle),
          fetch: (request: Request) => fetch(request),
          now: () => new Date(),
        });

  // Same gating, and for the same reason: a connect button that cannot connect
  // is worse than no button. `entry-surface.ts` declares it so both halves of
  // the contract guard agree.
  const paymentRuns = createPaymentRunsService(
    drizzle,
    credentials.WISE_TOKEN === undefined
      ? null
      : createWisePaymentProvider({
          token: credentials.WISE_TOKEN,
          profileId: credentials.WISE_PROFILE_ID,
          fetch: (input, init) => fetch(input as RequestInfo, init as RequestInit),
        }),
    (error, context) => {
      captureException(error, { tags: { component: 'payment-processing', ...context } })
    },
  )
  const wise =
    credentials.WISE_TOKEN === undefined
      ? null
      : createWiseRuntime({
          config: {
            token: credentials.WISE_TOKEN,
            profileId: credentials.WISE_PROFILE_ID,
            webhookPublicKey: credentials.WISE_WEBHOOK_PUBLIC_KEY,
          },
          accounts: (() => {
            const store = createPayoutAccountStore(drizzle);
            return {
              listForUser: (userId: number) => store.listForUser(userId),
              listForProvider: (provider: "wise") => store.listForProvider(provider),
              awaitingDestination: (provider: "wise") => store.awaitingDestination(provider),
              link: (input: {
                userId: number;
                provider: "wise";
                externalId: string;
                kind?: "account" | "contact";
                linkedByUserId: number;
                now: string;
              }) => store.link(input),
              markVerified: (id: number, now: string) => store.markVerified(id, now),
              detach: (id: number, now: string) => store.detach(id, now),
            };
          })(),
          deliveries: createWiseDeliveryStore(drizzle),
          fetch: (input, init) => fetch(input as RequestInfo, init as RequestInit),
          now: () => new Date(),
        });

  // Composed whenever the deployment carries BILL credentials. Unlike
  // QuickBooks there is nothing to connect -- BILL has no OAuth -- so the
  // routes mount either way and say whether they can reach anything; what
  // changes with the credential is only whether a mirror can run.
  const bill = createBillRuntime({
    config: {
      devKey: credentials.BILL_DEV_KEY,
      companyId: credentials.BILL_COMPANY_ID,
      username: credentials.BILL_USERNAME,
      password: credentials.BILL_PASSWORD,
      replyToUserId: credentials.BILL_REPLY_TO_USER_ID,
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
      apiKey: credentials.STRIPE_API_KEY,
      webhookSecret: credentials.STRIPE_WEBHOOK_SECRET,
    },
    source: {
      readInvoice: async (invoiceId: number) => {
        const rows = await database
          .prepare(
            `SELECT id, number, currency, due_amount_cents AS due,
               EXISTS (SELECT 1 FROM json_each(payment_options)
                       WHERE value = 'stripe_checkout') AS card
             FROM invoices WHERE id = ?`,
          )
          .bind(invoiceId)
          .all<{ id: number; number: string; currency: string; due: number; card: number }>()
        const row = rows.results[0]
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

  // The document an invoice carries, composed where the storage is. Absent
  // without an attachments bucket, in which case the subscriber is given no
  // port and sends exactly what it sent before (issue 626).
  const invoiceDocuments =
    env.ATTACHMENTS === undefined
      ? undefined
      : createInvoiceDocumentPort({
          database: drizzle,
          objects: createR2AttachmentObjectStore(env.ATTACHMENTS),
          accentColor: async () =>
            (await workerInstanceThemeSurface.read(env as AppEnv))?.palette?.['action'] ?? null,
          now: () => new Date().toISOString(),
          source: {
            documentContext: (invoiceId: number) =>
              moneyResources.getInvoiceDocumentContext(invoiceId),
            invoiceVersion: async (invoiceId: number) => {
              const rows = await database
                .prepare(`SELECT version FROM invoices WHERE id = ?`)
                .bind(invoiceId)
                .all<{ version: number }>();
              return rows.results[0]?.version ?? null;
            },
            paymentUrl: invoicePaymentUrlForMail({ bill, stripe }),
          },
        });

  // The thank-you an invoice sends when it settles (issue 545). Subscribes to
  // `invoice.paid`, which the reducer emits only when the payment status
  // actually changes to paid -- so a part payment reaches nothing here.
  const thankYou = createThankYouPort({
    database: drizzle,
    configuration: emailConfiguration,
    invoices: {
      read: async (invoiceId: number) => {
        const context = await moneyResources.getInvoiceDeliveryContext(invoiceId);
        return context === null ? null : thankYouInvoiceFromDeliveryContext(context);
      },
    },
    now: () => new Date().toISOString(),
  });

  // The reminder an overdue invoice sends (issue 801). The scheduler above
  // books and cancels rows; this is what turns a row that has come due into a
  // message, and `processDueReminders` below is the only caller.
  const reminderPort = createReminderPort({
    database: drizzle,
    configuration: emailConfiguration,
    invoices: {
      read: async (invoiceId: number) => {
        const context = await moneyResources.getInvoiceDeliveryContext(invoiceId);
        return context === null ? null : thankYouInvoiceFromDeliveryContext(context);
      },
      paymentUrl: invoicePaymentUrlForMail({ bill, stripe }),
    },
    now: () => new Date().toISOString(),
  });
  const processDueReminders = (now: string, options: ReminderProcessOptions = {}) =>
    reminders.processReminders({
      ...options,
      now,
      send: async (reminder) => {
        const message = await reminderPort.prepare(reminder);
        // Nothing to send is an answer the port has already recorded the
        // reason for -- the row is left pending and looked at again tomorrow,
        // by which time the sender or the template may exist.
        if (message === null) throw new Error("reminder has nothing to send");
        if (organizationMailer?.enqueuePersisted === undefined) {
          throw new Error("reminder durable enqueue is unavailable");
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
              person.name === "" ? { email: person.email } : { email: person.email, name: person.name },
            ),
            // Whoever the invoice copied is copied on its reminders.
            ...(message.cc.length === 0
              ? {}
              : {
                  cc: message.cc.map((person) =>
                    person.name === ""
                      ? { email: person.email }
                      : { email: person.email, name: person.name },
                  ),
                }),
            template: `reminder:${String(message.templateVersion)}`,
            subject: message.subject,
            text: message.textBody,
            ...(message.htmlBody === null ? {} : { html: message.htmlBody }),
            related: { type: "invoice", id: reminder.invoiceId },
          },
        );
      },
    });

  const outbox = createD1OutboxService(database, {
    additionalSubscribers: [
      createInvoiceEmailOutboxSubscriber(
        moneyResources,
        organizationMailer,
        invoiceDocuments,
      ),
      createInvoiceThankYouSubscriber(thankYou, organizationMailer),
      ...(notificationMailer === undefined
        ? []
        : [
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
          ]),
      reminders.subscriber,
      ...(quickBooks === null ? [] : [createQuickBooksMirrorSubscriber(quickBooks)]),
      createBillMirrorSubscriber(bill),
    ],
  });
  const twoFactor = createTwoFactorService({
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
    // The emailed second factor (issue 770). Its hash key is derived from the
    // cursor signing key every deployment already has, so there is no new
    // secret to provision, and it goes to the person's own verified address.
    emailCodeKey: await deriveTwoFactorEmailCodeKey(cursorSigningKey),
    emailAddress: async (userId) =>
      (
        await database
          .prepare(
            `SELECT address FROM user_emails
               WHERE user_id = ? AND invalidated_at IS NULL AND verified_at IS NOT NULL
               ORDER BY is_primary DESC, id LIMIT 1`,
          )
          .bind(userId)
          .first<{ address: string }>()
      )?.address ?? null,
  })

  const offsiteBackupSync = await createWorkerOffsiteBackups(drizzle,env)
  const scheduledObjects = env.ATTACHMENTS === undefined ? undefined : createR2AttachmentObjectStore(env.ATTACHMENTS)
  const scheduledRunDispatch = scheduledObjects === undefined || organizationMailer?.enqueuePersisted === undefined
    ? undefined : createScheduledRunDispatchService(drizzle, {
      sender: async () => {
        await organizationMailer!.assertAvailable()
        const sender = await emailConfiguration.resolveSenderIdentity()
        if (!sender?.evidence) throw new Error('A verified sender identity is required for month-end delivery.')
        return {
          senderIdentityId: sender.id, senderIdentityVersion: sender.version, senderEvidenceVersion: sender.evidence.version,
          from: { email: sender.email, name: sender.displayName },
          ...(sender.replyToEmail === null ? {} : { replyTo: [{ email: sender.replyToEmail }] }),
        }
      },
      enqueue: organizationMailer.enqueuePersisted.bind(organizationMailer),
      readBytes: async (key: string) => {
        const object = await scheduledObjects.get(key)
        return object === null ? null : new Uint8Array(await new Response(object.body).arrayBuffer())
      },
      now: () => new Date().toISOString(),
    })
  return {
    bootstrap: (input) => bootstrapInstanceD1(database, input),
    enrollOwnerPassword: (input) =>
      enrollInstanceOwnerPasswordD1(database, input),
    // The demo hands its credentials to strangers, so a token minted there gets
    // a ceiling; everywhere else a token lives until someone revokes it.
    tokens: createApiTokenStore(drizzle, {
      touchIntervalMs,
      ...(demoDeployment(env) ? { maxLifetimeMs: DEMO_API_TOKEN_MAX_LIFETIME_MS } : {}),
    }),
    projectMissingRates: { recover: input => recoverProjectMissingRates(drizzle, input, dates => timesheetLockPolicy.lockedDates(dates)) },
    generalResources: createGeneralResourceRepository(drizzle),
    clientTree: {
      ancestors: (clientId) => listClientAncestors(drizzle, clientId),
      descendants: (clientId) => listClientDescendants(drizzle, clientId),
    },
    team: createTeamRepository(drizzle),
    invoiceElevations: createInvoiceElevationStore(drizzle),
    invoiceTimeUnlink: (command, elevation, now) => unlinkElevatedInvoiceTime(drizzle, command, elevation, now),
    webhooks: createWebhookService(drizzle, {
      vault: !demoDeployment(env) && env.WEBHOOK_ENCRYPTION_KEY ? await createWebhookSecretVault(env.WEBHOOK_ENCRYPTION_KEY) : null,
      transport: createWorkerWebhookTransport(),
    }),
    migrationLoads: createQueuedMigrationStore(binding),
    estimateTemplates: createEstimateTemplateRepository(drizzle),
    clientRateCards: createClientRateCardRepository(drizzle),
    moneyResources,
    invoiceGeneration: createInvoiceGenerationService(drizzle),
    recurringInvoices: createRecurringInvoiceEngine(drizzle),
    reminders: { processDue: processDueReminders },
    budgetAlerts: { evaluate: (now: string) => evaluateProjectBudgetAlerts(drizzle, now) },
    ...(timeReminders === undefined ? {} : { timeReminders }),
    timesheetAutoApproval: createTimesheetAutoApprovalService({
      read: () => readTimesheetAutoApproval(drizzle),
      update: (actorUserId, patch) =>
        updateTimesheetAutoApproval(drizzle, actorUserId, patch, new Date().toISOString()),
    }),
    timesheetAutoApprovalSweep: {
      processDue: (now: string) => runTimesheetAutoApproval(drizzle, now),
    },
    scheduledActionExpiry: {
      expireDue: (now: string, report: (error: unknown) => void) =>
        sweepExpiredRuns(createScheduledActionStore(drizzle), now, report),
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
    // Invoices › Configure: what every invoice prints and every draft starts with.
    invoiceDefaults: {
      read: () => readInvoiceDefaults(drizzle),
      update: (patch: Parameters<typeof updateInvoiceDefaults>[1]) =>
        updateInvoiceDefaults(drizzle, patch, new Date().toISOString()),
    },
    // #712. Adapted rather than passed through: the port declares the shape the
    // route needs, and the reader takes the database as its first argument.
    bandClaimBackfill: {
      backfill: (input: Parameters<BandClaimBackfillPort['backfill']>[0]) =>
        backfillBandClaims(drizzle, input),
    },
    // #750. Same adaptation, for pricing the cost of hours tracked before a rate.
    costRateBackfill: {
      backfill: (input: Parameters<CostRateBackfillPort['backfill']>[0]) =>
        backfillCostRates(drizzle, input),
    },
    // Sign-ins, token grants and revocations, exports and restores. Without
    // this the activity log can answer what happened to an invoice and not who
    // signed in and took a copy of the database. The capture result is the
    // written row, which the port has no use for.
    activity: {
      capture: async (request) => {
        await captureActivityEvent(drizzle, request);
      },
    },
    activityRoll: createActivityRoll(drizzle, () => new Date().toISOString()),
    trackedResources,
    calendarProposals: new DrizzleCalendarProposalRepository(drizzle, trackedResources),
    allocations: new DrizzleAllocationRepository(drizzle),
      organizationHolidays: createOrganizationHolidayRepository(drizzle),
    workItems: {
      repository: new DrizzleWorkItemRepository(drizzle),
      credentialConfigured: (provider) => workItemCredentialConfigured(env, provider),
    },
    profile: {
      readTimezone: async (userId) => await readUserTimezone(drizzle, userId),
      readEffectiveTimezone: async (userId) => await readEffectiveUserTimezone(drizzle, userId),
      readIdentity: async (userId) => await readUserIdentity(drizzle, userId),
      updateTimezone: async (userId, timezone, occurredAt) => {
        await updateUserTimezone(drizzle, userId, timezone, occurredAt);
      },
      // Whether this person is copied on the invoice emails they send.
      readInvoiceCopy: async (userId) => (await readInvoiceSenderCopy(drizzle, userId))?.copy ?? null,
      updateInvoiceCopy: async (userId, copy, occurredAt) => {
        await setInvoiceSenderCopy(drizzle, userId, copy, occurredAt);
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
      const row = await database
        .prepare(
          `SELECT COALESCE(json_extract(modules, '$.expenses'), 0) AS enabled
           FROM organizations WHERE id = 1`,
        )
        .first<{ enabled: number | boolean }>();
      return row?.enabled === 1 || row?.enabled === true;
    },
    moduleSettings: createModuleSettingsRepository(drizzle),
    signInMethods: createSignInMethodRepository(drizzle),
    accountRetention: createAccountRetentionRepository(drizzle),
    accountDeletionRequests: createAccountDeletionRequestRepository(drizzle),
    accountClosure: createAccountClosureRepository(drizzle),
    accountRetentionReview: createAccountRetentionReviewRepository(drizzle),
    nativeAppleLifecycle: createAppleLifecycleRepository(drizzle),
    accountDeletionTracking: createAccountDeletionStatusRepository(drizzle),
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
    isActivityLogModuleEnabled: async () => {
      const row = await database
        .prepare(
          `SELECT COALESCE(json_extract(modules, '$.activity_log'), 1) AS enabled
           FROM organizations WHERE id = 1`,
        )
        .first<{ enabled: number | boolean }>();
      return row === null || row.enabled === 1 || row.enabled === true;
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
    idempotency: {
      // The binding itself: the store's own statements never carry a claim.
      store: createD1IdempotencyStore(binding),
      secret: await deriveIdempotencySecret(cursorSigningKey),
    },
    passwordAuth,
    userEmails: passwordAuth,
    sessions,
    authenticationSessions,
    emailLog,
    emailSuppressions: createD1EmailSuppressionStore(database),
    emailConfiguration,
    // Unlike portal auth, the second factor is opt-in on nothing: it holds no
    // deployment secret to get wrong, and a factor no one can turn on is not a
    // safe default -- it is the feature missing.
    twoFactor,
    ...(twoFactorEmailCodeMailer === undefined
      ? {}
      : { twoFactorEmailCodes: twoFactorEmailCodeMailer }),
    ...(portalMagicLinkSigningKey === undefined
      ? {}
      : {
          portalAuth: {
            ...(portalMagicLinkMailer === undefined ? {} : {mailer:portalMagicLinkMailer}),
            service: createMagicLinkService({
              database: {
                all: async (query: { sql: string; params: readonly unknown[] }) =>
                  (await database
                    .prepare(query.sql)
                    .bind(...query.params)
                    .all()).results as never[],
              },
              store: createD1MagicLinkStore(database),
              signingKey: portalMagicLinkSigningKey,
            }),
            sessions: createPortalSessionService(
              createD1ContactSessionStore(database, { touchIntervalMs }),
            ),
            sessionStore: createD1ContactSessionStore(database, { touchIntervalMs }),
            estimates: {
              list: (clientId: number) => moneyResources.listCustomerEstimates(clientId),
              get: (clientId: number, estimateId: number) =>
                moneyResources.getCustomerEstimate(clientId, estimateId),
              respond: (input) =>
                moneyResources.respondToEstimate({ ...input, occurredAt: new Date().toISOString() }),
            },
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
    // The signed download of a nightly bundle (issue 39). Mounted wherever
    // backup status is, like it; a deployment with no bucket still answers, and
    // every download is the same plain refusal because there is no bundle.
    backupDownloads: {
      origin: invoiceViewLinkOrigin(env.APP_BASE_URL),
      allow: (scope: 'mint' | 'redeem', key: string, now: string) =>
        allowBackupDownloadRequest(drizzle, scope, key, now),
      latestCompletedRunId: () => latestCompletedBackupRunId(drizzle),
      mint: (input: { backupRunId: number; userId: number; now: string }) =>
        mintBackupDownloadLink(drizzle, input),
      redeem: (token: string, now: string) => consumeBackupDownloadLink(drizzle, token, now),
      openArchive: async (backupRunId: number) => {
        if (env.ATTACHMENTS === undefined) throw new Error('no bucket holds the backups')
        const run = await getBackupRun(database, backupRunId)
        if (run === null) throw new Error('backup run not found')
        return {
          stream: await openBackupArchive(run, r2BackupSource(env.ATTACHMENTS)),
          filename: `ezacto-backup-${run.started_at.slice(0, 10)}.zip`,
        }
      },
      secondFactor: {
        isEnrolled: (userId: number) => twoFactor.isEnrolled(userId),
        verifyCode: (userId: number, code: string) => twoFactor.verifyCode(userId, code),
      },
    },
    offsiteBackupSync,
    backupStatus: {
      offsiteStatus: () => offsiteBackupSync.status(),
      checkOffsite: () => offsiteBackupSync.checkDestination(),
      latestRuns: (limit: number) => getLatestBackupRuns(database, limit),
      runsSnapshot: () => getBackupRunsSnapshot(database),
      pageRuns: (window) => pageBackupRuns(database, window),
      countRuns: (filter) => countBackupRuns(database, filter),
    },
    // Composed only where the deployment carries Intuit keys. Without them the
    // routes are not mounted, because a connect button that cannot connect is
    // worse than no button -- `entry-surface.ts` declares that gating so both
    // halves of the contract guard know about it.
    ...(quickBooks === null ? {} : { quickBooks: quickBooks.service }),
    ...(wise === null ? {} : { wise: wise.service }),
    ...(wise?.webhook === undefined ? {} : { wiseWebhook: wise.webhook }),
    // Mailgun's event webhook is composed only where the signing key is set.
    // Without it the route is not mounted and answers 404, so an unsigned post
    // is never read.
    ...(credentials.MAILGUN_WEBHOOK_SIGNING_KEY === undefined ||
    credentials.MAILGUN_WEBHOOK_SIGNING_KEY === ""
      ? {}
      : {
          mailgunFeedback: createMailgunFeedbackService({
            signingKey: credentials.MAILGUN_WEBHOOK_SIGNING_KEY,
            log: emailLog,
            ledger: createD1EmailFeedbackLedger(database),
          }),
        }),
    paymentRuns,
    scheduledRunNotices: notificationMailer === undefined || env.APP_BASE_URL === undefined
      ? undefined
      : createTimeReminderService({
          prepare: (now: string) => prepareScheduledRunNotifications(drizzle, { reviewLinkSigningKey: cursorSigningKey,
            now, from: notificationMailer.from, appUrl: env.APP_BASE_URL!,
          }),
        }, notificationMailer),
    scheduledJobs: createScheduledJobsService(drizzle),
    scheduledRunDispatch,
    scheduledJobProposals: { processDue: (now: string) => proposeDueScheduledJobs(drizzle, now, scheduledObjects ?? {
      put: async () => { throw new Error('Configure attachment storage before proposing a month-end report.') },
    }) },
    scheduledRuns: createScheduledRunsService(drizzle, {reviewLinkSigningKey:cursorSigningKey}),
    staffPayments: createStaffPaymentStore(drizzle),
    contractorReview: createContractorReviewStore(drizzle),
    myPayments: createMyPaymentsStore(drizzle),
    payoutProviderEnablement: createPayoutProviderEnablementStore(drizzle),
    payoutPreferences: createPayoutPreferenceStore(drizzle),
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
    // Who an invoice email reaches and what it carries, as standing rules: the
    // client's lists or its contacts' routing, the organization's copies, and
    // the template the Send dialog opens on.
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
    ...(invoiceDocuments === undefined ? {} : { invoiceDocuments }),
    // The hosted invoice page and its receipts (issue 936). The page is always
    // mounted -- a link only exists once a send minted one -- and the link is
    // minted only where there is a configured origin to point it at.
    invoiceView: createInvoiceViewService({
      database: drizzle,
      paymentUrl: invoicePaymentUrlForMail({ bill, stripe }),
      ...(env.ATTACHMENTS === undefined
        ? {}
        : {
            readDocument: async (key: string) => {
              const object = await createR2AttachmentObjectStore(env.ATTACHMENTS!).get(key);
              return object === null
                ? null
                : new Uint8Array(await new Response(object.body).arrayBuffer());
            },
          }),
    }),
    ...(invoiceViewLinkOrigin(env.APP_BASE_URL) === null
      ? {}
      : {
          invoiceViewLinks: createInvoiceViewLinkIssuer(
            drizzle,
            invoiceViewLinkOrigin(env.APP_BASE_URL)!,
          ),
        }),
    invoiceViewReceipts: (invoiceMessageIds: readonly number[]) =>
      readViewReceipts(drizzle, invoiceMessageIds),
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
    // Suppressing the thank-you for one invoice, which is the half that has to
    // be reachable before the payment lands: some invoices settle a dispute.
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
    // Always composed; it reports itself unconfigured, and does nothing, until
    // the deployment carries both a token and a start date. Never on the demo,
    // whose `credentials` are empty.
    deelSyncAdmin: {
      settings: createDeelSyncSettingsStore(drizzle),
      recentRuns: createDeelSyncStore(drizzle).recentRuns,
    },
    deelSync: createDeelSyncRuntime({
      config: {
        token: credentials.DEEL_TOKEN,
        startDate: credentials.DEEL_SYNC_START_DATE,
      },
      source: createDeelSyncStore(drizzle),
      settings: createDeelSyncSettingsStore(drizzle),
      fetch: (request: Request) => fetch(request),
      now: () => new Date(),
    }),
    billDelivery: {
      isOptedIn: (clientId: number) =>
        createBillMirrorSource(drizzle, () => new Date()).isOptedIn(clientId),
      setOptedIn: (clientId: number, enabled: boolean) =>
        setBillDelivery(drizzle, clientId, enabled),
    },
    identities,
    ...createRuntimeAppleWeb(env, createD1AppleWebCustodyStore(database)),
    oidcTransactions: createD1OidcTransactionStore(database),
    oidcAppCodes: createD1OidcAppCodeStore(database),
    ...(magicLinkSigningKey === undefined
      ? {}
      : {
          staffMagicLinks: {
            users: createD1StaffUserDirectory(database),
            store: createD1StaffMagicLinkStore(database),
            ...(staffMagicLinkMailer === undefined
              ? {}
              : { mailer: staffMagicLinkMailer }),
            codeKey: magicLinkSigningKey,
          },
        }),
    ...(deploymentAuthMailer === undefined ? {} : { deploymentAuthMailer }),
    ...(accountDeletionMailer === undefined ? {} : { accountDeletionMailer }),
    ...(organizationMailer === undefined ? {} : { organizationMailer }),
    ...(env.ATTACHMENTS === undefined
      ? {}
      : {
          attachments: {
            metadata: createAttachmentStore(drizzle),
            objects: demo
              ? readOnlyObjects(createR2AttachmentObjectStore(env.ATTACHMENTS))
              : createR2AttachmentObjectStore(env.ATTACHMENTS),
            authorizeOwnerAccess: createD1AttachmentOwnerAuthorizer(database),
          },
        }),
  };
};
