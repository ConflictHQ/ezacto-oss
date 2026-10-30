import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createContainerDatabase } from '../../db/src/adapters.js'
import { migrateContainer } from '../../db/src/migrate.js'
import {
  createMoneyResourceRepository,
  type MoneyResourceDatabase,
  type MoneyResourceRepository,
} from '../../db/src/money-resources.js'
import {
  createApiApp,
  installMagicLinkRoutes,
  type MagicLinkRouteOptions,
  type PortalSessionStore,
} from '../src/index.js'

const t0 = '2026-10-01T10:00:00.000Z'
const t1 = '2026-10-01T11:00:00.000Z'

// Contact 1 (Alice) and 2 (Bob) belong to client 1, contact 3 (Carol) to client 2.
const sessions: Record<string, { contactId: number; clientId: number }> = {
  alice: { contactId: 1, clientId: 1 },
  bob: { contactId: 2, clientId: 1 },
  carol: { contactId: 3, clientId: 2 },
}
const tokenFor = (name: string): string => `ezacto_portal_${name.padEnd(16, 'A')}_${'A'.repeat(43)}`
const cookieFor = (name: string): string => `__Host-ezacto_portal=${tokenFor(name)}`

const sessionStore: PortalSessionStore = {
  authenticate: vi.fn(async (token) => {
    for (const [name, principal] of Object.entries(sessions)) {
      if (token === tokenFor(name)) {
        return { ...principal, session: { id: 1, absoluteExpiresAt: '2026-12-01T00:00:00.000Z' } }
      }
    }
    return null
  }),
}

interface Harness {
  sqlite: BetterSqlite3.Database
  repo: MoneyResourceRepository
  app: ReturnType<typeof createApiApp>
}

let open: BetterSqlite3.Database | null = null
afterEach(() => {
  open?.close()
  open = null
})

const harness = async (withEstimates = true): Promise<Harness> => {
  const sqlite = new BetterSqlite3(':memory:')
  open = sqlite
  migrateContainer(sqlite)
  const repo = createMoneyResourceRepository(
    createContainerDatabase(sqlite) as unknown as MoneyResourceDatabase,
  )
  const run = (sql: string, ...params: unknown[]) => sqlite.prepare(sql).run(...params)
  run(`INSERT INTO organizations (name, modules, created_at, updated_at) VALUES ('Org', '{}', ?, ?)`, t0, t0)
  for (const id of [1, 2]) {
    run(
      `INSERT INTO clients (id, name, currency, created_at, updated_at) VALUES (?, ?, 'USD', ?, ?)`,
      id,
      `Client ${id}`,
      t0,
      t0,
    )
  }
  for (const [id, clientId, first] of [
    [1, 1, 'Alice'],
    [2, 1, 'Bob'],
    [3, 2, 'Carol'],
  ] as const) {
    run(
      `INSERT INTO contacts (id, client_id, first_name, last_name, email, created_at, updated_at)
       VALUES (?, ?, ?, 'Tester', ?, ?, ?)`,
      id,
      clientId,
      first,
      `${first.toLowerCase()}@example.test`,
      t0,
      t0,
    )
  }
  // 1 draft and 2 sent for client 1, 3 sent for client 2.
  for (const [id, clientId] of [
    [1, 1],
    [2, 1],
    [3, 2],
  ] as const) {
    run(
      `INSERT INTO estimates (id, client_id, number, currency, issue_date, amount_cents, created_at, updated_at)
       VALUES (?, ?, ?, 'USD', '2026-10-01', 10000, ?, ?)`,
      id,
      clientId,
      `EST-${id}`,
      t0,
      t0,
    )
    run(
      `INSERT INTO estimate_line_items (estimate_id, position, kind, description, quantity,
         unit_price_cents, amount_cents, created_at, updated_at)
       VALUES (?, 0, 'Service', 'Work', 1, 10000, 10000, ?, ?)`,
      id,
      t0,
      t0,
    )
  }
  for (const id of [2, 3]) await send(repo, id)
  const options: MagicLinkRouteOptions = {
    service: {} as MagicLinkRouteOptions['service'],
    sessions: {} as MagicLinkRouteOptions['sessions'],
    sessionStore,
    ...(withEstimates
      ? {
          estimates: {
            list: (clientId) => repo.listCustomerEstimates(clientId),
            get: (clientId, estimateId) => repo.getCustomerEstimate(clientId, estimateId),
            respond: (input) => repo.respondToEstimate({ ...input, occurredAt: t1 }),
          },
        }
      : {}),
  }
  const app = createApiApp({ installApp: (app) => installMagicLinkRoutes(app, options) })
  return { sqlite, repo, app }
}

