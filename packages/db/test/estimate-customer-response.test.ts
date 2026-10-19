import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { estimateContentHash, type EstimateContentSource } from '../src/estimates.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import {
  createMoneyResourceRepository,
  MoneyResourceOperationError,
  type MoneyResourceDatabase,
  type MoneyResourceRepository,
} from '../src/money-resources.js'

interface Harness {
  repo: MoneyResourceRepository
  run(sql: string, ...params: unknown[]): Promise<void>
  rows<T>(sql: string, ...params: unknown[]): Promise<T[]>
  close(): Promise<void>
}

const t0 = '2026-10-01T10:00:00.000Z'
const t1 = '2026-10-01T11:00:00.000Z'
const t2 = '2026-10-01T12:00:00.000Z'

const containerHarness = async (): Promise<Harness> => {
  const sqlite = new BetterSqlite3(':memory:')
  migrateContainer(sqlite)
  return {
    repo: createMoneyResourceRepository(
      createContainerDatabase(sqlite) as unknown as MoneyResourceDatabase,
    ),
    run: async (sql, ...params) => {
      sqlite.prepare(sql).run(...params)
    },
    rows: async <T>(sql: string, ...params: unknown[]) => sqlite.prepare(sql).all(...params) as T[],
    close: async () => {
      sqlite.close()
    },
  }
}

const d1Harness = async (): Promise<Harness> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const d1 = await miniflare.getD1Database('DB')
  await migrateD1(d1)
  return {
    repo: createMoneyResourceRepository(createD1Database(d1) as unknown as MoneyResourceDatabase),
    run: async (sql, ...params) => {
      await d1
        .prepare(sql)
        .bind(...params)
        .run()
    },
    rows: async <T>(sql: string, ...params: unknown[]) =>
      (
        await d1
          .prepare(sql)
          .bind(...params)
          .all<T>()
      ).results,
    close: async () => miniflare.dispose(),
  }
}

// Fixed ids: client 1 owns estimates 1 (draft), 2 (sent) and 3 (sent); client 2 owns 4 (sent).
const seed = async (db: Harness): Promise<void> => {
  await db.run(
    `INSERT INTO organizations (name, modules, created_at, updated_at) VALUES ('Org', '{}', ?, ?)`,
    t0,
    t0,
  )
  for (const id of [1, 2]) {
    await db.run(
      `INSERT INTO clients (id, name, currency, created_at, updated_at) VALUES (?, ?, 'USD', ?, ?)`,
      id,
      `Client ${id}`,
      t0,
      t0,
    )
  }
  const contacts: Array<[number, number, string, string]> = [
    [1, 1, 'Alice', 'alice@one.test'],
    [2, 1, 'Bob', 'bob@one.test'],
    [3, 2, 'Carol', 'carol@two.test'],
  ]
  for (const [id, clientId, first, email] of contacts) {
    await db.run(
      `INSERT INTO contacts (id, client_id, first_name, last_name, email, created_at, updated_at)
       VALUES (?, ?, ?, 'Tester', ?, ?, ?)`,
      id,
      clientId,
      first,
      email,
      t0,
      t0,
    )
  }
  const estimateRows: Array<[number, number, string]> = [
    [1, 1, 'EST-1'],
    [2, 1, 'EST-2'],
    [3, 1, 'EST-3'],
    [4, 2, 'EST-4'],
  ]
  for (const [id, clientId, number] of estimateRows) {
    await db.run(
      `INSERT INTO estimates (id, client_id, number, currency, issue_date, amount_cents,
         tax_rate_ppm, tax_amount_cents, created_at, updated_at)
       VALUES (?, ?, ?, 'USD', '2026-10-01', 30000, 100000, 3000, ?, ?)`,
      id,
      clientId,
      number,
      t0,
      t0,
    )
    for (const [position, description, cents] of [
      [0, 'Design', 20000],
      [1, 'Build', 10000],
    ] as const) {
      await db.run(
        `INSERT INTO estimate_line_items (estimate_id, position, kind, description, quantity,
           unit_price_cents, amount_cents, taxed, created_at, updated_at)
         VALUES (?, ?, 'Service', ?, 1, ?, ?, 1, ?, ?)`,
        id,
        position,
        description,
        cents,
        cents,
        t0,
        t0,
      )
    }
  }
}

