import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { compareInvoiceListPositions, type InvoiceListPosition } from '@ezacto/core'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import {
  createMoneyResourceRepository,
  type InvoiceListWindow,
  type InvoiceResource,
  type MoneyResourceDatabase,
} from '../src/money-resources.js'

/**
 * The invoice list read newest first (`compareInvoiceListPositions`).
 *
 * It paged by id, ascending, and on a real book that buried every new invoice:
 * the Harvest import numbered its invoices newest first, so id 1 was the most
 * recent import, and an invoice raised here took either the next id or one
 * derived from a hash. A paid invoice an operator went looking for sat behind
 * page after page of "Load more" and read as gone.
 *
 * These run the repository's own SQL on both runtimes, because the order is
 * decided there and checked against `@ezacto/core` by the endpoint: a
 * disagreement between the two is a page the endpoint refuses to serve.
 */

interface TestDatabase {
  orm: MoneyResourceDatabase
  run(sql: string, ...params: unknown[]): Promise<void>
  close(): Promise<void>
}

const seededAt = '2026-09-01T10:00:00.000Z'

const containerDatabase = async (): Promise<TestDatabase> => {
  const client = new BetterSqlite3(':memory:')
  migrateContainer(client)
  return {
    orm: createContainerDatabase(client) as MoneyResourceDatabase,
    run: async (sql, ...params) => {
      client.prepare(sql).run(...params)
    },
    close: async () => {
      client.close()
    },
  }
}

const d1Database = async (): Promise<TestDatabase> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const client = await miniflare.getD1Database('DB')
  await migrateD1(client)
  return {
    orm: createD1Database(client) as MoneyResourceDatabase,
    run: async (sql, ...params) => {
      await client
        .prepare(sql)
        .bind(...params)
        .run()
    },
    close: async () => miniflare.dispose(),
  }
}

const factories = [
  ['container', containerDatabase],
  ['D1', d1Database],
] as const

let open: TestDatabase | null = null

afterEach(async () => {
  await open?.close()
  open = null
})

interface SeedInvoice {
  id: number
  number: string
  issueDate: string
  clientId?: number
  state?: 'draft' | 'open' | 'paid' | 'closed'
  createdAt?: string
}

const fixture = async (
  factory: () => Promise<TestDatabase>,
  invoices: readonly SeedInvoice[],
): Promise<TestDatabase> => {
  const database = await factory()
  open = database
  await database.run(
    `INSERT INTO clients (id, name, currency, created_at, updated_at)
     VALUES (1, 'Kestrel Environmental', 'USD', ?, ?), (2, 'Northpeak Surveying', 'USD', ?, ?)`,
    seededAt,
    seededAt,
    seededAt,
    seededAt,
  )
  for (const invoice of invoices) await insertInvoice(database, invoice)
  return database
}

const insertInvoice = async (database: TestDatabase, invoice: SeedInvoice): Promise<void> => {
  const state = invoice.state ?? 'draft'
  await database.run(
    `INSERT INTO invoices (
       id, client_id, number, currency, issue_date, due_date, state, paid_at,
       created_at, updated_at
     ) VALUES (?, ?, ?, 'USD', ?, ?, ?, ?, ?, ?)`,
    invoice.id,
    invoice.clientId ?? 1,
    invoice.number,
    invoice.issueDate,
    invoice.issueDate,
    state,
    // The shape trigger wants a paid invoice to carry exactly one paid stamp.
    state === 'paid' ? seededAt : null,
    invoice.createdAt ?? seededAt,
    invoice.createdAt ?? seededAt,
  )
}

const positionOf = (invoice: Pick<InvoiceResource, 'issue_date' | 'number' | 'id'>) => ({
  issueDate: invoice.issue_date,
  number: invoice.number,
  id: invoice.id,
})

/** Every page of the list, `take` at a time, as the endpoint walks it. */
const walk = async (
  database: TestDatabase,
  take: number,
  narrowing: Pick<InvoiceListWindow, 'states' | 'clientIds' | 'number'> = {},
): Promise<InvoiceResource[]> => {
  const money = createMoneyResourceRepository(database.orm)
  const createdThrough = await money.invoiceListSnapshot()
  if (createdThrough === null) return []
  const rows: InvoiceResource[] = []
  let after: InvoiceListPosition | null = null
  for (;;) {
    const page = await money.listInvoices({ after, createdThrough, take, ...narrowing })
    rows.push(...page)
    if (page.length < take) return rows
    after = positionOf(page.at(-1)!)
  }
}

