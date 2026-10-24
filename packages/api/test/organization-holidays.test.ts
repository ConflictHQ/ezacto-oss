import Database from 'better-sqlite3'
import { afterEach, expect, it } from 'vitest'
import { createContainerDatabase } from '@ezacto/db'
import { migrateContainer } from '@ezacto/db'
import { createOrganizationHolidayRepository } from '@ezacto/db'
import { createApiApp } from '../src/app.js'
import { installOrganizationHolidayRoutes } from '../src/organization-holidays.js'
let close: (() => void) | undefined
const now = '2026-10-12T12:00:00.000Z'
afterEach(() => close?.())
const setup = () => {
  const db = new Database(':memory:')
  migrateContainer(db)
  close = () => {
    db.close()
  }
  db.prepare(
    `INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES
    (1,'Admin','Fixture','administrator','[]',?,?),(2,'Member','Fixture','member','[]',?,?)`,
  ).run(now, now, now, now)
  const repository = createOrganizationHolidayRepository(createContainerDatabase(db))
  const app = createApiApp({
    authentication: {
      sessions: {
        resolve: async (request) => {
          const role = request.headers.get('x-role')
          if (!role) return null
          return {
            type: 'user',
            userId: Number(request.headers.get('x-user') ?? '1'),
            profile:
              role === 'administrator'
                ? 'administrator'
                : role === 'executive_manager'
                  ? 'executive_manager'
                  : 'member',
            authentication: { kind: 'session', sessionId: 'fixture' },
          }
        },
      },
    },
    installApi: (api) =>
      installOrganizationHolidayRoutes(api, repository, {
        cursorSigningKey: new Uint8Array(32).fill(3),
        clock: () => now,
      }),
  })
  const request = (path = '', method = 'GET', value?: object, role = 'administrator', user = 1) =>
    app.request('/api/v1/organization-holidays' + path, {
      method,
      headers: {
        'x-role': role,
        'x-user': String(user),
        origin: 'http://localhost',
        'content-type': 'application/json',
      },
      ...(value ? { body: JSON.stringify(value) } : {}),
    })
  return { db, app, request }
}
it('lists global dates for schedule readers and restricts writes to live administrators', async () => {
  const { request, db, app } = setup()
  expect((await app.request('/api/v1/organization-holidays')).status).toBe(401)
  expect(
    (await request('', 'POST', { date: '2026-10-12', name: 'Closed' }, 'member', 2)).status,
  ).toBe(403)
  expect(
    (await request('', 'POST', { date: '2026-10-12', name: 'Closed' }, 'executive_manager', 2))
      .status,
  ).toBe(403)
  // Simulate credentials whose administrator profile changed before the write.
  expect(
    (await request('', 'POST', { date: '2026-10-12', name: 'Closed' }, 'administrator', 2)).status,
  ).toBe(403)
  expect(db.prepare('SELECT count(*) AS n FROM organization_holidays').get()).toEqual({ n: 0 })
  expect(
    db
      .prepare(
        "SELECT count(*) AS n FROM event_outbox WHERE aggregate_type='organization_calendar'",
      )
      .get(),
  ).toEqual({ n: 0 })
  expect((await request('', 'POST', { date: '2026-10-12', name: 'Closed' })).status).toBe(201)
  const response = await request('', 'GET', undefined, 'member', 2)
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toMatchObject({
    data: [{ date: '2026-10-12', name: 'Closed', version: 0 }],
  })
})
it('validates strict fields and dates and fences updates/deletes by the current version', async () => {
  const { request } = setup()
  expect((await request('', 'POST', { date: '2026-02-30', name: 'Bad date' })).status).toBe(422)
  const unexpected = JSON.parse(
    '{"date":"2026-10-12","name":"Closed","__proto__":"injected"}',
  ) as object
  expect((await request('', 'POST', unexpected)).status).toBe(422)
  const response = await request('', 'POST', { date: '2026-10-12', name: '  Closed  ' })
  expect(response.status).toBe(201)
  const created = ((await response.json()) as { data: { id: number; name: string } }).data
  expect(created.name).toBe('Closed')
  expect((await request('', 'POST', { date: '2026-10-12', name: 'Duplicate' })).status).toBe(409)
  expect(
    (await request('/' + created.id, 'PATCH', { date: '2026-10-13', name: 'Moved', version: 0 }))
      .status,
  ).toBe(200)
  expect((await request('/' + created.id, 'DELETE', { version: 0 })).status).toBe(409)
  expect((await request('/' + created.id, 'DELETE', { version: 1 })).status).toBe(200)
  expect((await request('/' + created.id)).status).toBe(404)
  expect((await request('?from=2026-10-15&to=2026-10-12')).status).toBe(422)
})