let messageId = 5_000_000
const send = async (repo: MoneyResourceRepository, estimateId: number): Promise<void> => {
  const current = await repo.getEstimate(estimateId)
  messageId += 1000
  await repo.executeEstimateMessage({
    estimateId,
    commandId: `send-${messageId}`,
    actorUserId: 1,
    messageId,
    expectedVersion: current!.version,
    eventType: 'send',
    sentBy: 'Staff',
    sentByEmail: 'staff@example.test',
    sentFrom: null,
    sentFromEmail: null,
    recipients: [{ name: 'Alice', email: 'alice@example.test' }],
    subject: null,
    body: null,
    sendMeACopy: false,
    occurredAt: t0,
  })
}

const get = (h: Harness, path: string, as?: string) =>
  h.app.request(path, { headers: as === undefined ? {} : { cookie: cookieFor(as) } })

const answer = (
  h: Harness,
  id: string | number,
  body: unknown,
  as: string | null = 'alice',
  headers: Record<string, string> = { origin: 'http://localhost' },
) =>
  h.app.request(`/portal/estimates/${id}/response`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(as === null ? {} : { cookie: cookieFor(as) }),
      ...headers,
    },
    body: JSON.stringify(body),
  })

const versionOf = async (h: Harness, id: number): Promise<string> => {
  const body = (await (await get(h, `/portal/estimates/${id}`, 'alice')).json()) as {
    data: { version: string }
  }
  return body.data.version
}

