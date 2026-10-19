import { Miniflare } from 'miniflare'
import { createApp, type WorkerEnv } from '../src/app.js'
import { workerBrandAssetSurface } from '../src/brand-assets.js'
import { workerInstanceThemeSurface } from '../src/instance-theme.js'
import { isServicePath } from '../src/data-request.js'
import { createRuntimeServices } from '../src/runtime.js'
import { createD1Database } from '../../../packages/db/src/adapters.js'
import { migrateD1 } from '../../../packages/db/src/migrate.js'
import { recordAttachedDocument } from '../../../packages/db/src/invoice-documents.js'
import { describe, expect, it } from 'vitest'
import { invoicePageSuite, seedSentInvoice } from './support/invoice-view-fixture.js'

/**
 * Issue 936: the hosted invoice page on the Worker, against a real D1 and the
 * app the entry composes from its real services. The container runs the same
 * suite in its own test.
 */
invoicePageSuite('the Worker', async () => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const database = await miniflare.getD1Database('DB')
  await migrateD1(database)
  const run = async (sql: string, ...bindings: unknown[]) => {
    await database.prepare(sql).bind(...bindings).run()
  }
  const { token } = await seedSentInvoice(run, createD1Database(database))
  const env: WorkerEnv = {
    DB: database,
    API_CURSOR_SIGNING_KEY: 'A'.repeat(43),
    ENVIRONMENT: 'test',
    RELEASE: 'invoice-view-page-test',
    APP_BASE_URL: 'https://app.example.test',
  }
  const app = createApp(
    await createRuntimeServices(env),
    workerBrandAssetSurface,
    workerInstanceThemeSurface,
  )
  return {
    token,
    request: async (path, init) => app.request(path, init, env),
    rows: async <T>(sql: string, ...bindings: unknown[]) =>
      (await database.prepare(sql).bind(...bindings).all<T>()).results,
    close: async () => miniflare.dispose(),
  }
})

describe('the hosted invoice page on the Worker: its document', () => {
  it('[api] is reachable by the app that has the services', () => {
    expect(isServicePath('/portal/invoices/abc')).toBe(true)
    expect(isServicePath('/portal/invoices/abc/viewed')).toBe(true)
    expect(isServicePath('/portal/invoices/abc/document')).toBe(true)
  })

  it('[api] serves the document that was sent from the bucket, and that download is the view', async () => {
    const miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: ['DB'],
      r2Buckets: ['ATTACHMENTS'],
    })
    try {
      const database = await miniflare.getD1Database('DB')
      await migrateD1(database)
      const orm = createD1Database(database)
      const run = async (sql: string, ...bindings: unknown[]) => {
        await database.prepare(sql).bind(...bindings).run()
      }
      const { token, sentAt } = await seedSentInvoice(run, orm)
      const bucket = await miniflare.getR2Bucket('ATTACHMENTS')
      const pdf = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52])
      await bucket.put('invoice-documents/9001/9200.pdf', pdf)
      await recordAttachedDocument(orm, {
        invoiceMessageId: 9200,
        invoiceId: 9001,
        objectKey: 'invoice-documents/9001/9200.pdf',
        filename: 'INVOICE_INV-9001_PAGE_ORG.pdf',
        contentType: 'application/pdf',
        byteSize: pdf.byteLength,
        invoiceVersion: 1,
        appendedAttachmentIds: [],
        now: sentAt,
      })
      const env: WorkerEnv = {
        DB: database,
        ATTACHMENTS: bucket,
        API_CURSOR_SIGNING_KEY: 'A'.repeat(43),
        ENVIRONMENT: 'test',
        RELEASE: 'invoice-view-page-test',
        APP_BASE_URL: 'https://app.example.test',
      }
      const app = createApp(
        await createRuntimeServices(env),
        workerBrandAssetSurface,
        workerInstanceThemeSurface,
      )

      const page = await app.request(`/portal/invoices/${token}`, {}, env)
      expect(await page.text()).toContain(`/portal/invoices/${token}/document`)

      const download = await app.request(`/portal/invoices/${token}/document`, {}, env)
      expect(download.status).toBe(200)
      expect(download.headers.get('content-type')).toBe('application/pdf')
      expect(download.headers.get('content-disposition')).toBe(
        'attachment; filename="INVOICE_INV-9001_PAGE_ORG.pdf"',
      )
      expect(download.headers.get('cache-control')).toBe('no-store')
      expect(new Uint8Array(await download.arrayBuffer())).toEqual(pdf)

      const viewed = (
        await database.prepare(`SELECT id FROM invoice_messages WHERE event_type = 'view'`).all()
      ).results
      expect(viewed).toHaveLength(1)
    } finally {
      await miniflare.dispose()
    }
  }, 120_000)
})
