import { chmod, lstat, mkdir, realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import {
  bootstrapInstanceContainer,
  createApiTokenStore,
  createAttachmentStore,
  createContainerDatabase,
  createContainerEmailLogStore,
  createContainerEmailConfigurationStore,
  createContainerIdentityStore,
  createContainerOidcTransactionStore,
  createContainerPasswordAuthService,
  createContainerSessionStore,
  createGeneralResourceRepository,
  createInvoiceGenerationService,
  createMoneyResourceRepository,
  createReportRepository,
  createTimesheetApprovalRepository,
  createTimesheetLockPolicyRepository,
  DrizzleTrackedResourceRepository,
  enrollInstanceOwnerPasswordContainer,
  migrateContainer,
} from '@ezacto/db'
import {
  createApiSessionService,
  createQueuedAuthMailer,
  type AttachmentRouteOptions,
  type UserPrincipal,
} from '@ezacto/api'
import {
  createBootstrapSenderQueuedMailer,
  createQueuedMailer,
  type HttpEmailProvider,
} from '@ezacto/mailer'
import { SmtpMailer } from '@ezacto/mailer/smtp'
import type { RuntimeServices } from '../../worker/src/app.js'
import type { ContainerConfig } from './config.js'
import { createDiskAttachmentObjectStore } from './disk-attachments.js'
import { ContainerEmailQueue } from './email-queue.js'

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
  close(timeoutMs?: number): Promise<void>
}

export interface ContainerRuntimeOptions {
  emailProvider?: HttpEmailProvider
  verifyEmailProvider?: () => Promise<void>
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
    const objects = await createDiskAttachmentObjectStore(
      config.attachmentDirectory,
    )

    const services: RuntimeServices = {
      bootstrap: (input) => bootstrapInstanceContainer(database, input),
      enrollOwnerPassword: (input) =>
        enrollInstanceOwnerPasswordContainer(database, input),
      tokens: createApiTokenStore(drizzle),
      generalResources: createGeneralResourceRepository(drizzle),
      trackedResources: new DrizzleTrackedResourceRepository(
        drizzle,
        timesheetLockPolicy,
      ),
      isExpensesModuleEnabled: async () => {
        const row = database
          .prepare(
            `SELECT COALESCE(json_extract(modules, '$.expenses'), 0) AS enabled
             FROM organizations WHERE id = 1`,
          )
          .get() as { enabled: number } | undefined
        return row?.enabled === 1
      },
      moneyResources: createMoneyResourceRepository(drizzle),
      invoiceGeneration: createInvoiceGenerationService(drizzle),
      reports: createReportRepository(drizzle),
      timesheetApprovals: createTimesheetApprovalRepository(drizzle),
      timesheetLockPolicy,
      cursorSigningKey: config.cursorSigningKey,
      passwordAuth: createContainerPasswordAuthService(database),
      sessions,
      emailLog,
      emailConfiguration,
      identities: createContainerIdentityStore(database),
      oidcTransactions: createContainerOidcTransactionStore(database),
      authMailer: createQueuedAuthMailer(
        createBootstrapSenderQueuedMailer(
          config.smtp.from,
          createQueuedMailer(emailLog, queue),
        ),
        emailConfiguration,
        async () => {
          const row = database
            .prepare('SELECT name FROM organizations WHERE id = 1')
            .get() as { name: string } | undefined
          return row?.name ?? 'Ezacto'
        },
        config.appBaseUrl,
      ),
      attachments: {
        metadata: createAttachmentStore(drizzle),
        objects,
        authorizeOwnerAccess:
          createContainerAttachmentOwnerAuthorizer(database),
      },
    }

    let closed = false
    return {
      database,
      services,
      async close(timeoutMs) {
        if (closed) return
        closed = true
        try {
          await queue!.close(timeoutMs)
          database.pragma('wal_checkpoint(TRUNCATE)')
        } finally {
          database.close()
        }
      },
    }
  } catch (error) {
    await queue?.close().catch(() => undefined)
    if (database.open) database.close()
    throw error
  }
}
