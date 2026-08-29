import {
  bootstrapInstanceD1,
  createApiTokenStore,
  createD1Database,
  createD1IdentityStore,
  createD1OidcTransactionStore,
  createGeneralResourceRepository,
  createReportRepository,
  createD1EmailLogStore,
  createD1PasswordAuthService,
  createD1SessionStore,
  DrizzleTrackedResourceRepository,
  migrateD1,
  type TrackedPolicyResolver,
} from '@ezacto/db/d1'
import { createApiSessionService } from '@ezacto/api'
import {
  SesMailer,
  type HttpEmailProvider,
  type SesMailerOptions,
} from '@ezacto/mailer'
import type { RuntimeServices } from './app.js'
import type { WorkerEnv } from './app.js'
import { createWorkerAuthMailer } from './email-queue.js'

const cursorSecretPattern = /^[A-Za-z0-9_-]+$/
const cursorSecretBytes = 32

const readiness = new WeakMap<object, Promise<void>>()

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
  ]
  if (configured.every((value) => value === undefined)) return null
  if (
    env.AWS_ACCESS_KEY_ID === undefined ||
    env.AWS_SECRET_ACCESS_KEY === undefined ||
    env.SES_REGION === undefined ||
    env.SES_FROM === undefined
  ) {
    throw new TypeError(
      'SES requires AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, SES_REGION, and SES_FROM together',
    )
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
  )
}

/**
 * Decode a canonical base64url secret. Text encodings are deliberately not
 * accepted: deployments must preserve the same key bytes across releases.
 */
export const parseCursorSigningKey = (encoded: string): Uint8Array => {
  if (
    typeof encoded !== 'string' ||
    encoded.length === 0 ||
    encoded.length > 128 ||
    encoded.length % 4 === 1 ||
    !cursorSecretPattern.test(encoded)
  ) {
    throw new TypeError('API_CURSOR_SIGNING_KEY must be canonical base64url')
  }

  let binary: string
  try {
    const padding = '='.repeat((4 - (encoded.length % 4)) % 4)
    binary = atob(encoded.replaceAll('-', '+').replaceAll('_', '/') + padding)
  } catch {
    throw new TypeError('API_CURSOR_SIGNING_KEY must be canonical base64url')
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  if (bytes.byteLength !== cursorSecretBytes) {
    throw new TypeError(
      `API_CURSOR_SIGNING_KEY must decode to exactly ${cursorSecretBytes} bytes`,
    )
  }
  if (encodeBase64Url(bytes) !== encoded) {
    throw new TypeError('API_CURSOR_SIGNING_KEY must be canonical base64url')
  }
  return bytes
}

const encodeBase64Url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

const requireDatabase = (env: WorkerEnv): D1Database => {
  const database = env.DB
  if (
    database === undefined ||
    typeof database !== 'object' ||
    typeof database.prepare !== 'function' ||
    typeof database.batch !== 'function' ||
    typeof database.exec !== 'function'
  ) {
    throw new TypeError('DB must be a D1 database binding')
  }
  return database
}

/**
 * D1 itself serializes each ledger-leading migration batch. The isolate cache
 * only removes repeat checks after success; failures are evicted and retried.
 */
export const ensureRuntimeDatabaseReady = async (
  database: D1Database,
): Promise<void> => {
  const identity = database as object
  const pending = readiness.get(identity)
  if (pending !== undefined) return pending

  const migration = migrateD1(database).catch((error: unknown) => {
    if (readiness.get(identity) === migration) readiness.delete(identity)
    throw error
  })
  readiness.set(identity, migration)
  return migration
}

// Approval and invoice locks are persisted and derived by the repository. The
// current organization model defines no additional calendar/policy lock source.
const organizationPolicy: TrackedPolicyResolver = {
  isLocked: async () => false,
}

export const createRuntimeServices = async (
  env: WorkerEnv,
  options: {
    emailProvider?: HttpEmailProvider
    ses?: SesMailerOptions
  } = {},
): Promise<RuntimeServices> => {
  const database = requireDatabase(env)
  const cursorSigningKey = parseCursorSigningKey(env.API_CURSOR_SIGNING_KEY)
  await ensureRuntimeDatabaseReady(database)
  const drizzle = createD1Database(database)
  const sessions = createApiSessionService(createD1SessionStore(database))
  const emailLog = createD1EmailLogStore(database)
  const emailProvider =
    options.emailProvider ?? createWorkerSesMailer(env, options.ses)
  const authMailer =
    env.EMAIL_QUEUE === undefined ||
    env.APP_BASE_URL === undefined ||
    emailProvider === null
      ? undefined
      : createWorkerAuthMailer(env.EMAIL_QUEUE, emailLog, env.APP_BASE_URL)
  return {
    bootstrap: (input) => bootstrapInstanceD1(database, input),
    tokens: createApiTokenStore(drizzle),
    generalResources: createGeneralResourceRepository(drizzle),
    trackedResources: new DrizzleTrackedResourceRepository(
      drizzle,
      organizationPolicy,
    ),
    reports: createReportRepository(drizzle),
    cursorSigningKey,
    passwordAuth: createD1PasswordAuthService(database),
    sessions,
    emailLog,
    identities: createD1IdentityStore(database),
    oidcTransactions: createD1OidcTransactionStore(database),
    ...(authMailer === undefined ? {} : { authMailer }),
  }
}
