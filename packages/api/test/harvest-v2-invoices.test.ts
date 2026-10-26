import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createContainerDatabase,
  createD1Database,
} from '../../db/src/adapters.js'
import { migrateContainer, migrateD1 } from '../../db/src/migrate.js'
import {
  createMoneyResourceRepository,
  type MoneyResourceDatabase,
} from '../../db/src/money-resources.js'
import { createApiApp } from '../src/app.js'
import {
  installHarvestInvoiceRoutes,
  parseHarvestInvoiceQuery,
  serializeHarvestInvoice,
} from '../src/harvest-v2/invoices.js'
import type { ApiAuthentication } from '../src/auth.js'

interface InvoicePage {
  total_entries: number
  invoices: Array<{ id: number }>
  next_page: number | null
  links: { next: string | null }
}
const timestamp = '2026-10-01T12:00:00.000Z'
const authentication: ApiAuthentication = {
  tokens: {
    authenticate: async (token) =>
      token === 'invalid'
        ? null
        : {
            tokenId: 1,
            userId: 1,
            profile:
              token === 'member'
                ? 'member'
                : token === 'admin'
                  ? 'administrator'
                  : 'accounting',
            managerGrants: [],
            scopes:
              token === 'no-scope'
                ? []
                : token === 'member'
                  ? ['time_entries:read']
                  : ['invoices:read'],
          },
    issue: async () => {
      throw new Error('unused')
    },
    list: async () => [],
    revoke: async () => null,
  },
}

