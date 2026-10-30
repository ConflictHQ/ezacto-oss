import { Miniflare } from 'miniflare'
import { migrateD1 } from '@ezacto/db/d1'
import { expect, it } from 'vitest'
import { createRuntimeServices } from '../src/runtime.js'

it('passes fixed reminder bounds through the Worker service without requiring a mail provider', async () => {
  const miniflare = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'] })
  try {
    const db = await miniflare.getD1Database('DB')
    await migrateD1(db)
    const at = '2026-10-08T03:00:00.000Z'
    await db.prepare("INSERT INTO organizations (name, modules, created_at, updated_at) VALUES ('Fixture', '{}', ?, ?)").bind(at, at).run()
    await db.prepare("INSERT INTO clients (id, name, currency, created_at, updated_at) VALUES (1, 'Fixture', 'USD', ?, ?)").bind(at, at).run()
    for (const id of [1, 2, 3]) {
      await db.prepare(`INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date, state, created_at, updated_at)
        VALUES (?, 1, ?, 'USD', '2026-10-01', '2026-10-01', 'draft', ?, ?)`).bind(id, `F${id}`, at, at).run()
      await db.prepare(`INSERT INTO scheduled_reminders
        (id, invoice_id, scheduled_at, interval_days, status, template, causation_event_id, created_at, updated_at)
        VALUES (?, ?, ?, 7, 'pending', 'reminder', ?, ?, ?)`).bind(id, id, at, `fixture-${id}`, at, at).run()
    }
    const runtime = await createRuntimeServices({ DB: db, ENVIRONMENT: 'test', RELEASE: 'test',
      API_CURSOR_SIGNING_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })
    expect(await runtime.reminders!.processDue(at, { limit: 1, selection: { afterId: 1, throughId: 2 } }))
      .toEqual({ examined: 1, sent: 0, scheduled: 0, lastExaminedId: 2 })
    expect((await db.prepare('SELECT id, status FROM scheduled_reminders ORDER BY id').all()).results).toEqual([
      { id: 1, status: 'pending' }, { id: 2, status: 'cancelled' }, { id: 3, status: 'pending' },
    ])
  } finally { await miniflare.dispose() }
})
