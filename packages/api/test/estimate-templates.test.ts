import BetterSqlite3 from 'better-sqlite3'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createContainerDatabase } from '../../db/src/adapters.js'
import { migrateContainer } from '../../db/src/migrate.js'
import { createEstimateTemplateRepository } from '../../db/src/estimate-templates.js'
import { createApiApp, type UserProfile } from '../src/index.js'
import { installEstimateTemplateRoutes } from '../src/estimate-templates.js'
const now = '2026-10-01T09:00:00.000Z'
const content = {
  subject: 'Quote',
  notes: null,
  currency: 'USD',
  tax_rate_ppm: null,
  tax2_rate_ppm: null,
  discount_rate_ppm: null,
  lines: [
    {
      kind: 'Service',
      description: null,
      quantity: 1,
      unit_price_cents: 2500,
      taxed: false,
      taxed2: false,
    },
  ],
}
let sqlite: BetterSqlite3.Database
let request: (
  path: string,
  method?: string,
  body?: unknown,
  profile?: UserProfile,
) => Promise<Response>
beforeEach(() => {
  sqlite = new BetterSqlite3(':memory:')
  migrateContainer(sqlite)
  sqlite
    .prepare(
      `INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(1,'Quote','Admin','administrator','[]',?,?)`,
    )
    .run(now, now)
  sqlite
    .prepare(
      `INSERT INTO clients(id,name,currency,created_at,updated_at) VALUES(1,'Explicit client','USD',?,?)`,
    )
    .run(now, now)
  const app = createApiApp({
    authentication: {
      sessions: {
        resolve: async (req) => ({
          type: 'user',
          userId: 1,
          profile: (req.headers.get('x-profile') ?? 'administrator') as UserProfile,
          managerGrants: [],
          authentication: { kind: 'session', sessionId: 'quote-session' },
        }),
      },
    },
    installApi: (api) =>
      installEstimateTemplateRoutes(
        api,
        createEstimateTemplateRepository(createContainerDatabase(sqlite)),
        () => now,
      ),
  })
  request = async (path, method = 'GET', body, profile = 'administrator') =>
    app.request('https://api.test/api/v1' + path, {
      method,
      headers: {
        origin: 'https://api.test',
        'content-type': 'application/json',
        'x-profile': profile,
        'Idempotency-Key': 'new-quote',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
})
afterEach(() => sqlite.close())
it('uses the normal draft schema and preserves content after template edits', async () => {
  const saved = await request('/estimate-templates', 'POST', { name: 'Standard', content })
  expect(saved.status).toBe(201)
  const template = ((await saved.json()) as { data: { id: string } }).data
  const body = {
    client_id: 1,
    number: 'Q-1',
    issue_date: '2026-10-01',
    content,
    template_id: template.id,
    template_version: 0,
  }
  const draft = await request('/estimates', 'POST', body)
  expect(draft.status).toBe(201)
  const id = ((await draft.json()) as { data: { id: number } }).data.id
  const repeated = await request('/estimates', 'POST', body)
  expect(((await repeated.json()) as { data: { id: number } }).data.id).toBe(id)
  const changed = await request('/estimate-templates/' + template.id, 'PATCH', {
    name: 'Later',
    content: { ...content, notes: 'Changed' },
    expected_version: 0,
  })
  expect(changed.status).toBe(200)
  expect(sqlite.prepare('SELECT state,notes FROM estimates WHERE id=?').get(id)).toEqual({
    state: 'draft',
    notes: null,
  })
  expect(sqlite.prepare('SELECT count(*) AS n FROM invoices').get()).toEqual({ n: 0 })
  expect(sqlite.prepare('SELECT count(*) AS n FROM estimate_messages').get()).toEqual({ n: 0 })
  const stale = await request('/estimate-templates/' + template.id, 'PATCH', {
    name: 'Stale',
    content,
    expected_version: 0,
  })
  expect(stale.status).toBe(409)
})
it.each(['member', 'project_manager', 'people_admin'] as const)(
  'denies every reusable-content operation to %s',
  async (profile) => {
    for (const [path, method, body] of [
      ['/estimate-templates', 'GET', undefined],
      ['/estimate-templates', 'POST', { name: 'No', content }],
      ['/estimate-templates/missing', 'PATCH', { name: 'No', content, expected_version: 0 }],
      ['/estimates', 'POST', { client_id: 1, number: 'Q-NO', issue_date: '2026-10-01', content }],
    ] as const) {
      expect((await request(path, method, body, profile)).status).toBe(403)
    }
  },
)
it('rejects private content and authority fields instead of copying them', async () => {
  expect(
    (
      await request('/estimate-templates', 'POST', {
        name: 'Unsafe',
        content: { ...content, client_key: 'bearer' },
      })
    ).status,
  ).toBe(422)
  expect(
    (
      await request('/estimates', 'POST', {
        client_id: 1,
        number: 'NO',
        issue_date: '2026-10-01',
        content,
        state: 'accepted',
      })
    ).status,
  ).toBe(422)
  expect(
    (
      await request('/estimates', 'POST', {
        client_id: 1,
        number: 'BAD-DATE',
        issue_date: '2026-02-30',
        content,
      })
    ).status,
  ).toBe(422)
  expect(
    (
      await request('/estimates', 'POST', {
        client_id: 1,
        number: 'BAD-TEMPLATE',
        issue_date: '2026-10-01',
        content,
        template_id: { secret: 'value' },
        template_version: 0,
      })
    ).status,
  ).toBe(409)
  expect(sqlite.prepare('SELECT count(*) AS n FROM estimates').get()).toEqual({ n: 0 })
})
