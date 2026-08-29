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
export { createReportRepository, type ReportRepository } from './reports.js'
export { createD1EmailLogStore, type EmailLogStoreOptions } from './email-log.js'
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
  bootstrapInstanceD1,
  enrollInstanceOwnerPasswordD1,
  InstanceBootstrapConflictError,
  InstanceOwnerPasswordConflictError,
  type InstanceBootstrapInput,
  type InstanceBootstrapResult,
  type InstanceOwnerPasswordInput,
  type InstanceOwnerPasswordResult,
} from './instance-bootstrap.js'
export { migrateD1 } from './migrate.js'
export {
  DrizzleTrackedResourceRepository,
  type PolicySubject,
  type TrackedPolicyResolver,
} from './tracked-resource-repository.js'