// Staff message ids are chosen by the caller (large, derived from the command id in
// production); keep them clear of the rowids customer responses are given.
let messageIds = 1_000_000
const staff = async (
  db: Harness,
  estimateId: number,
  eventType: 'send' | 're-open',
): Promise<void> => {
  const current = await db.repo.getEstimate(estimateId)
  messageIds += 1000
  await db.repo.executeEstimateMessage({
    estimateId,
    commandId: `cmd-${messageIds}`,
    actorUserId: 1,
    messageId: messageIds,
    expectedVersion: current!.version,
    eventType,
    sentBy: 'Staff',
    sentByEmail: 'staff@org.test',
    sentFrom: null,
    sentFromEmail: null,
    recipients: eventType === 'send' ? [{ name: 'Alice', email: 'alice@one.test' }] : [],
    subject: null,
    body: null,
    sendMeACopy: false,
    occurredAt: t1,
  })
}

const respond = (
  db: Harness,
  input: {
    estimateId: number
    clientId?: number
    contactId?: number
    decision: 'accept' | 'decline'
    version: string
    occurredAt?: string
  },
) =>
  db.repo.respondToEstimate({
    clientId: 1,
    contactId: 1,
    occurredAt: t2,
    ...input,
  })

const failureCode = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise
  } catch (error) {
    if (error instanceof MoneyResourceOperationError) return error.code
    throw error
  }
  return 'resolved'
}

const counts = async (db: Harness) => ({
  messages: (await db.rows<{ n: number }>(`SELECT count(*) AS n FROM estimate_messages`))[0]!.n,
  invoices: (await db.rows<{ n: number }>(`SELECT count(*) AS n FROM invoices`))[0]!.n,
  payments: (await db.rows<{ n: number }>(`SELECT count(*) AS n FROM invoice_payments`))[0]!.n,
})

const source: EstimateContentSource = {
  number: 'EST-1',
  purchase_order: null,
  subject: 'Website',
  notes: null,
  currency: 'USD',
  issue_date: '2026-10-01',
  tax_rate_ppm: 100000,
  tax2_rate_ppm: null,
  discount_rate_ppm: null,
  amount_cents: 30000,
  tax_amount_cents: 3000,
  tax2_amount_cents: 0,
  discount_amount_cents: 0,
  line_items: [
    {
      position: 0,
      kind: 'Service',
      description: 'Design',
      quantity: 1,
      unit_price_cents: 20000,
      amount_cents: 20000,
      taxed: true,
      taxed2: false,
    },
  ],
}

describe('estimate content version', () => {
  it('is stable for the same content and changes with any customer-visible edit', async () => {
    const base = await estimateContentHash(source)
    expect(base).toMatch(/^[0-9a-f]{64}$/)
    expect(await estimateContentHash({ ...source })).toBe(base)
    const line = source.line_items[0]!
    const edits: EstimateContentSource[] = [
      { ...source, number: 'EST-2' },
      { ...source, purchase_order: 'PO-1' },
      { ...source, subject: 'Website 2' },
      { ...source, notes: 'Net 30' },
      { ...source, currency: 'EUR' },
      { ...source, issue_date: '2026-10-02' },
      { ...source, tax_rate_ppm: 50000 },
      { ...source, tax2_rate_ppm: 10000 },
      { ...source, discount_rate_ppm: 10000 },
      { ...source, amount_cents: 30001 },
      { ...source, tax_amount_cents: 3001 },
      { ...source, tax2_amount_cents: 1 },
      { ...source, discount_amount_cents: 1 },
      { ...source, line_items: [] },
      { ...source, line_items: [line, { ...line, position: 1 }] },
      { ...source, line_items: [{ ...line, description: 'Design!' }] },
      { ...source, line_items: [{ ...line, quantity: 2 }] },
      { ...source, line_items: [{ ...line, unit_price_cents: 20001 }] },
      { ...source, line_items: [{ ...line, amount_cents: 20001 }] },
      { ...source, line_items: [{ ...line, taxed: false }] },
      { ...source, line_items: [{ ...line, taxed2: true }] },
    ]
    const hashes = await Promise.all(edits.map(estimateContentHash))
    expect(new Set([base, ...hashes]).size).toBe(edits.length + 1)
  })

  it('does not depend on the order lines are listed in', async () => {
    const line = source.line_items[0]!
    const second = { ...line, position: 1, description: 'Build' }
    expect(await estimateContentHash({ ...source, line_items: [line, second] })).toBe(
      await estimateContentHash({ ...source, line_items: [second, line] }),
    )
  })
})

