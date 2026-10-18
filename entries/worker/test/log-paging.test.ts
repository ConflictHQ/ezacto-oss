import { createApiApp, installBackupStatusRoutes, installEmailLogRoutes, installOutboxRoutes } from '@ezacto/api'
import { migrateD1 } from '@ezacto/db/d1'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createRuntimeServices } from '../src/runtime.js'

/**
 * Issue 929. The email log, the event deliveries and the backup runs page by
 * a signed cursor, through the routes and the stores the Worker composes,
 * against a migrated database. The route tests alone use a pager written for
 * the test; this one checks that the SQL and the cursor agree about order, ties
 * and the window a traversal is held to.
 */

const miniflares: Miniflare[] = []
afterEach(async () => {
  await Promise.all(miniflares.splice(0).map((miniflare) => miniflare.dispose()))
})

interface Page {
  data: Record<string, unknown>[]
  links: { next: string | null }
  page: { per_page: number; next_cursor: string | null; total: number }
}

const setup = async () => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  miniflares.push(miniflare)
  const db = await miniflare.getD1Database('DB')
  await migrateD1(db)
  const at = '2026-09-01T00:00:00.000Z'
  await db
    .prepare("INSERT INTO organizations (name, modules, created_at, updated_at) VALUES ('Fixture', '{}', ?, ?)")
    .bind(at, at)
    .run()
  await db.prepare("UPDATE organizations SET timezone = 'America/Costa_Rica'").run()
  const services = await createRuntimeServices({
    DB: db,
    ENVIRONMENT: 'test',
    RELEASE: 'test',
    API_CURSOR_SIGNING_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  })
  const cursorSigningKey = new Uint8Array(32).fill(3)
  const timezone = async () => (await services.timesheetLockPolicy.settings()).timezone
  const app = createApiApp({
    authentication: {
      sessions: {
        resolve: async () => ({
          type: 'user' as const,
          userId: 1,
          profile: 'administrator' as const,
          managerGrants: [],
          authentication: { kind: 'session' as const, sessionId: 'session-1' },
        }),
      },
    },
    installApi(api) {
      installEmailLogRoutes(api, services.emailLog, { cursorSigningKey, timezone })
      installOutboxRoutes(api, services.outbox, { cursorSigningKey, timezone })
      installBackupStatusRoutes(api, services.backupStatus!, { cursorSigningKey })
    },
  })
  const get = async (path: string): Promise<Page> => {
    const response = await app.request(path)
    expect(response.status).toBe(200)
    return (await response.json()) as Page
  }
  /** Every page of a traversal, following the links the server gave. */
  const walk = async (path: string): Promise<{ pages: Page[]; ids: unknown[] }> => {
    const pages: Page[] = []
    let next: string | null = path
    while (next !== null) {
      const page: Page = await get(next)
      pages.push(page)
      next = page.links.next
    }
    return { pages, ids: pages.flatMap((page) => page.data) }
  }
  return { db, services, app, get, walk }
}