describe.each(factories)('the invoice list on %s', (_runtime, factory) => {
  it('[money] lists the newest invoice first, whatever its id', async () => {
    // The book as it was found: the import numbered newest first, so the most
    // recent Harvest invoice is id 1; then one raised here at the next id, and
    // one generated from tracked time under a hash-derived id.
    const database = await fixture(factory, [
      { id: 1, number: '4021', issueDate: '2026-03-20' },
      { id: 2, number: '4020', issueDate: '2026-02-28' },
      { id: 3, number: '4019', issueDate: '2026-01-31' },
      { id: 4, number: '4022', issueDate: '2026-03-31' },
      { id: 7_316_402_118_945_027, number: '4023', issueDate: '2026-04-01' },
    ])
    expect((await walk(database, 50)).map((invoice) => invoice.number)).toEqual([
      '4023',
      '4022',
      '4021',
      '4020',
      '4019',
    ])
  })

  it('[unit] sorts exactly as the comparison the endpoint checks each page against', async () => {
    // Every case the two definitions could disagree on: numbers against text,
    // leading zeros, more digits than a double holds, a day mixing the two
    // kinds, and text beyond the basic plane, where UTF-16 and UTF-8 order
    // part ways.
    const numbers = [
      '9',
      '10',
      '1A',
      '010',
      '007',
      '7',
      '0',
      '00',
      'INV-0099',
      'INV-0100',
      'CN-7',
      '90071992547409930',
      '90071992547409929',
      '\u{1F600}',
      'Ａ',
      'a',
      'B',
      ' 12',
      '12 ',
    ]
    const days = ['2026-10-01', '2026-09-30']
    const invoices = numbers.flatMap((number, index) =>
      days.map((issueDate, day) => ({ id: index * 2 + day + 1, number: `${number}|${day}`, issueDate })),
    )
    // Numbers are unique, so the day is part of each one; the pairs are what
    // make every comparison happen on the same date as well as across dates.
    const plain = [
      ...numbers.map((number, index) => ({ id: 100 + index, number, issueDate: '2026-09-15' })),
      ...invoices,
    ]
    const database = await fixture(factory, plain)
    const listed = (await walk(database, 500)).map(positionOf)
    const expected = plain
      .map(({ id, number, issueDate }) => ({ id, number, issueDate }))
      .sort(compareInvoiceListPositions)
    expect(listed).toEqual(expected)
  })

  it('[api] pages the whole list in order, no invoice twice and none missing', async () => {
    const database = await fixture(
      factory,
      Array.from({ length: 23 }, (_, index) => ({
        id: 1000 - index * 37,
        // Several to a day, and numbers that are not in id order, so the walk
        // resumes inside a day as well as across days.
        number: String((index * 7) % 23 + 1),
        issueDate: `2026-09-${String(10 + (index % 5)).padStart(2, '0')}`,
      })),
    )
    const whole = await walk(database, 500)
    expect(whole).toHaveLength(23)
    const positions = whole.map(positionOf)
    expect(positions).toEqual([...positions].sort(compareInvoiceListPositions))
    for (const take of [1, 2, 3, 5, 22, 23, 24]) {
      expect((await walk(database, take)).map(positionOf)).toEqual(positions)
    }
  })

  it('[money] leaves out an invoice created after the traversal began', async () => {
    const database = await fixture(factory, [
      { id: 10, number: '4010', issueDate: '2026-09-03' },
      { id: 11, number: '4011', issueDate: '2026-09-02' },
      { id: 12, number: '4012', issueDate: '2026-09-01' },
    ])
    const money = createMoneyResourceRepository(database.orm)
    const createdThrough = await money.invoiceListSnapshot()
    expect(createdThrough).toBe(seededAt)
    const first = await money.listInvoices({ after: null, createdThrough: createdThrough!, take: 2 })
    expect(first.map((invoice) => invoice.id)).toEqual([10, 11])

    // Created while the first page was on screen, and dated so it sorts into
    // the rest of the list: without the bound it would appear on page two.
    await insertInvoice(database, {
      id: 13,
      number: '4000',
      issueDate: '2026-08-01',
      createdAt: '2026-09-01T10:00:00.001Z',
    })
    const rest = await money.listInvoices({
      after: positionOf(first.at(-1)!),
      createdThrough: createdThrough!,
      take: 2,
    })
    expect(rest.map((invoice) => invoice.id)).toEqual([12])

    // A traversal begun now sees it.
    expect((await walk(database, 50)).map((invoice) => invoice.id)).toEqual([10, 11, 12, 13])
  })

  it('[unit] bounds by the instant, not the text, when stamps carry different fractions', async () => {
    // Imported rows carry Harvest's whole seconds; rows written here carry
    // milliseconds. As text "...:00Z" sorts after "...:00.500Z".
    const database = await fixture(factory, [
      { id: 1, number: '1', issueDate: '2026-09-01', createdAt: '2026-09-01T10:00:00Z' },
      { id: 2, number: '2', issueDate: '2026-09-01', createdAt: '2026-09-01T10:00:00.500Z' },
    ])
    const money = createMoneyResourceRepository(database.orm)
    expect(await money.invoiceListSnapshot()).toBe('2026-09-01T10:00:00.500Z')
    expect(
      (
        await money.listInvoices({
          after: null,
          createdThrough: '2026-09-01T10:00:00.000Z',
          take: 10,
        })
      ).map((invoice) => invoice.id),
    ).toEqual([1])
  })

  it('[api] narrows by state and by client before the page is cut', async () => {
    // The chassis reads take+1 rows as "there is a next page", so a narrowing
    // applied after the read would answer short pages claiming to be the end.
    const database = await fixture(factory, [
      { id: 1, number: '101', issueDate: '2026-09-09', state: 'paid' },
      { id: 2, number: '102', issueDate: '2026-09-08' },
      { id: 3, number: '103', issueDate: '2026-09-07', state: 'open', clientId: 2 },
      { id: 4, number: '104', issueDate: '2026-09-06' },
      { id: 5, number: '105', issueDate: '2026-09-05', state: 'paid', clientId: 2 },
      { id: 6, number: '106', issueDate: '2026-09-04', state: 'open' },
    ])
    expect((await walk(database, 1, { states: ['paid'] })).map((row) => row.id)).toEqual([1, 5])
    expect((await walk(database, 1, { clientIds: [2] })).map((row) => row.id)).toEqual([3, 5])
    expect(
      (await walk(database, 1, { states: ['open', 'paid'], clientIds: [1] })).map((row) => row.id),
    ).toEqual([1, 6])
  })

  it('[money] narrows to one exact number, as text, leading zeros and all', async () => {
    // How a page addressed by number finds its invoice. "089" and "89" are two
    // invoices in a book that has both, and neither is the other's page.
    const database = await fixture(factory, [
      { id: 1, number: '089', issueDate: '2026-09-01' },
      { id: 2, number: '89', issueDate: '2026-09-02' },
      { id: 3, number: '0089', issueDate: '2026-09-03', clientId: 2 },
      { id: 4, number: 'INV-89', issueDate: '2026-09-04', state: 'paid' },
    ])
    for (const [number, id] of [
      ['089', 1],
      ['89', 2],
      ['0089', 3],
      ['INV-89', 4],
    ] as const) {
      expect((await walk(database, 1, { number })).map((row) => row.id), number).toEqual([id])
    }
    // Equality, not a pattern, a prefix, a case-folded or a trimmed match.
    for (const number of ['8', '9', '0', 'inv-89', '%89', '_89', 'INV-8_', '089 ', ' 089']) {
      expect(await walk(database, 50, { number }), number).toEqual([])
    }
    // Composed with the other narrowings rather than instead of them.
    expect(await walk(database, 1, { number: '0089', clientIds: [1] })).toEqual([])
    expect(
      (await walk(database, 1, { number: '0089', clientIds: [2] })).map((row) => row.id),
    ).toEqual([3])
    expect(await walk(database, 1, { number: 'INV-89', states: ['draft', 'open'] })).toEqual([])
    expect(
      (await walk(database, 1, { number: 'INV-89', states: ['paid'], clientIds: [1] })).map(
        (row) => row.id,
      ),
    ).toEqual([4])
  })

  it('[unit] has no snapshot for an empty table, so the endpoint answers an empty page', async () => {
    const database = await fixture(factory, [])
    expect(await createMoneyResourceRepository(database.orm).invoiceListSnapshot()).toBeNull()
  })

  it('[db] hydrates each page with its own lines, in position order', async () => {
    const database = await fixture(factory, [
      { id: 7, number: '7', issueDate: '2026-09-01' },
      { id: 8, number: '8', issueDate: '2026-09-02' },
    ])
    await database.run(
      `INSERT INTO invoice_line_items (
         id, invoice_id, position, kind, description, quantity, unit_price_cents,
         amount_cents, taxed, taxed2, created_at, updated_at
       ) VALUES
         (71, 7, 1, 'Service', 'Second', 1, 100, 100, 0, 0, ?, ?),
         (70, 7, 0, 'Service', 'First', 1, 100, 100, 0, 0, ?, ?),
         (80, 8, 0, 'Service', 'Only', 1, 100, 100, 0, 0, ?, ?)`,
      seededAt,
      seededAt,
      seededAt,
      seededAt,
      seededAt,
      seededAt,
    )
    const money = createMoneyResourceRepository(database.orm)
    const createdThrough = (await money.invoiceListSnapshot())!
    const [newest] = await money.listInvoices({ after: null, createdThrough, take: 1 })
    expect(newest).toMatchObject({ id: 8, line_items: [{ id: 80 }] })
    const [older] = await money.listInvoices({
      after: positionOf(newest!),
      createdThrough,
      take: 1,
    })
    expect(older?.line_items.map((line) => line.id)).toEqual([70, 71])
  })
})
