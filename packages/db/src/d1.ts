import { drizzle } from 'drizzle-orm/d1'
import * as schema from './schema.js'

/** Worker-safe adapter that does not pull the native better-sqlite3 driver. */
export const createD1Database = (database: D1Database) => drizzle(database, { schema })

export {
  createApiTokenStore,
  type ApiTokenStore,
  type CreateApiTokenStoreOptions,
} from './api-tokens.js'
export { createGeneralResourceRepository } from './general-resources.js'
export { createD1IdentityStore, type IdentityStore, type IdentityStoreOptions } from './identity.js'
export {
  bootstrapInstanceD1,
  InstanceBootstrapConflictError,
  type InstanceBootstrapInput,
  type InstanceBootstrapResult,
} from './instance-bootstrap.js'
export { migrateD1 } from './migrate.js'
export {
  DrizzleTrackedResourceRepository,
  type PolicySubject,
  type TrackedPolicyResolver,
} from './tracked-resource-repository.js'
