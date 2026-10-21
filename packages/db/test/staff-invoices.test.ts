import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { sql } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { createStaffInvoicesStore } from '../src/staff-invoices.js'
import { createStaffPaymentStore } from '../src/staff-payments.js'
import { createPaymentRunsService } from '../src/payment-runs.js'
import type { SaveStaffInvoice, PaymentProvider } from '@ezacto/core'
const now = '2026-10-01T12:00:00.000Z'
let dispose: (() => Promise<void>) | undefined
afterEach(async () => {
  await dispose?.()
  dispose = undefined
})
const fixture = async (runtime: 'sqlite' | 'd1') => {
  let db: ReturnType<typeof createContainerDatabase>
  if (runtime === 'sqlite') {
    const sqlite = new BetterSqlite3(':memory:')
    migrateContainer(sqlite)
    db = createContainerDatabase(sqlite)
    dispose = async () => {
      sqlite.close()
    }
  } else {
    const mf = new Miniflare({
      modules: true,
      script: 'export default {fetch(){return new Response("ok")}}',
      d1Databases: ['DB'],
    })
    const binding = await mf.getD1Database('DB')
    await migrateD1(binding)
    db = createD1Database(binding) as never
    dispose = () => mf.dispose()
  }
  const exec = async (query: string) => {
    try {
      await db.run(sql.raw(query))
    } catch (error) {
      let cause = error
      while (cause instanceof Error && cause.cause) cause = cause.cause
      throw cause
    }
  }
  for (const statement of [
    `INSERT INTO organizations(name,modules,created_at,updated_at) VALUES('Fixture','{}','${now}','${now}')`,
    `INSERT INTO users(id,first_name,last_name,profile,manager_grants,is_contractor,created_at,updated_at) VALUES(1,'Admin','One','administrator','[]',0,'${now}','${now}'),(2,'Person','Two','member','[]',1,'${now}','${now}'),(3,'Other','Contractor','member','[]',1,'${now}','${now}')`,
    `INSERT INTO clients(id,name,currency,created_at,updated_at) VALUES(1,'Client','USD','${now}','${now}')`,
    `INSERT INTO projects(id,client_id,name,created_at,updated_at) VALUES(1,1,'Project','${now}','${now}')`,
    `INSERT INTO tasks(id,name,created_at,updated_at) VALUES(1,'Task','${now}','${now}')`,
    `INSERT INTO user_assignments(id,project_id,user_id,created_at,updated_at) VALUES(1,1,2,'${now}','${now}')`,
    `INSERT INTO task_assignments(id,project_id,task_id,billable,created_at,updated_at) VALUES(1,1,1,1,'${now}','${now}')`,
    `INSERT INTO invoices(id,client_id,number,issue_date,due_date,currency,created_at,updated_at) VALUES(1,1,'RECEIVABLE-77','2026-09-01','2026-09-30','USD','${now}','${now}')`,
    `INSERT INTO user_payout_accounts(id,user_id,provider,external_id,linked_by_user_id,linked_at,verified_at,created_at,updated_at) VALUES(1,2,'wise','456',1,'${now}','${now}','${now}','${now}')`,
  ])
    await exec(statement)
  const store = createStaffInvoicesStore(db),
    ledger = createStaffPaymentStore(db)
  const review = async (negative = false) => {
    await exec(
      `INSERT INTO time_entries(id,user_id,project_id,task_id,user_assignment_id,task_assignment_id,spent_date,seconds,seconds_without_timer,rounded_seconds,billable,cost_rate_cents,created_at,updated_at) VALUES(10,2,1,1,1,1,'2026-09-15',7200,7200,7200,1,5000,'${now}','${now}')`,
    )
    if (negative)
      await exec(
        `INSERT INTO time_entries(id,user_id,project_id,task_id,user_assignment_id,task_assignment_id,spent_date,seconds,seconds_without_timer,rounded_seconds,billable,cost_rate_cents,created_at,updated_at) VALUES(11,2,1,1,1,1,'2026-09-16',-3600,-3600,-3600,1,5000,'${now}','${now}')`,
      )
    const entries = (await ledger.actuals!('2026-09', now)).people.find(
      (p) => p.user_id === 2,
    )!.entries
    await ledger.confirmActuals!(
      {
        id: 'review',
        user_id: 2,
        month: '2026-09',
        expected_version: 0,
        currency: 'USD',
        entries,
        note: 'Reviewed actuals',
      },
      1,
      'review',
      now,
    )
  }
  const command: SaveStaffInvoice = {
    id: 'draft',
    invoice_id: null,
    expected_version: 0,
    user_id: 2,
    month: '2026-09',
    currency: 'USD',
    reference: 'C-001',
    kind: 'draft',
    from_review: true,
    lines: [],
    document_id: null,
    reason: 'Draft from reviewed earnings',
    acknowledge_paid_history: false,
  }
  const save = (over: Partial<SaveStaffInvoice> = {}) =>
    store.save({ ...command, ...over }, 1, 'save', now)
  const money = async () => ({
    payments: await db.all(sql`SELECT * FROM staff_payment_events ORDER BY id`),
    allocations: await db.all(sql`SELECT * FROM staff_payment_allocations ORDER BY id`),
    receivables: await db.all(sql`SELECT * FROM invoices ORDER BY id`),
  })
  return { db, exec, store, ledger, review, command, save, money }
}
describe.each(['sqlite', 'd1'] as const)('contractor payable invoices on %s', (runtime) => {
  it('drafts signed reviewed earnings, records receipt, preserves versions and never changes obligations or receivables', async () => {
    const f = await fixture(runtime)
    await f.review(true)
    const before = await f.money()
    const draft = await f.save()
    expect(draft.versions[0]).toMatchObject({
      version: 1,
      kind: 'draft',
      amount_cents: 5000,
      review_id: 'review',
    })
    expect(draft.versions[0]!.lines.map((l) => l.seconds)).toEqual([7200, -3600])
    expect((await f.store.report('2026-09', 2)).people[0]!.invoices).toEqual([])
    const received = await f.save({
      id: 'received',
      invoice_id: draft.id,
      expected_version: 1,
      kind: 'received',
      from_review: false,
      lines: draft.versions[0]!.lines,
      reason: 'Received and checked contractor invoice',
    })
    expect(received.versions).toHaveLength(2)
    expect(received.matched_cents).toBe(5000)
    expect((await f.store.report('2026-09')).people[0]).toMatchObject({
      earned_cents: 5000,
      invoiced_cents: 5000,
      matched_invoice_cents: 5000,
      uninvoiced_cents: 0,
    })
    expect(
      (await f.store.report('2026-09', 2)).people[0]!.invoices[0]!.versions.map((v) => v.kind),
    ).toEqual(['received'])
    expect((await f.store.report('2026-09', 3)).people).toEqual([])
    expect(await f.money()).toEqual(before)
  }, 30000)
  it('replays a command, refuses reused IDs and duplicate contractor references, and serializes concurrent corrections', async () => {
    const f = await fixture(runtime)
    await f.review()
    const first = await f.save()
    await f.save()
    expect((await f.store.report('2026-09')).people[0]!.invoices).toHaveLength(1)
    await expect(f.save({ reason: 'Different payload' })).rejects.toThrow(/identifier/)
    await expect(f.save({ id: 'another', reference: ' c-001 ' })).rejects.toThrow(/changed/)
    const corrections = await Promise.allSettled(
      ['a', 'b'].map((id) =>
        f.save({ id, invoice_id: first.id, expected_version: 1, reason: 'Corrected draft' }),
      ),
    )
    expect(corrections.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect((await f.store.report('2026-09')).people[0]!.invoices[0]!.versions).toHaveLength(2)
    await expect(f.exec('DELETE FROM staff_invoice_versions')).rejects.toThrow(/immutable/)
  }, 30000)
  it('keeps mismatched and overlapping received documents reviewable without inventing another obligation or netting currencies', async () => {
    const f = await fixture(runtime)
    await f.review()
    const lines = [
      { description: 'Work', entry_id: 10, project_id: 1, seconds: 7200, rate_cents: 5000 },
    ]
    await f.save({ id: 'one', kind: 'received', from_review: false, lines })
    await f.save({ id: 'two', reference: 'C-002', kind: 'received', from_review: false, lines })
    const person = (await f.store.report('2026-09')).people[0]!
    expect(person).toMatchObject({
      earned_cents: 10000,
      invoiced_cents: 20000,
      matched_invoice_cents: 0,
      uninvoiced_cents: 10000,
    })
    expect(
      person.invoices.every((i) => i.flags.includes('Received invoice lines overlap this earning')),
    ).toBe(true)
    await f.save({
      id: 'euro',
      reference: 'C-EUR',
      currency: 'EUR',
      kind: 'received',
      from_review: false,
      lines: [{ ...lines[0]!, entry_id: null, project_id: null, rate_cents: 6000 }],
    })
    const foreign = (await f.store.report('2026-09')).people.find((p) => p.currency === 'EUR')!
    expect(foreign).toMatchObject({
      earned_cents: null,
      invoiced_cents: 12000,
      matched_invoice_cents: 0,
      uninvoiced_cents: null,
    })
    expect(foreign.invoices[0]!.flags).toContain('No matching reviewed earning')
    expect(
      (await f.ledger.report('2026-09', '2026-10-01')).rows.find((p) => p.user_id === 2),
    ).toMatchObject({ amount_cents: 10000, paid_cents: 0 })
  }, 30000)
  it('supports a settled advance before earnings and invoice, and requires explicit review for corrections after payment', async () => {
    const f = await fixture(runtime)
    const provider: PaymentProvider = {
      quote: vi.fn(async () => ({
        id: 'q',
        profile_id: '123',
        recipient_id: '456',
        recipient_name: 'Person Two',
        source_currency: 'USD',
        target_currency: 'USD',
        source_cents: 2050,
        target_cents: 2000,
        fee_cents: 50,
        rate: 1,
        expires_at: '2026-08-01T13:00:00.000Z',
        estimated_arrival: null,
      })),
      create: vi.fn(),
      fund: vi.fn(),
      read: vi.fn(),
    }
    const runs = createPaymentRunsService(f.db, provider),
      early = '2026-08-01T12:00:00.000Z'
    const run = await runs.preview(
      {
        id: crypto.randomUUID(),
        name: 'Deposit',
        source_currency: 'USD',
        scheduled_at: early,
        timezone: 'UTC',
        items: [
          {
            purpose: 'advance',
            currency: 'USD',
            advance_reason: 'Deposit before work',
            user_id: 2,
            month: '2026-09',
            amount_cents: 2000,
            expected_version: 0,
          },
        ],
      },
      1,
      'preview',
      early,
    )
    await runs.approve(
      run.id,
      { limits: [{ item_id: run.items[0]!.id, max_source_cents: 2100 }] },
      1,
      'approve',
      early,
    )
    await f.exec(
      `UPDATE payment_run_items SET state='paid',transfer_id='advance-transfer',updated_at='${early}' WHERE id='${run.items[0]!.id}'`,
    )
    await f.review()
    await runs.advances!.apply(
      {
        id: 'apply',
        advance_item_id: run.items[0]!.id,
        user_id: 2,
        month: '2026-09',
        currency: 'USD',
        amount_cents: 1000,
        scope: 'entry',
        project_id: 1,
        entry_id: 10,
        reason: 'Apply deposit',
      },
      1,
      'apply',
      now,
    )
    const before = await f.money(),
      invoice = await f.save({ kind: 'received' })
    await expect(
      f.save({
        id: 'correction',
        invoice_id: invoice.id,
        expected_version: 1,
        kind: 'received',
        reason: 'Fix received invoice',
      }),
    ).rejects.toThrow(/changed/)
    const corrected = await f.save({
      id: 'correction',
      invoice_id: invoice.id,
      expected_version: 1,
      kind: 'received',
      reason: 'Fix received invoice',
      acknowledge_paid_history: true,
    })
    expect(corrected.flags).toContain(
      'Corrected after payment: review allocations separately; payments were preserved',
    )
    const moved = await f.save({
      id: 'move-paid',
      invoice_id: invoice.id,
      expected_version: 2,
      month: '2026-08',
      currency: 'EUR',
      kind: 'received',
      from_review: false,
      lines: corrected.versions.at(-1)!.lines,
      reason: 'Correct foreign-currency document period',
      acknowledge_paid_history: true,
    })
    expect(moved.versions.at(-1)).toMatchObject({
      paid_cents_at_recording: 0,
      has_payment_history: true,
      currency: 'EUR',
      month: '2026-08',
    })
    expect(await f.money()).toEqual(before)
    expect((await runs.advances!.report('2026-10-01', '2026-10-31')).advances[0]).toMatchObject({
      settled_cents: 2000,
      applied_cents: 1000,
      available_cents: 1000,
    })
  }, 30000)
  it('shares an attachment only after it belongs to this invoice and is included in a received version', async () => {
    const f = await fixture(runtime)
    await f.review()
    const invoice = await f.save()
    const hash = 'a'.repeat(64),
      document = {
        id: 'document',
        invoice_id: invoice.id,
        content_hash: hash,
        file_key: `sha256/aa/${hash}`,
        name: 'invoice.pdf',
        byte_size: 100,
        content_type: 'application/pdf',
      }
    await f.store.recordDocument(document, 1, 'upload', now)
    await f.store.recordDocument(document, 1, 'upload', now)
    expect(await f.store.document(invoice.id, 'document', 2)).toBeNull()
    await f.save({
      id: 'received',
      invoice_id: invoice.id,
      expected_version: 1,
      kind: 'received',
      document_id: 'document',
    })
    expect(await f.store.document(invoice.id, 'document', 2)).toMatchObject({ name: 'invoice.pdf' })
    expect(await f.store.document(invoice.id, 'document', 3)).toBeNull()
    const privateHash='b'.repeat(64)
    await f.store.recordDocument({...document,id:'private-document',content_hash:privateHash,file_key:`sha256/bb/${privateHash}`,name:'private.pdf'},1,'stage',now)
    await f.save({id:'void-document',invoice_id:invoice.id,expected_version:2,kind:'void',from_review:false,lines:invoice.versions[0]!.lines,document_id:'private-document',reason:'Void superseded received document'})
    expect((await f.store.report('2026-09',2)).people[0]!.invoices[0]!.versions.at(-1)!.document_id).toBeNull()
    expect(await f.store.document(invoice.id,'private-document',2)).toBeNull()
    const other = await f.save({ id: 'other', reference: 'C-002' })
    await expect(
      f.save({
        id: 'steal-file',
        invoice_id: other.id,
        expected_version: 1,
        document_id: 'document',
      }),
    ).rejects.toThrow(/changed/)
    await expect(f.exec("UPDATE staff_invoice_documents SET name='rewrite.pdf'")).rejects.toThrow(
      /immutable/,
    )
  }, 30000)
  it('corrects the work period and currency through versions without moving either period’s payments', async () => {
    const f = await fixture(runtime)
    await f.review()
    const original = await f.save({ kind: 'received' })
    const before = await f.money()
    const moved = await f.save({
      id: 'move',
      invoice_id: original.id,
      expected_version: 1,
      month: '2026-08',
      currency: 'EUR',
      kind: 'received',
      from_review: false,
      lines: original.versions[0]!.lines,
      reason: 'Correct period and currency on received document',
    })
    expect(moved).toMatchObject({ month: '2026-08', currency: 'EUR' })
    expect(moved.versions.map((v) => [v.month, v.currency])).toEqual([
      ['2026-09', 'USD'],
      ['2026-08', 'EUR'],
    ])
    expect((await f.store.report('2026-09')).people[0]!.invoices).toEqual([])
    expect((await f.store.report('2026-08')).people[0]!.invoices).toHaveLength(1)
    expect(await f.money()).toEqual(before)
  }, 30000)
})
