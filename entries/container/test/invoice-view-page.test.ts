import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { createContainerDatabase } from '@ezacto/db'
import type { HttpEmailProvider } from '@ezacto/mailer'
import { createApp } from '../../worker/src/app.js'
import { invoicePageSuite, seedSentInvoice } from '../../worker/test/support/invoice-view-fixture.js'
import type { ContainerConfig } from '../src/config.js'
import { createContainerRuntime } from '../src/runtime.js'

/**
 * Issue 936: the hosted invoice page on the container, against a real SQLite
 * file and the app the container composes from its real services. The Worker
 * runs the same suite in its own test; the page is a public surface and must
 * refuse the same things wherever it is hosted.
 */
const provider: HttpEmailProvider = {
  name: 'smtp',
  async send(_message, options) {
    return { messageId: `<${options.idempotencyKey}@capture.test>`, latencyMs: 1 }
  },
}

const configuration = (root: string): ContainerConfig => ({
  host: '127.0.0.1',
  port: 3000,
  trustedProxyHops: 0,
  dataDirectory: root,
  databasePath: join(root, 'db.sqlite'),
  attachmentDirectory: join(root, 'attachments'),
  brandDirectory: join(root, 'brand'),
  appBaseUrl: 'http://localhost:3000',
  cursorSigningKey: new Uint8Array(32).fill(0x43),
  smtp: { url: 'smtp://127.0.0.1:2525', from: 'billing@example.test' },
  appEnv: {
    ENVIRONMENT: 'test-container',
    RELEASE: 'container-test',
    APP_BASE_URL: 'http://localhost:3000',
  },
})

invoicePageSuite('the container', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ezacto-container-')))
  const config = configuration(root)
  const runtime = await createContainerRuntime(config, { emailProvider: provider })
  // A second connection to the file the runtime migrated, the way an operator's
  // own tooling would hold one.
  const sqlite = new BetterSqlite3(config.databasePath)
  const { token } = await seedSentInvoice(
    async (sql, ...bindings) => void sqlite.prepare(sql).run(...bindings),
    createContainerDatabase(sqlite),
  )
  const app = createApp(runtime.services, runtime.brandAssets, runtime.instanceTheme)
  return {
    token,
    request: async (path, init) => app.request(`${config.appBaseUrl}${path}`, init, config.appEnv),
    rows: async <T>(sql: string, ...bindings: unknown[]) =>
      sqlite.prepare(sql).all(...bindings) as T[],
    close: async () => {
      sqlite.close()
      await runtime.close()
      await rm(root, { recursive: true, force: true })
    },
  }
})
