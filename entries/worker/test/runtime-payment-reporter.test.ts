import { Miniflare } from 'miniflare'
import { expect, it, vi } from 'vitest'
import { createD1Database, createStaffPaymentStore, migrateD1 } from '@ezacto/db/d1'
import { createRuntimeServices } from '../src/runtime.js'
import type { WorkerEnv } from '../src/app.js'
import type { WorkerErrorContext } from '../src/error-reporting.js'

const provider = vi.hoisted(() => ({ quote: vi.fn(), create: vi.fn(), fund: vi.fn(), read: vi.fn() }))
vi.mock('@ezacto/integrations', async original => ({ ...(await original<object>()), createWisePaymentProvider: () => provider }))

it('routes a handled native payment-provider exception through the injected port without money settlement', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'] })
  try {
    const db = await mf.getD1Database('DB')
    await migrateD1(db)
    const now = new Date().toISOString()
    await db.batch([
      db.prepare('INSERT INTO organizations(name,modules,created_at,updated_at) VALUES(?,?,?,?)').bind('Fixture', '{}', now, now),
      db.prepare("INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(1,'Admin','One','administrator','[]',?,?),(2,'Person','Two','member','[]',?,?)").bind(now, now, now, now),
      db.prepare("INSERT INTO user_payout_accounts(id,user_id,provider,external_id,linked_by_user_id,linked_at,verified_at,created_at,updated_at) VALUES(1,2,'wise','456',1,?,?,?,?)").bind(now, now, now, now),
    ])
    const ledger = createStaffPaymentStore(createD1Database(db))
    await ledger.append({ id: 'owned-obligation', user_id: 2, month: '2026-09', expected_version: 0, kind: 'amount', amount_cents: 10000, currency: 'USD', paid_on: null, due_on: null, reference: '', note: 'Owned fixture obligation', payment_id: null, source: 'wise' }, 1, 'owned-request', now)
    const failure = new Error('SECRET provider body token')
    provider.quote.mockResolvedValue({ id: 'owned-quote', profile_id: '123', recipient_id: '456', recipient_name: 'Fixture', source_currency: 'USD', target_currency: 'USD', source_cents: 5050, target_cents: 5000, fee_cents: 50, rate: 1, expires_at: new Date(Date.now() + 3600_000).toISOString(), estimated_arrival: null })
    provider.create.mockRejectedValue(failure)
    const reports: { error: Error; context: WorkerErrorContext }[] = []
    const env: WorkerEnv = { DB: db, API_CURSOR_SIGNING_KEY: 'A'.repeat(43), ENVIRONMENT: 'test', RELEASE: 'a'.repeat(40), WISE_TOKEN: 'owned-provider-fixture', WISE_PROFILE_ID: '123' }
    const services = await createRuntimeServices(env, { reportError: (error, context) => { reports.push({ error, context }) } })
    const run = await services.paymentRuns!.preview({ id: crypto.randomUUID(), name: 'Owned fixture', source_currency: 'USD', scheduled_at: now, timezone: 'UTC', items: [{ user_id: 2, month: '2026-09', amount_cents: 5000, expected_version: 1 }] }, 1, 'owned-request', now)
    await services.paymentRuns!.approve(run.id, { limits: run.items.map(item => ({ item_id: item.id, max_source_cents: 5100 })) }, 1, 'owned-approval', now)
    // A failed provider call is handled and returned as processing state, not thrown to the API.
    const result = await services.paymentRuns!.processDue(now)
    expect(result).toBeDefined()
    expect(provider.create).toHaveBeenCalledTimes(1)
    expect(provider.fund).not.toHaveBeenCalled()
    expect(reports).toHaveLength(1)
    expect(reports[0]!.error).toBe(failure)
    expect(reports[0]!.context).toEqual({ phase: 'payment', traceId: expect.stringMatching(/^[a-f0-9]{32}$/) })
    expect(JSON.stringify(reports[0]!.context)).not.toContain(run.id)
    const row = (await ledger.report('2026-09', now.slice(0, 10))).rows.find(item => item.user_id === 2)
    expect(row).toMatchObject({ paid_cents: 0, amount_cents: 10000, balance_cents: 10000 })
  } finally { await mf.dispose() }
}, 30_000)