/** A queued message created at a chosen instant, which the store's own clock would not allow. */
const queueMail = async (
  db: Awaited<ReturnType<typeof setup>>['db'],
  at: string,
  template: string,
  to: string,
): Promise<number> => {
  const row = await db
    .prepare(
      `INSERT INTO email_log (from_json, to_json, template, subject, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(JSON.stringify({ email: 'billing@example.test' }), JSON.stringify([{ email: to }]), template, template, at, at)
    .first<{ id: number }>()
  return row!.id
}

describe('paged operator logs against a migrated database', () => {
  it('[api] pages the email log across ties on the instant without skipping or repeating a row', async () => {
    const { db, walk, get } = await setup()
    const ids: number[] = []
    // Seven rows, three of which share one instant: the page boundary falls inside the tie.
    for (const [index, at] of [
      '2026-09-01T10:00:00.000Z',
      '2026-09-02T10:00:00.000Z',
      '2026-09-03T10:00:00.000Z',
      '2026-09-03T10:00:00.000Z',
      '2026-09-03T10:00:00.000Z',
      '2026-09-04T10:00:00.000Z',
      '2026-09-05T10:00:00.000Z',
    ].entries()) {
      ids.push(await queueMail(db, at, index % 2 === 0 ? 'invoice:1' : 'reminder:1', `p${String(index)}@client.test`))
    }
    const newest = await walk('/api/v1/email-log?per_page=2')
    expect(newest.pages).toHaveLength(4)
    expect(newest.pages.every((page) => page.page.total === 7)).toBe(true)
    expect(newest.ids.map((row) => row.id)).toEqual([...ids].reverse())

    const oldest = await walk('/api/v1/email-log?per_page=3&order=oldest')
    expect(oldest.ids.map((row) => row.id)).toEqual(ids)

    const invoices = await get('/api/v1/email-log?kind=invoice&per_page=10')
    expect(invoices.data.map((row) => row.id)).toEqual([ids[6], ids[4], ids[2], ids[0]])
    expect(invoices.page.total).toBe(4)
    const found = await get('/api/v1/email-log?q=P3@CLIENT&per_page=10')
    expect(found.data.map((row) => row.id)).toEqual([ids[3]])
  })

  it('[api] reads a day as the organization sees it, not as UTC does', async () => {
    const { db, get } = await setup()
    // 03:00 UTC on the 3rd is still the evening of the 2nd at UTC-6.
    const evening = await queueMail(db, '2026-09-03T03:00:00.000Z', 'invoice:1', 'a@client.test')
    const morning = await queueMail(db, '2026-09-03T15:00:00.000Z', 'invoice:1', 'b@client.test')
    const second = await get('/api/v1/email-log?from=2026-09-02&to=2026-09-02&per_page=10')
    expect(second.data.map((row) => row.id)).toEqual([evening])
    const third = await get('/api/v1/email-log?from=2026-09-03&to=2026-09-03&per_page=10')
    expect(third.data.map((row) => row.id)).toEqual([morning])
    const both = await get('/api/v1/email-log?from=2026-09-02&to=2026-09-03&per_page=10')
    expect(both.page.total).toBe(2)
  })

  it('[api] holds a traversal to the mail that existed when it began', async () => {
    const { db, get } = await setup()
    for (const day of ['01', '02', '03']) {
      await queueMail(db, `2026-09-${day}T10:00:00.000Z`, 'invoice:1', `${day}@client.test`)
    }
    const first = await get('/api/v1/email-log?per_page=2')
    await queueMail(db, '2026-09-09T10:00:00.000Z', 'invoice:1', 'late@client.test')
    const second = await get(first.links.next!)
    expect(second.data).toHaveLength(1)
    expect(second.page.next_cursor).toBeNull()
  })

  it('[api] pages event deliveries by status and type, with the key breaking ties', async () => {
    const { db, walk, get } = await setup()
    const stamp = '2026-09-02T12:00:00.000Z'
    for (const [eventId, type] of [
      ['e1', 'invoice.paid'],
      ['e2', 'invoice.sent'],
      ['e3', 'invoice.paid'],
    ] as const) {
      await db
        .prepare(
          `INSERT INTO event_outbox (id, aggregate_type, aggregate_id, aggregate_sequence, event_type, payload_json, occurred_at, available_at)
           VALUES (?, 'fixture', 1, ?, ?, '{}', ?, ?)`,
        )
        .bind(eventId, Number(eventId.slice(1)), type, stamp, stamp)
        .run()
      for (const subscriber of ['activity_log', 'reminder_scheduler']) {
        const failed = eventId === 'e1' && subscriber === 'activity_log'
        await db
          .prepare(
            `INSERT INTO outbox_delivery_receipts
               (subscriber_id, event_id, status, attempt_count, last_error_code, delivered_at, failed_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            subscriber,
            eventId,
            failed ? 'failed' : 'delivered',
            failed ? 5 : 1,
            failed ? 'subscriber_timeout' : null,
            failed ? null : stamp,
            failed ? stamp : null,
            stamp,
            stamp,
          )
          .run()
      }
    }
    // Six receipts at one instant: the order is decided by subscriber, then event.
    const all = await walk('/api/v1/outbox-deliveries?per_page=4')
    expect(all.pages).toHaveLength(2)
    expect(all.ids.map((row) => `${String(row.subscriber_id)}/${String(row.event_id)}`)).toEqual([
      'reminder_scheduler/e3',
      'reminder_scheduler/e2',
      'reminder_scheduler/e1',
      'activity_log/e3',
      'activity_log/e2',
      'activity_log/e1',
    ])
    const oldest = await walk('/api/v1/outbox-deliveries?per_page=4&order=oldest')
    expect(oldest.ids.map((row) => `${String(row.subscriber_id)}/${String(row.event_id)}`)).toEqual([
      'activity_log/e1',
      'activity_log/e2',
      'activity_log/e3',
      'reminder_scheduler/e1',
      'reminder_scheduler/e2',
      'reminder_scheduler/e3',
    ])
    const failed = await get('/api/v1/outbox-deliveries?status=failed')
    expect(failed.data).toHaveLength(1)
    expect(failed.page.total).toBe(1)
    const paid = await get('/api/v1/outbox-deliveries?event_type=invoice.paid')
    expect(paid.page.total).toBe(4)
    const none = await get('/api/v1/outbox-deliveries?from=2026-09-03')
    expect(none).toMatchObject({ data: [], page: { total: 0, next_cursor: null } })
  })

  it('[api] pages backup runs newest first and filters them by status and trigger', async () => {
    const { db, walk, get } = await setup()
    for (let day = 1; day <= 5; day += 1) {
      const startedAt = `2026-09-0${String(day)}T03:00:00.000Z`
      const failed = day === 3
      await db
        .prepare(
          `INSERT INTO backup_runs (status, trigger, started_at, completed_at, r2_prefix, manifest_json, table_count, total_rows, error_message, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          failed ? 'failed' : 'completed',
          day % 2 === 0 ? 'manual' : 'nightly',
          startedAt,
          startedAt,
          failed ? null : `backups/${startedAt}/`,
          failed ? null : '{}',
          failed ? null : 10,
          failed ? null : 100,
          failed ? 'disk full' : null,
          startedAt,
          startedAt,
        )
        .run()
    }
    const everything = await walk('/api/v1/backup/runs?per_page=2')
    expect(everything.pages).toHaveLength(3)
    expect(everything.ids.map((row) => row.started_at)).toEqual([
      '2026-09-05T03:00:00.000Z',
      '2026-09-04T03:00:00.000Z',
      '2026-09-03T03:00:00.000Z',
      '2026-09-02T03:00:00.000Z',
      '2026-09-01T03:00:00.000Z',
    ])
    const failed = await get('/api/v1/backup/runs?status=failed')
    expect(failed.data.map((row) => row.error_message)).toEqual(['disk full'])
    const manual = await get('/api/v1/backup/runs?trigger=manual&per_page=1')
    expect(manual.page).toMatchObject({ total: 2 })
    expect(manual.links.next).not.toBeNull()
  })
})

describe('an empty history', () => {
  it('[api] answers with a designed empty page, not an error', async () => {
    const { get } = await setup()
    for (const path of ['/api/v1/email-log', '/api/v1/outbox-deliveries', '/api/v1/backup/runs']) {
      expect((await get(path)).data).toEqual([])
    }
  })
})
