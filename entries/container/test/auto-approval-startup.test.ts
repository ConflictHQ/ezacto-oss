import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ContainerConfig } from '../src/config.js'
import { createContainerRuntime } from '../src/runtime.js'

const roots: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
const configuration = async (): Promise<ContainerConfig> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ezacto-approval-startup-')))
  roots.push(root)
  return {
    host: '127.0.0.1', port: 3000, trustedProxyHops: 0,
    dataDirectory: root, databasePath: join(root, 'db.sqlite'),
    attachmentDirectory: join(root, 'attachments'), brandDirectory: join(root, 'brand'),
    appBaseUrl: 'http://localhost:3000', cursorSigningKey: new Uint8Array(32).fill(0x43),
    smtp: { url: 'smtp://127.0.0.1:2525', from: 'approval-fixture@example.invalid' },
    appEnv: { ENVIRONMENT: 'test-container', RELEASE: 'approval-startup-test', APP_BASE_URL: 'http://localhost:3000' },
  }
}
const provider = {
  name: 'smtp' as const,
  send: async () => ({ messageId: 'owned-approval-fixture', latencyMs: 0 }),
}
const bootstrap = async (runtime: Awaited<ReturnType<typeof createContainerRuntime>>) => {
  const auth = runtime.services.passwordAuth!
  const created = await auth.signup({ organizationName: 'Owned approval startup', firstName: 'Owned', lastName: 'Admin', email: 'owner@example.invalid', password: 'owned fixture password only', clientKey: 'approval-startup' })
  await auth.verifyEmail(created.token, 'approval-startup')
}

it('[runtime #1309] starts empty, skips approvals, and bootstraps without an automatic-approval error', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const runtime = await createContainerRuntime(await configuration(), { emailProvider: provider, verifyEmailProvider: async () => undefined })
  try {
    await runtime.drainOutbox()
    expect(runtime.database.prepare('SELECT count(*) AS count FROM organizations').get()).toEqual({ count: 0 })
    expect(runtime.database.prepare('SELECT count(*) AS count FROM timesheet_automatic_approval_receipts').get()).toEqual({ count: 0 })
    expect(runtime.database.prepare('SELECT count(*) AS count FROM timesheet_bulk_approval_commands').get()).toEqual({ count: 0 })
    await bootstrap(runtime)
    const later = Date.now() + 120000
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(later)
    await runtime.drainOutbox()
    expect(runtime.database.prepare('SELECT count(*) AS count FROM organizations').get()).toEqual({ count: 1 })
    expect(runtime.database.prepare('SELECT count(*) AS count FROM timesheet_automatic_approval_receipts').get()).toEqual({ count: 0 })
    expect(errors.mock.calls.filter(([message]) => String(message).includes('automatic approval'))).toEqual([])
  } finally { await runtime.close() }
})

it('[runtime #1309] still reports an actual organization-query fault after bootstrap', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const runtime = await createContainerRuntime(await configuration(), { emailProvider: provider, verifyEmailProvider: async () => undefined })
  let renamed = false
  try {
    await runtime.drainOutbox()
    await bootstrap(runtime)
    runtime.database.exec('ALTER TABLE organizations RENAME TO unavailable_organizations')
    renamed = true
    const later = Date.now() + 120000
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(later)
    await runtime.drainOutbox()
    const failure = errors.mock.calls.find(([message]) => message === '[container] automatic approval sweep failed')
    expect(failure).toBeDefined()
    expect(failure![1]).toBeInstanceOf(Error)
    const error = failure![1] as Error
    expect(String(error.cause ?? error)).toMatch(/no such table.*organizations/i)
  } finally {
    if (renamed) runtime.database.exec('ALTER TABLE unavailable_organizations RENAME TO organizations')
    await runtime.close()
  }
})
