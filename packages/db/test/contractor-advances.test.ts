import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { sql } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { createPaymentRunsService } from '../src/payment-runs.js'
import { createStaffPaymentStore } from '../src/staff-payments.js'
import type { ApplyAdvanceCredit, PaymentProvider, PaymentRunCommand } from '@ezacto/core'

const now = '2026-08-01T12:00:00.000Z'
const future = '2026-10-01T12:00:00.000Z'
let dispose: (() => Promise<void>) | undefined
afterEach(async () => {
  await dispose?.()
  dispose = undefined
})
const fixture = async (runtime: 'sqlite' | 'd1') => {
  let database: ReturnType<typeof createContainerDatabase>
  if (runtime === 'sqlite') {
    const sqlite = new BetterSqlite3(':memory:')
    migrateContainer(sqlite)
    database = createContainerDatabase(sqlite)
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
    database = createD1Database(binding) as never
    dispose = () => mf.dispose()
  }
  const exec = async (query: string) => {
    try {
      await database.run(sql.raw(query))
    } catch (error) {
      let cause = error
      while (cause instanceof Error && cause.cause) cause = cause.cause
      throw cause
    }
  }
  await exec(
    `INSERT INTO organizations(name,modules,created_at,updated_at) VALUES('Fixture','{}','${now}','${now}')`,
  )
  await exec(`INSERT INTO users(id,first_name,last_name,profile,manager_grants,is_contractor,created_at,updated_at) VALUES
    (1,'Admin','One','administrator','[]',0,'${now}','${now}'),(2,'Person','Two','member','[]',1,'${now}','${now}'),(3,'Other','Person','member','[]',1,'${now}','${now}')`)
  await exec(
    `INSERT INTO user_payout_accounts(id,user_id,provider,external_id,linked_by_user_id,linked_at,verified_at,created_at,updated_at) VALUES(1,2,'wise','456',1,'${now}','${now}','${now}','${now}')`,
  )
  await exec(
    `INSERT INTO clients(id,name,currency,created_at,updated_at) VALUES(1,'Client','USD','${now}','${now}')`,
  )
  await exec(
    `INSERT INTO projects(id,client_id,name,created_at,updated_at) VALUES(1,1,'Project','${now}','${now}'),(2,1,'Other','${now}','${now}')`,
  )
  const provider: PaymentProvider = {
    quote: vi.fn(async (_destination, source, target, amount) => ({
      id: 'quote',
      profile_id: '123',
      recipient_id: '456',
      recipient_name: 'Person Two',
      source_currency: source,
      target_currency: target,
      source_cents: amount + 50,
      target_cents: amount,
      fee_cents: 50,
      rate: 1,
      expires_at: '2026-08-01T13:00:00.000Z',
      estimated_arrival: null,
    })),
    create: vi.fn(async () => {
      throw new Error('No live funds')
    }),
    fund: vi.fn(async () => 'accepted' as const),
    read: vi.fn(async () => {
      throw new Error('No live funds')
    }),
  }
  const service = createPaymentRunsService(database, provider)
  const credits = service.advances!
  const ledger = createStaffPaymentStore(database)
  const command: PaymentRunCommand = {
    id: crypto.randomUUID(),
    name: 'Advance before work',
    source_currency: 'USD',
    scheduled_at: now,
    timezone: 'UTC',
    items: [
      {
        user_id: 2,
        month: '2026-09',
        expected_version: 0,
        amount_cents: 15000,
        purpose: 'advance',
        currency: 'USD',
        advance_project_id: 1,
        advance_reason: 'Deposit for future work',
      },
    ],
  }
  const run = await service.preview(command, 1, 'preview', now)
  const item = run.items[0]!
  const approve = () =>
    service.approve(
      run.id,
      { limits: [{ item_id: item.id, max_source_cents: 15100 }] },
      1,
      'approve',
      now,
    )
  const settle = async () => {
    await approve()
    // Simulated provider confirmation after approval; same DB transition as the processor.
    await exec(
      `UPDATE payment_run_items SET state='paid',transfer_id='transfer-1',updated_at='${now}' WHERE id='${item.id}'`,
    )
  }
  const review = async () => {
    await exec(
      `INSERT INTO tasks(id,name,created_at,updated_at) VALUES(1,'Task','${now}','${now}')`,
    )
    await exec(
      `INSERT INTO user_assignments(id,project_id,user_id,created_at,updated_at) VALUES(1,1,2,'${now}','${now}')`,
    )
    await exec(
      `INSERT INTO task_assignments(id,project_id,task_id,billable,created_at,updated_at) VALUES(1,1,1,1,'${now}','${now}')`,
    )
    await exec(`INSERT INTO time_entries(id,user_id,project_id,task_id,user_assignment_id,task_assignment_id,spent_date,seconds,seconds_without_timer,rounded_seconds,billable,cost_rate_cents,created_at,updated_at)
      VALUES(10,2,1,1,1,1,'2026-09-15',14400,14400,14400,1,5000,'${future}','${future}')`)
    const entries = (await ledger.actuals!('2026-09', future)).people.find(
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
      future,
    )
  }
  const apply = (over: Partial<ApplyAdvanceCredit> = {}) =>
    credits.apply(
      {
        id: 'apply-1',
        advance_item_id: item.id,
        user_id: 2,
        currency: 'USD',
        month: '2026-09',
        amount_cents: 4000,
        scope: 'entry',
        project_id: 1,
        entry_id: 10,
        reason: 'Apply deposit to reviewed work',
        ...over,
      },
      1,
      'apply',
      future,
    )
  const balance = async () => (await credits.report('2026-10-01', '2026-10-31')).advances[0]!
  const paid = async () =>
    (await ledger.report('2026-09', '2026-09-30')).rows.find((r) => r.user_id === 2)!
  return {
    database,
    exec,
    service,
    provider,
    credits,
    ledger,
    command,
    run,
    item,
    approve,
    settle,
    review,
    apply,
    balance,
    paid,
  }
}