describe('portal estimate review and response', () => {
  it('[security] requires a portal session on every estimate route', async () => {
    const h = await harness()
    expect((await get(h, '/portal/estimates')).status).toBe(401)
    expect((await get(h, '/portal/estimates/2')).status).toBe(401)
    expect((await get(h, '/portal/estimates/2', 'mallory')).status).toBe(401)
    expect((await answer(h, 2, { decision: 'accept', version: 'a'.repeat(64) }, null)).status).toBe(401)
    expect(h.sqlite.prepare(`SELECT state FROM estimates WHERE id = 2`).get()).toEqual({ state: 'sent' })
  })

  it('answers 503 rather than guessing when estimates are not composed', async () => {
    const h = await harness(false)
    expect((await get(h, '/portal/estimates', 'alice')).status).toBe(503)
  })

  it('[security] lists and shows only the contact client sent estimates', async () => {
    const h = await harness()
    const list = await get(h, '/portal/estimates', 'alice')
    expect(list.status).toBe(200)
    expect(list.headers.get('cache-control')).toBe('no-store')
    const body = (await list.json()) as { data: { estimates: Array<{ id: number }> } }
    expect(body.data.estimates.map(({ id }) => id)).toEqual([2])
    const carol = (await (await get(h, '/portal/estimates', 'carol')).json()) as typeof body
    expect(carol.data.estimates.map(({ id }) => id)).toEqual([3])

    expect((await get(h, '/portal/estimates/3', 'alice')).status).toBe(404) // other client
    expect((await get(h, '/portal/estimates/2', 'carol')).status).toBe(404)
    expect((await get(h, '/portal/estimates/1', 'alice')).status).toBe(404) // draft
    expect((await get(h, '/portal/estimates/999', 'alice')).status).toBe(404)
    expect((await get(h, '/portal/estimates/abc', 'alice')).status).toBe(404)
    expect((await get(h, '/portal/estimates/2abc', 'alice')).status).toBe(404)

    const shown = await get(h, '/portal/estimates/2', 'bob')
    expect(shown.status).toBe(200)
    const text = await shown.text()
    expect(text).toContain('"answerable":true')
    expect(text).not.toContain('client_key')
    expect(text).not.toContain('created_by_user_id')
  })

  it('records an acceptance and replays a repeat without a second record', async () => {
    const h = await harness()
    const version = await versionOf(h, 2)
    const first = await answer(h, 2, { decision: 'accept', version })
    expect(first.status).toBe(200)
    expect(first.headers.get('cache-control')).toBe('no-store')
    const body = (await first.json()) as {
      data: { state: string; response: { by: string; version: string } }
      replayed: boolean
    }
    expect(body.replayed).toBe(false)
    expect(body.data).toMatchObject({ state: 'accepted', response: { by: 'Alice Tester', version } })

    const again = await answer(h, 2, { decision: 'accept', version }, 'bob')
    expect(again.status).toBe(200)
    expect(((await again.json()) as { replayed: boolean }).replayed).toBe(true)
    expect(
      h.sqlite.prepare(`SELECT count(*) AS n FROM estimate_messages WHERE event_type = 'accept'`).get(),
    ).toEqual({ n: 1 })
    expect(h.sqlite.prepare(`SELECT count(*) AS n FROM invoices`).get()).toEqual({ n: 0 })

    const staff = await h.repo.getEstimate(2)
    expect(staff).toMatchObject({ state: 'accepted', accepted_at: t1 })
  })

  it('refuses the opposite answer, a stale version and a needs-resend estimate with 409', async () => {
    const h = await harness()
    const version = await versionOf(h, 2)

    const stale = await answer(h, 2, { decision: 'accept', version: 'b'.repeat(64) })
    expect(stale.status).toBe(409)
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe(
      'estimate_content_changed',
    )

    await answer(h, 2, { decision: 'decline', version })
    const flip = await answer(h, 2, { decision: 'accept', version })
    expect(flip.status).toBe(409)
    expect(((await flip.json()) as { error: { code: string } }).error.code).toBe(
      'estimate_state_conflict',
    )

    // An edit to a sent estimate (client 2's, which is still unanswered).
    h.sqlite.prepare(`UPDATE estimates SET notes = 'edited', version = version + 1 WHERE id = 3`).run()
    const edited = (await (await get(h, '/portal/estimates/3', 'carol')).json()) as {
      data: { version: string; answerable: boolean }
    }
    expect(edited.data.answerable).toBe(false)
    const resend = await answer(h, 3, { decision: 'accept', version: edited.data.version }, 'carol')
    expect(resend.status).toBe(409)
    expect(((await resend.json()) as { error: { code: string } }).error.code).toBe(
      'estimate_needs_resend',
    )
  })

  it('refuses an expired estimate with a distinct 410, records nothing and says so on the page data', async () => {
    const h = await harness()
    const version = await versionOf(h, 2)
    // The clock in this harness is t1 (2026-10-01T11:00Z, instance timezone UTC).
    h.sqlite.prepare(`UPDATE estimates SET expires_on = '2026-09-30' WHERE id = 2`).run()
    const shown = (await (await get(h, '/portal/estimates/2', 'alice')).json()) as {
      data: { version: string; answerable: boolean; expired: boolean; expires_on: string }
    }
    expect(shown.data).toMatchObject({ expired: true, answerable: false, expires_on: '2026-09-30' })
    // The expiry is not part of the version the customer was shown.
    expect(shown.data.version).toBe(version)

    const refused = await answer(h, 2, { decision: 'accept', version })
    expect(refused.status).toBe(410)
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('estimate_expired')
    expect(h.sqlite.prepare(`SELECT state FROM estimates WHERE id = 2`).get()).toEqual({ state: 'sent' })
    expect(
      h.sqlite.prepare(`SELECT count(*) AS n FROM estimate_messages WHERE contact_id IS NOT NULL`).get(),
    ).toEqual({ n: 0 })

    // Staff moving the day forward reopens it for the same version.
    h.sqlite.prepare(`UPDATE estimates SET expires_on = '2026-10-01' WHERE id = 2`).run()
    expect((await answer(h, 2, { decision: 'accept', version })).status).toBe(200)
  })

  it('[security] never lets a contact answer another client estimate', async () => {
    const h = await harness()
    const version = await versionOf(h, 2)
    expect((await answer(h, 3, { decision: 'accept', version }, 'alice')).status).toBe(404)
    expect((await answer(h, 2, { decision: 'accept', version }, 'carol')).status).toBe(404)
    expect((await answer(h, 1, { decision: 'accept', version }, 'alice')).status).toBe(404)
    expect(h.sqlite.prepare(`SELECT state FROM estimates ORDER BY id`).all()).toEqual([
      { state: 'draft' },
      { state: 'sent' },
      { state: 'sent' },
    ])
  })

  it('[security] requires a same-origin request for the answer', async () => {
    const h = await harness()
    const version = await versionOf(h, 2)
    const body = { decision: 'accept', version }
    expect((await answer(h, 2, body, 'alice', { origin: 'https://evil.example' })).status).toBe(403)
    expect((await answer(h, 2, body, 'alice', {})).status).toBe(403)
    expect(h.sqlite.prepare(`SELECT state FROM estimates WHERE id = 2`).get()).toEqual({ state: 'sent' })
  })

  it('validates the body without touching the estimate', async () => {
    const h = await harness()
    const version = await versionOf(h, 2)
    for (const body of [
      {},
      { decision: 'accept' },
      { version },
      { decision: 'maybe', version },
      { decision: 'accept', version: 'short' },
      { decision: 'accept', version, extra: 1 },
      [],
      null,
    ]) {
      expect((await answer(h, 2, body)).status).toBe(422)
    }
    const wrongType = await h.app.request('/portal/estimates/2/response', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', cookie: cookieFor('alice'), origin: 'http://localhost' },
      body: 'accept',
    })
    expect(wrongType.status).toBe(415)
    expect(h.sqlite.prepare(`SELECT state FROM estimates WHERE id = 2`).get()).toEqual({ state: 'sent' })
  })
})
