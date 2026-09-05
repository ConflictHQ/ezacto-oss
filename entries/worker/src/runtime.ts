import {
  bootstrapInstanceD1,
  createAttachmentStore,
  enrollInstanceOwnerPasswordD1,
  createApiTokenStore,
  createD1Database,
  createD1IdentityStore,
  createD1OidcTransactionStore,
  createD1OutboxService,
  createGeneralResourceRepository,
  createMoneyResourceRepository,
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
  DrizzleTrackedResourceRepository,
  getLatestBackupRuns,
  migrateD1,
} from "@ezacto/db/d1";
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
  SesMailer,
  type HttpEmailProvider,
  type SesMailerOptions,
} from "@ezacto/mailer";
import type { RuntimeServices } from "./app.js";
import { cloudflareAccessConfig, type WorkerEnv } from "./app.js";
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
    cloudflareAccessFetch?: CloudflareAccessFetch;
  } = {},
): Promise<RuntimeServices> => {
  const database = requireDatabase(env);
  const cursorSigningKey = parseCursorSigningKey(env.API_CURSOR_SIGNING_KEY);
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
    options.emailProvider ?? createWorkerSesMailer(env, options.ses);
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
  const deploymentAuthMailer =
    !emailQueueReady || env.SES_FROM === undefined
      ? undefined
      : createWorkerDeploymentAuthMailer(
          env.EMAIL_QUEUE!,
          emailLog,
          env.SES_FROM,
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
  const moneyResources = createMoneyResourceRepository(drizzle);
  const outbox = createD1OutboxService(database, {
    additionalSubscribers: [
      createInvoiceEmailOutboxSubscriber(moneyResources, organizationMailer),
    ],
  });
  return {
    bootstrap: (input) => bootstrapInstanceD1(database, input),
    enrollOwnerPassword: (input) =>
      enrollInstanceOwnerPasswordD1(database, input),
    tokens: createApiTokenStore(drizzle),
    generalResources: createGeneralResourceRepository(drizzle),
    team: createTeamRepository(drizzle),
    moneyResources,
    invoiceGeneration: createInvoiceGenerationService(drizzle),
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
    passwordAuth: createD1PasswordAuthService(database),
    sessions,
    authenticationSessions,
    emailLog,
    emailConfiguration,
    ...(emailProvider instanceof SesMailer
      ? { senderIdentityVerifier: createSesSenderIdentityVerifier(emailProvider) }
      : {}),
    outbox,
    backupStatus: {
      latestRuns: (limit: number) => getLatestBackupRuns(database, limit),
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