describe.each(['sqlite', 'd1'] as const)('contractor advance credit on %s', (runtime) => {
  it('previews before earnings, reserves pending funds without consuming monthly balances, and creates credit only on settlement', async () => {
    const f = await fixture(runtime)
    expect(f.item).toMatchObject({
      purpose: 'advance',
      advance_project_id: 1,
      advance_reason: 'Deposit for future work',
      currency: 'USD',
    })
    expect(await f.balance()).toMatchObject({
      settled_cents: 0,
      reserved_cents: 0,
      available_cents: 0,
    })
    await f.approve()
    expect(await f.balance()).toMatchObject({
      settled_cents: 0,
      reserved_cents: 15000,
      available_cents: 0,
    })
    expect(await f.paid()).toMatchObject({ amount_cents: null, paid_cents: 0, reserved_cents: 0 })
    await expect(f.apply()).rejects.toThrow(/changed/)
    await f.review()
    expect(await f.paid()).toMatchObject({ amount_cents: 20000, paid_cents: 0, reserved_cents: 0 })
    await f.settle()
    expect(await f.balance()).toMatchObject({
      settled_cents: 15000,
      reserved_cents: 0,
      available_cents: 15000,
    })
    expect(await f.paid()).toMatchObject({ amount_cents: 20000, paid_cents: 0 })
    expect(f.provider.create).not.toHaveBeenCalled()
  }, 30000)

  it('carries a deposit across months, applies once to future earnings, and reconciles partial return without creating another earning', async () => {
    const f = await fixture(runtime)
    await f.settle()
    await f.review()
    await f.apply()
    await f.apply()
    expect(await f.paid()).toMatchObject({
      amount_cents: 20000,
      paid_cents: 4000,
      balance_cents: 16000,
    })
    expect(await f.balance()).toMatchObject({
      opening_cents: 15000,
      period_settled_cents: 0,
      period_applied_cents: 4000,
      closing_cents: 11000,
      applied_cents: 4000,
      available_cents: 11000,
    })
    const target = (await f.ledger.allocationReport!('2026-09')).people.find(
      (p) => p.user_id === 2,
    )!
    expect(target.projects[0]!.entries[0]).toMatchObject({
      earned_cents: 20000,
      applied_cents: 4000,
    })
    const returned = {
      id: 'return-1',
      advance_item_id: f.item.id,
      amount_cents: 1000,
      reference: 'confirmed-bank-return',
      reason: 'Unneeded portion returned',
    }
    await f.credits.recordReturn(returned, 1, 'return', future)
    await f.credits.recordReturn(returned, 1, 'return', future)
    expect(await f.balance()).toMatchObject({
      returned_cents: 1000,
      period_returned_cents: 1000,
      closing_cents: 10000,
      available_cents: 10000,
    })
    await expect(
      f.credits.recordReturn({ ...returned, id: 'return-2' }, 1, 'return', future),
    ).rejects.toThrow(/changed/)
    await expect(f.apply({ amount_cents: 5000 })).rejects.toThrow(/identifier/)
  }, 30000)

  it('rolls back payment and credit together on an ineligible target, and isolates person/currency for every writer', async () => {
    const f = await fixture(runtime)
    await f.settle()
    await f.review()
    for (const over of [
      { project_id: 2 },
      { entry_id: 999 },
      { user_id: 3 },
      { currency: 'EUR' },
      { month: '2026-10' },
    ])
      await expect(f.apply(over)).rejects.toThrow(/changed/)
    expect(await f.paid()).toMatchObject({ paid_cents: 0 })
    expect(await f.balance()).toMatchObject({ applied_cents: 0, available_cents: 15000 })
    await expect(
      f.exec(`INSERT INTO staff_advance_applications(id,advance_item_id,user_id,currency,month,amount_cents,scope,project_id,entry_id,reason,command_json,actor_id,recorded_at,request_id)
      VALUES('raw','${f.item.id}',3,'USD','2026-09',1000,'month',NULL,NULL,'test','{}',1,'${future}','raw')`),
    ).rejects.toThrow(/advance credit/)
  }, 30000)

  it('allows only one concurrent application to spend the same remaining credit', async () => {
    const f = await fixture(runtime)
    await f.settle()
    await f.review()
    const raced = await Promise.allSettled([
      f.apply({ id: 'one', amount_cents: 9000 }),
      f.apply({ id: 'two', amount_cents: 9000 }),
    ])
    expect(raced.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(await f.balance()).toMatchObject({ applied_cents: 9000, available_cents: 6000 })
    expect(await f.paid()).toMatchObject({ paid_cents: 9000 })
  }, 30000)

  it('reverses an application without deleting history and cannot return credit still applied', async () => {
    const f = await fixture(runtime)
    await f.settle()
    await f.review()
    await f.apply()
    await expect(
      f.credits.recordReturn(
        {
          id: 'return',
          advance_item_id: f.item.id,
          amount_cents: 12000,
          reference: 'bank',
          reason: 'Return',
        },
        1,
        'return',
        future,
      ),
    ).rejects.toThrow(/changed/)
    const reversal = { id: 'reverse', application_id: 'apply-1', reason: 'Wrong work month' }
    await f.credits.reverse(reversal, 1, 'reverse', future)
    await f.credits.reverse(reversal, 1, 'reverse', future)
    expect(await f.paid()).toMatchObject({ paid_cents: 0 })
    expect(await f.balance()).toMatchObject({
      applied_cents: 0,
      available_cents: 15000,
      applications: [{ reversal_reason: 'Wrong work month' }],
    })
    await expect(f.exec('DELETE FROM staff_advance_applications')).rejects.toThrow(/immutable/)
    await f.credits.recordReturn(
      {
        id: 'returned',
        advance_item_id: f.item.id,
        amount_cents: 1000,
        reference: 'confirmed',
        reason: 'Unused credit returned',
      },
      1,
      'return',
      future,
    )
    await expect(f.exec('UPDATE staff_advance_returns SET amount_cents=1')).rejects.toThrow(
      /immutable/,
    )
    await expect(
      f.exec(`UPDATE payment_run_items SET purpose='earnings' WHERE id='${f.item.id}'`),
    ).rejects.toThrow(/immutable/)
  }, 30000)

  it('releases pending credit on cancellation and returns settled credit with immutable application reversal on provider refund', async () => {
    const f = await fixture(runtime)
    await f.approve()
    await f.service.cancel(f.run.id, 1, 'cancel', now)
    expect(await f.balance()).toMatchObject({
      state: 'cancelled',
      reserved_cents: 0,
      available_cents: 0,
    })
    const second = await f.service.preview(
      { ...f.command, id: crypto.randomUUID() },
      1,
      'again',
      now,
    )
    const item = second.items[0]!
    await f.service.approve(
      second.id,
      { limits: [{ item_id: item.id, max_source_cents: 15100 }] },
      1,
      'approve',
      now,
    )
    await f.exec(
      `UPDATE payment_run_items SET state='paid',transfer_id='transfer-2',updated_at='${now}' WHERE id='${item.id}'`,
    )
    await f.review()
    await f.apply({ advance_item_id: item.id })
    await f.exec(
      `UPDATE payment_run_items SET state='failed',provider_status='funds_refunded',updated_at='${future}' WHERE id='${item.id}'`,
    )
    const credit = (await f.credits.report('2026-10-01', '2026-10-31')).advances.find(
      (a) => a.advance_item_id === item.id,
    )!
    expect(credit).toMatchObject({
      applied_cents: 0,
      returned_cents: 15000,
      closing_cents: 0,
      available_cents: 0,
      applications: [{ reversal_reason: 'Provider confirmed advance refund' }],
    })
    expect(await f.paid()).toMatchObject({ amount_cents: 20000, paid_cents: 0 })
  }, 30000)
})

it('funds an advance through the existing reviewed processor and creates credit exactly once on confirmed settlement', async () => {
  const f = await fixture('sqlite')
  let state = 'incoming_payment_waiting'
  const transfer = () => ({
    id: 'provider-transfer',
    status: state,
    customer_transaction_id: f.item.id,
    recipient_id: '456',
    target_cents: 15000,
    target_currency: 'USD',
  })
  vi.mocked(f.provider.create).mockImplementation(async () => transfer())
  vi.mocked(f.provider.fund).mockImplementation(async () => {
    state = 'processing'
    return 'accepted'
  })
  vi.mocked(f.provider.read).mockImplementation(async () => transfer())
  await f.approve()
  for (let tick = 0; tick < 4; tick++) await f.service.processDue(now)
  expect(f.provider.create).toHaveBeenCalledTimes(1)
  expect(f.provider.fund).toHaveBeenCalledTimes(1)
  expect(await f.balance()).toMatchObject({
    settled_cents: 0,
    available_cents: 0,
    reserved_cents: 15000,
  })
  state = 'outgoing_payment_sent'
  await f.service.processDue('2026-08-01T13:00:00.000Z')
  await f.service.processDue('2026-08-01T14:00:00.000Z')
  expect(await f.balance()).toMatchObject({
    settled_cents: 15000,
    available_cents: 15000,
    reserved_cents: 0,
  })
  expect(await f.paid()).toMatchObject({ amount_cents: null, paid_cents: 0 })
})