describe.each([
  ['container', containerHarness],
  ['D1', d1Harness],
] as const)('customer response to an estimate (%s)', (_name, factory) => {
  let open: Harness | null = null
  afterEach(async () => {
    await open?.close()
    open = null
  })
  const ready = async (): Promise<Harness> => {
    open = await factory()
    await seed(open)
    await staff(open, 2, 'send')
    await staff(open, 3, 'send')
    await staff(open, 4, 'send')
    return open
  }

  it('shows a contact only sent estimates of their own client', async () => {
    const db = await ready()
    expect((await db.repo.listCustomerEstimates(1)).map(({ id }) => id)).toEqual([3, 2])
    expect((await db.repo.listCustomerEstimates(2)).map(({ id }) => id)).toEqual([4])
    expect(await db.repo.getCustomerEstimate(1, 1)).toBeNull() // draft
    expect(await db.repo.getCustomerEstimate(1, 4)).toBeNull() // another client's
    expect(await db.repo.getCustomerEstimate(2, 2)).toBeNull()
    expect(await db.repo.getCustomerEstimate(1, 999)).toBeNull()
    const view = (await db.repo.getCustomerEstimate(1, 2))!
    expect(view).toMatchObject({
      id: 2,
      currency: 'USD',
      state: 'sent',
      answerable: true,
      response: null,
      tax_rate_ppm: 100000,
      tax_amount_cents: 3000,
    })
    expect(view.line_items.map((line) => line.description)).toEqual(['Design', 'Build'])
    expect(view.version).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(view)).not.toContain('client_key')
  })

  it('refuses every cross-client and draft answer without writing', async () => {
    const db = await ready()
    const version = (await db.repo.getCustomerEstimate(1, 2))!.version
    const before = await counts(db)
    // Client 1's contact against client 2's estimate, with their own client id.
    expect(await failureCode(respond(db, { estimateId: 4, decision: 'accept', version }))).toBe(
      'estimate_not_found',
    )
    // Client 2's contact against client 1's estimate.
    expect(
      await failureCode(
        respond(db, { estimateId: 2, clientId: 2, contactId: 3, decision: 'accept', version }),
      ),
    ).toBe('estimate_not_found')
    // A session that claims a client its contact does not belong to.
    expect(
      await failureCode(
        respond(db, { estimateId: 4, clientId: 2, contactId: 1, decision: 'accept', version }),
      ),
    ).toBe('estimate_not_found')
    expect(await failureCode(respond(db, { estimateId: 1, decision: 'accept', version }))).toBe(
      'estimate_not_found',
    )
    expect(await counts(db)).toEqual(before)
    expect((await db.repo.getEstimate(4))!.state).toBe('sent')
  })

  it('records an acceptance against the version shown, by whom and when, and moves no money', async () => {
    const db = await ready()
    const shown = (await db.repo.getCustomerEstimate(1, 2))!
    const before = await counts(db)
    const { estimate, replayed } = await respond(db, {
      estimateId: 2,
      decision: 'accept',
      version: shown.version,
    })
    expect(replayed).toBe(false)
    expect(estimate).toMatchObject({
      state: 'accepted',
      accepted_at: t2,
      answerable: false,
      response: { decision: 'accept', at: t2, by: 'Alice Tester', version: shown.version, current: true },
    })
    expect(
      await db.rows(
        `SELECT event_type, contact_id, content_hash, estimate_version, sent_by, sent_by_email
           FROM estimate_messages WHERE contact_id IS NOT NULL`,
      ),
    ).toEqual([
      {
        event_type: 'accept',
        contact_id: 1,
        content_hash: shown.version,
        estimate_version: 1,
        sent_by: 'Alice Tester',
        sent_by_email: 'alice@one.test',
      },
    ])
    expect(await counts(db)).toEqual({ ...before, messages: before.messages + 1 })
    expect((await db.repo.getEstimate(2))!.declined_at).toBeNull()
  })

  it('records a decline the same way', async () => {
    const db = await ready()
    const shown = (await db.repo.getCustomerEstimate(1, 3))!
    const { estimate } = await respond(db, {
      estimateId: 3,
      contactId: 2,
      decision: 'decline',
      version: shown.version,
    })
    expect(estimate).toMatchObject({
      state: 'declined',
      declined_at: t2,
      accepted_at: null,
      response: { decision: 'decline', by: 'Bob Tester' },
    })
  })

  it('refuses an answer to a version that is not the current content, writing nothing', async () => {
    const db = await ready()
    const before = await counts(db)
    expect(
      await failureCode(respond(db, { estimateId: 2, decision: 'accept', version: 'f'.repeat(64) })),
    ).toBe('estimate_content_changed')
    expect(await counts(db)).toEqual(before)
    expect((await db.repo.getEstimate(2))!.state).toBe('sent')
  })

  it('is idempotent: a repeat of the same answer, by anyone at the client, changes nothing', async () => {
    const db = await ready()
    const { version } = (await db.repo.getCustomerEstimate(1, 2))!
    await respond(db, { estimateId: 2, decision: 'accept', version })
    const after = await counts(db)
    const stamp = (await db.repo.getEstimate(2))!
    const again = await respond(db, {
      estimateId: 2,
      contactId: 2,
      decision: 'accept',
      version,
      occurredAt: '2026-10-02T00:00:00.000Z',
    })
    expect(again.replayed).toBe(true)
    expect(again.estimate.response?.by).toBe('Alice Tester')
    expect(await counts(db)).toEqual(after)
    const unchanged = (await db.repo.getEstimate(2))!
    expect(unchanged.accepted_at).toBe(stamp.accepted_at)
    expect(unchanged.version).toBe(stamp.version)
  })

  it('shows staff who answered, the version they were shown and the version it was recorded against', async () => {
    const db = await ready()
    const { version } = (await db.repo.getCustomerEstimate(1, 2))!
    await respond(db, { estimateId: 2, contactId: 2, decision: 'accept', version })
    const answer = (await db.repo.listEstimateMessages(2))!.find(
      (message) => message.event_type === 'accept',
    )
    expect(answer).toMatchObject({
      sent_by: 'Bob Tester',
      contact_id: 2,
      content_hash: version,
      estimate_version: 1,
      created_at: t2,
    })
    // What staff recorded themselves carries no contact, hash or version.
    const send = (await db.repo.listEstimateMessages(2))!.find(
      (message) => message.event_type === 'send',
    )
    expect(send).toMatchObject({ contact_id: null, content_hash: null, estimate_version: null })
  })

  it('refuses the opposite answer after one is recorded, in both directions', async () => {
    const db = await ready()
    const two = (await db.repo.getCustomerEstimate(1, 2))!.version
    const three = (await db.repo.getCustomerEstimate(1, 3))!.version
    await respond(db, { estimateId: 2, decision: 'accept', version: two })
    await respond(db, { estimateId: 3, decision: 'decline', version: three })
    const after = await counts(db)
    expect(await failureCode(respond(db, { estimateId: 2, decision: 'decline', version: two }))).toBe(
      'estimate_state_conflict',
    )
    expect(await failureCode(respond(db, { estimateId: 3, decision: 'accept', version: three }))).toBe(
      'estimate_state_conflict',
    )
    expect(await counts(db)).toEqual(after)
    expect((await db.repo.getEstimate(2))!.state).toBe('accepted')
    expect((await db.repo.getEstimate(3))!.state).toBe('declined')
  })

  it('lets exactly one of two racing answers win', async () => {
    const db = await ready()
    const { version } = (await db.repo.getCustomerEstimate(1, 2))!
    const settled = await Promise.allSettled([
      respond(db, { estimateId: 2, contactId: 1, decision: 'accept', version }),
      respond(db, { estimateId: 2, contactId: 2, decision: 'decline', version }),
    ])
    expect(settled.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    const loser = settled.find(({ status }) => status === 'rejected') as PromiseRejectedResult
    expect((loser.reason as MoneyResourceOperationError).code).toBe('estimate_state_conflict')
    expect(
      await db.rows(`SELECT count(*) AS n FROM estimate_messages WHERE estimate_version IS NOT NULL`),
    ).toEqual([{ n: 1 }])
  })

  it('treats two racing identical answers as one recorded answer and one replay', async () => {
    const db = await ready()
    const { version } = (await db.repo.getCustomerEstimate(1, 2))!
    const results = await Promise.all([
      respond(db, { estimateId: 2, contactId: 1, decision: 'accept', version }),
      respond(db, { estimateId: 2, contactId: 2, decision: 'accept', version }),
    ])
    expect(results.map(({ replayed }) => replayed).sort()).toEqual([false, true])
    expect(
      await db.rows(`SELECT count(*) AS n FROM estimate_messages WHERE event_type = 'accept'`),
    ).toEqual([{ n: 1 }])
  })

  it('does not let an edit to a sent estimate be answered until it is sent again', async () => {
    const db = await ready()
    const old = (await db.repo.getCustomerEstimate(1, 2))!
    // A staff edit: content changes and the version moves on, as every command does.
    await db.run(
      `UPDATE estimate_line_items SET amount_cents = 25000, unit_price_cents = 25000
        WHERE estimate_id = 2 AND position = 1`,
    )
    await db.run(`UPDATE estimates SET amount_cents = 45000, version = version + 1 WHERE id = 2`)
    const edited = (await db.repo.getCustomerEstimate(1, 2))!
    expect(edited.version).not.toBe(old.version)
    expect(edited).toMatchObject({ state: 'sent', answerable: false })
    const before = await counts(db)
    expect(
      await failureCode(respond(db, { estimateId: 2, decision: 'accept', version: old.version })),
    ).toBe('estimate_content_changed')
    expect(
      await failureCode(respond(db, { estimateId: 2, decision: 'accept', version: edited.version })),
    ).toBe('estimate_needs_resend')
    expect(await counts(db)).toEqual(before)

    await staff(db, 2, 'send')
    expect((await db.repo.getCustomerEstimate(1, 2))!.answerable).toBe(true)
    const { estimate } = await respond(db, {
      estimateId: 2,
      decision: 'accept',
      version: edited.version,
    })
    expect(estimate.response).toMatchObject({ version: edited.version, current: true })
  })

  it('keeps an acceptance as history but never reuses it for edited content', async () => {
    const db = await ready()
    const old = (await db.repo.getCustomerEstimate(1, 2))!
    await respond(db, { estimateId: 2, decision: 'accept', version: old.version })
    await db.run(`UPDATE estimates SET notes = 'Changed terms', version = version + 1 WHERE id = 2`)
    const edited = (await db.repo.getCustomerEstimate(1, 2))!
    expect(edited.state).toBe('accepted')
    expect(edited.response).toMatchObject({ version: old.version, current: false })
    // The old acceptance cannot be replayed onto the new content ...
    expect(
      await failureCode(respond(db, { estimateId: 2, decision: 'accept', version: edited.version })),
    ).toBe('estimate_state_conflict')
    // ... and a fresh answer takes a re-open, a re-send, and a response to the new version.
    await staff(db, 2, 're-open')
    expect((await db.repo.getCustomerEstimate(1, 2))!.answerable).toBe(false)
    await staff(db, 2, 'send')
    const { estimate } = await respond(db, {
      estimateId: 2,
      contactId: 2,
      decision: 'accept',
      version: edited.version,
    })
    expect(estimate.response).toMatchObject({ by: 'Bob Tester', version: edited.version, current: true })
    expect(
      await db.rows(
        `SELECT contact_id, content_hash FROM estimate_messages
          WHERE estimate_id = 2 AND event_type = 'accept' ORDER BY id`,
      ),
    ).toEqual([
      { contact_id: 1, content_hash: old.version },
      { contact_id: 2, content_hash: edited.version },
    ])
  })

  it('does not let an estimate imported as already sent be answered before it is sent', async () => {
    const db = await ready()
    await db.run(
      `UPDATE estimates SET state = 'sent', sent_at = ?, sent_content_hash = NULL WHERE id = 1`,
      t0,
    )
    const view = (await db.repo.getCustomerEstimate(1, 1))!
    expect(view.answerable).toBe(false)
    expect(
      await failureCode(respond(db, { estimateId: 1, decision: 'accept', version: view.version })),
    ).toBe('estimate_needs_resend')
  })

  it('refuses a customer response row that is incomplete or malformed', async () => {
    const db = await ready()
    const insert = (contact: number | null, hash: string | null, version: number | null, event: string) =>
      db.run(
        `INSERT INTO estimate_messages (estimate_id, event_type, contact_id, content_hash,
           estimate_version, created_at, updated_at) VALUES (2, ?, ?, ?, ?, ?, ?)`,
        event,
        contact,
        hash,
        version,
        t1,
        t1,
      )
    await expect(insert(1, null, 7, 'accept')).rejects.toThrow()
    await expect(insert(null, 'a'.repeat(64), 7, 'accept')).rejects.toThrow()
    await expect(insert(1, 'a'.repeat(64), 7, 'send')).rejects.toThrow()
    await expect(insert(1, 'A'.repeat(64), 7, 'accept')).rejects.toThrow()
    await expect(insert(1, 'a'.repeat(64), 7, 'accept')).resolves.toBeUndefined()
    await expect(insert(2, 'b'.repeat(64), 7, 'decline')).rejects.toThrow()
    await expect(
      db.run(`UPDATE estimate_messages SET content_hash = ? WHERE estimate_version = 7`, 'c'.repeat(64)),
    ).rejects.toThrow()
  })
})