for (const runtime of ['SQLite', 'D1'] as const)
  describe(`Harvest invoice reads (${runtime})`, () => {
    let close: () => Promise<void> = async () => {},
      run: (sql: string, ...values: unknown[]) => Promise<void>,
      database: MoneyResourceDatabase
    let batches: number[], app: ReturnType<typeof createApiApp>
    beforeAll(async () => {
      batches = []
      if (runtime === 'D1') {
        const mf = new Miniflare({
          modules: true,
          script: 'export default {fetch(){return new Response("ok")}}',
          d1Databases: ['DB'],
        })
        close = () => mf.dispose()
        const db = await mf.getD1Database('DB')
        await migrateD1(db)
        const observed = new Proxy(db, {
          get(target, key) {
            if (key === 'batch')
              return (statements: D1PreparedStatement[]) => {
                batches.push(statements.length)
                return target.batch(statements)
              }
            const value = Reflect.get(target, key, target) as unknown
            return typeof value === 'function' ? value.bind(target) : value
          },
        })
        database = createD1Database(observed)
        run = async (sql, ...values) => {
          await db
            .prepare(sql)
            .bind(...values)
            .run()
        }
        close = () => mf.dispose()
      } else {
        const db = new BetterSqlite3(':memory:')
        migrateContainer(db)
        database = createContainerDatabase(db)
        run = async (sql, ...values) => {
          db.prepare(sql).run(...values)
        }
        close = async () => {
          db.close()
        }
      }
      await run(
        "INSERT INTO organizations(id,name,modules,created_at,updated_at)VALUES(1,'Sample Org','{}',?,?)",
        timestamp,
        timestamp,
      )
      await run(
        "INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at)VALUES(1,'Sample','Creator','administrator','[]',?,?)",
        timestamp,
        timestamp,
      )
      await run(
        "INSERT INTO clients(id,name,currency,created_at,updated_at)VALUES(1,'Sample Client','USD',?,?),(2,'Sample Other','USD',?,?)",
        timestamp,
        timestamp,
        timestamp,
        timestamp,
      )
      await run(
        "INSERT INTO projects(id,client_id,name,code,created_at,updated_at)VALUES(1,1,'Sample Project','SMP-1',?,?)",
        timestamp,
        timestamp,
      )
      for (const [id, client, state, date] of [
        [1, 1, 'draft', '2026-10-01'],
        [2, 1, 'open', '2026-09-01'],
        [3, 2, 'draft', '2026-08-01'],
      ] as const) {
        await run(
          `INSERT INTO invoices(id,client_id,created_by_user_id,number,currency,issue_date,due_date,state,amount_cents,due_amount_cents,tax_rate_ppm,tax_amount_cents,created_at,updated_at)
      VALUES(?,?,1,?,'USD',?,'2026-11-01',?,3085,3085,123400,0,?,?)`,
          id,
          client,
          'SMP-' + id,
          date,
          state,
          timestamp,
          timestamp,
        )
      }
      await run(
        "INSERT INTO invoice_line_items(id,invoice_id,position,kind,description,quantity,unit_price_cents,amount_cents,taxed,taxed2,project_id,created_at,updated_at)VALUES(1,1,0,'Service','Sample work',2.5,1234,3085,0,0,1,?,?)",
        timestamp,
        timestamp,
      )
      await run(
        `INSERT INTO invoices(id,client_id,created_by_user_id,source_creator_id,source_creator_name,number,currency,issue_date,due_date,state,amount_cents,due_amount_cents,created_at,updated_at)
      VALUES(4,2,NULL,999,'Sample Source Creator Secret','SMP-4','USD','2026-07-01','2026-11-01','draft',0,0,?,?)`,
        timestamp,
        timestamp,
      )
      app = createApiApp({
        authentication,
        installHarvestV2: (shim) =>
          installHarvestInvoiceRoutes(
            shim,
            createMoneyResourceRepository(database),
          ),
      })
    }, 30000)
    afterAll(async () => {
      await close()
    })
    const get = (path: string, token = 'read') =>
      app.request('/harvest/v2' + path, {
        headers: { authorization: 'Bearer ' + token },
      })

    it('renders persisted decimal amounts, related records and line projects without secret links', async () => {
      const response = await get('/invoices/1')
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body).toMatchObject({
        id: 1,
        amount: 30.85,
        due_amount: 30.85,
        tax: 12.34,
        client: { id: 1, name: 'Sample Client' },
        creator: { id: 1, name: 'Sample Creator' },
        line_items: [
          {
            quantity: 2.5,
            unit_price: 12.34,
            amount: 30.85,
            project: { id: 1, name: 'Sample Project', code: 'SMP-1' },
          },
        ],
      })
      const raw =
        await createMoneyResourceRepository(database).harvestInvoice(1)
      Object.assign(raw!.invoice, { reference_token: 'private-link-token' })
      for (const [native, expected] of [
        ['upon_receipt', 'upon receipt'],
        ['net_15', 'net 15'],
        ['net_30', 'net 30'],
        ['net_45', 'net 45'],
        ['net_60', 'net 60'],
        ['custom', 'custom'],
      ]) {
        raw!.invoice.payment_terms = native!
        expect(serializeHarvestInvoice(raw!).payment_term).toBe(expected)
      }
      raw!.invoice.payment_terms = 'constructor'
      expect(() => serializeHarvestInvoice(raw!)).toThrow(
        'Unsupported invoice payment term',
      )
      raw!.invoice.payment_terms = 'net_30'
      raw!.invoice.line_items[0]!.kind = 'Sample Custom Service'
      expect(serializeHarvestInvoice(raw!).line_items[0]!.kind).toBe(
        'Sample Custom Service',
      )
      raw!.invoice.payment_options = [
        'stripe_checkout',
        'paypal_checkout',
        'wise_transfer',
      ]
      expect(serializeHarvestInvoice(raw!).payment_options).toEqual([
        'credit_card',
        'paypal',
      ])
      expect(JSON.stringify(serializeHarvestInvoice(raw!))).not.toContain(
        'private-link-token',
      )
      expect(JSON.stringify(body)).not.toContain('private-link-token')
      expect(body).not.toHaveProperty('client_key')
      expect(body).not.toHaveProperty('reference_token')
      if (runtime === 'D1') expect(batches).toEqual([4, 4])
    })
    it('keeps an unresolved native creator null without reviving source personal data', async () => {
      const response = await get('/invoices/4')
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body).toMatchObject({ id: 4, creator: null })
      expect(JSON.stringify(body)).not.toContain('Sample Source Creator Secret')
      expect(body).not.toHaveProperty('source_creator_id')
      expect(body).not.toHaveProperty('source_creator_name')
    })

    it('pages in issue-date order, filters in SQL and preserves pagination links', async () => {
      const first = (await (
        await get('/invoices?client_id=1&per_page=1')
      ).json()) as InvoicePage
      expect(first.total_entries).toBe(2)
      expect(first.invoices.map((x: { id: number }) => x.id)).toEqual([1])
      expect(first.next_page).toBe(2)
      expect(first.links.next).toContain('client_id=1')
      const next = (await (
        await get('/invoices?client_id=1&per_page=1&page=2')
      ).json()) as InvoicePage
      expect(next.invoices.map((x: { id: number }) => x.id)).toEqual([2])
      const filtered = (await (
        await get(
          '/invoices?project_id=1&state=draft&from=2026-10-01&to=2026-10-02&updated_since=2026-10-01T00:00:00Z',
        )
      ).json()) as InvoicePage
      expect(filtered.total_entries).toBe(1)
      expect(filtered.invoices[0]!.id).toBe(1)
    })
    it('keeps native profile and token-scope ceilings', async () => {
      expect((await get('/invoices', 'member')).status).toBe(403)
      expect((await get('/invoices/1', 'no-scope')).status).toBe(403)
      expect((await get('/invoices', 'invalid')).status).toBe(401)
      expect((await get('/invoices/1', 'admin')).status).toBe(200)
    })
    it('fails malformed known filters and leaves missing records private', async () => {
      for (const query of [
        'page=0',
        'per_page=2001',
        'client_id=no',
        'state=bogus',
        'from=2026-02-30',
        'from=2026-10-10&to=2026-10-01',
        'updated_since=bad',
        'updated_since=2026-02-30T00:00:00Z',
      ])
        expect((await get('/invoices?' + query)).status).toBe(422)
      expect((await get('/invoices/999')).status).toBe(404)
      expect(parseHarvestInvoiceQuery(new URLSearchParams()).page).toEqual({
        page: 1,
        perPage: 100,
      })
    })
  })
