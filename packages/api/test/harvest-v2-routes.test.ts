import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../../db/src/adapters.js'
import { createGeneralResourceRepository } from '../../db/src/general-resources.js'
import { createTeamRepository } from '../../db/src/team.js'
import { migrateContainer, migrateD1 } from '../../db/src/migrate.js'
import { createApiApp, installGeneralResourceRoutes, installHarvestV2Routes } from '../src/index.js'
import type { ApiAuthentication } from '../src/auth.js'
import type { UserProfile } from '../src/context.js'

/**
 * The Harvest shim routes against a real migrated database on both runtimes:
 * the container's SQLite file and the Worker's D1. Rows are seeded through the
 * native API, so what the shim renders is what the native API stored.
 */

const now = '2026-08-28T12:00:00.000Z'
const signingKey = new Uint8Array(32).fill(0x72)

const bearers: Readonly<
  Record<string, { userId: number; profile: UserProfile; scopes: string[] }>
> = {
  admin: {
    userId: 1,
    profile: 'administrator',
    scopes: ['clients:read', 'projects:read', 'team:read'],
  },
  'clients-only': { userId: 1, profile: 'administrator', scopes: ['clients:read'] },
  'member-ada': { userId: 2, profile: 'member', scopes: ['clients:read', 'projects:read'] },
}

const authentication: ApiAuthentication = {
  tokens: {
    authenticate: async (token) => {
      const principal = bearers[token]
      return principal === undefined
        ? null
        : {
            tokenId: 1,
            userId: principal.userId,
            profile: principal.profile,
            managerGrants: [],
            scopes: [...principal.scopes],
          }
    },
    issue: async () => {
      throw new Error('not used by this fixture')
    },
    list: async () => [],
    revoke: async () => null,
  },
  sessions: {
    resolve: async () => ({
      type: 'user',
      userId: 1,
      profile: 'administrator',
      authentication: { kind: 'session', sessionId: 'harvest-shim-test' },
    }),
  },
}

interface Harness {
  native(path: string, init?: RequestInit): Promise<Response>
  shim(path: string, token?: string | null, init?: RequestInit): Promise<Response>
  setTeamModuleEnabled(enabled: boolean): void
  close(): Promise<void>
}

const compose = (
  repository: ReturnType<typeof createGeneralResourceRepository>,
  teamRepository: ReturnType<typeof createTeamRepository>,
  close: () => Promise<void>,
): Harness => {
  let teamModuleEnabled = true
  const app = createApiApp({
    authentication,
    installApi: (api) =>
      installGeneralResourceRoutes(api, {
        repository,
        cursorSigningKey: signingKey,
        clock: () => now,
        isExpensesModuleEnabled: async () => true,
        teamRepository,
      }),
    installHarvestV2: (harvest) =>
      installHarvestV2Routes(harvest, {
        repository,
        isTeamModuleEnabled: async () => teamModuleEnabled,
        clock: () => now,
      }),
  })
  return {
    native: (path, init) => {
      const headers = new Headers(init?.headers)
      headers.set('origin', 'https://api.test')
      return Promise.resolve(app.request(`https://api.test/api/v1${path}`, { ...init, headers }))
    },
    shim: (path, token = 'admin', init) => {
      const headers = new Headers(init?.headers)
      if (token !== null) headers.set('authorization', `Bearer ${token}`)
      return Promise.resolve(app.request(`https://api.test/harvest/v2${path}`, { ...init, headers }))
    },
    setTeamModuleEnabled: (enabled) => {
      teamModuleEnabled = enabled
    },
    close,
  }
}

const containerHarness = async (): Promise<Harness> => {
  const sqlite = new BetterSqlite3(':memory:')
  migrateContainer(sqlite)
  sqlite
    .prepare('INSERT INTO organizations (name, modules, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('Test org', '{}', now, now)
  const database = createContainerDatabase(sqlite)
  return compose(createGeneralResourceRepository(database), createTeamRepository(database), async () => {
    sqlite.close()
  })
}

const d1Harness = async (): Promise<Harness> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const d1 = await miniflare.getD1Database('DB')
  await migrateD1(d1)
  await d1
    .prepare('INSERT INTO organizations (name, modules, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .bind('Test org', '{}', now, now)
    .run()
  const database = createD1Database(d1)
  return compose(createGeneralResourceRepository(database), createTeamRepository(database), () =>
    miniflare.dispose(),
  )
}

const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
})

const created = async (response: Response): Promise<number> => {
  expect(response.status, await response.clone().text()).toBe(201)
  return ((await response.json()) as { data: { id: number } }).data.id
}

interface Seeded {
  clientA: number
  clientB: number
  projectA: number
  projectB: number
  owner: number
  ada: number
}

/**
 * Two clients (one archived), a live and an archived project, three tasks, two
 * users with Ada on a role and on a billable rate that changed on the clock's
 * day, and Ada assigned to the live project only.
 */
const seed = async (harness: Harness): Promise<Seeded> => {
  const owner = await created(
    await harness.native(
      '/users',
      json({ first_name: 'Sample', last_name: 'Owner', email: 'owner@example.test', profile: 'administrator' }),
    ),
  )
  const ada = await created(
    await harness.native(
      '/users',
      json({ first_name: 'Sample', last_name: 'Ada', email: 'ada@example.test', is_contractor: true }),
    ),
  )
  // Rates go first: each is a command against the user's version, which every
  // later role or assignment write moves on.
  const rate = (path: string, version: number, body: Record<string, unknown>) =>
    harness.native(
      `/users/${ada}/${path}`,
      json({ expected_version: version, ...body }, { 'idempotency-key': `rate-${path}-${version}` }),
    )
  expect((await rate('billable-rates', 0, { amount_cents: 12_500, start_date: null })).status).toBe(201)
  expect((await rate('billable-rates', 1, { amount_cents: 15_050, start_date: '2026-08-28' })).status).toBe(201)
  expect((await rate('cost-rates', 2, { amount_cents: 8_000, start_date: null })).status).toBe(201)
  const clientA = await created(
    await harness.native('/clients', json({ name: 'Sample Client A', currency: 'USD', address: '1 Fixture Way' })),
  )
  const clientB = await created(
    await harness.native('/clients', json({ name: 'Sample Client B', currency: 'EUR', is_active: false })),
  )
  const projectA = await created(
    await harness.native(
      '/projects',
      json({
        client_id: clientA,
        name: 'Sample Project A',
        code: 'SMP-1',
        billing_method: 'time_materials',
        bill_by: 'project',
        hourly_rate_cents: 15_000,
        budget_seconds: 36_000,
      }),
    ),
  )
  const projectB = await created(
    await harness.native('/projects', json({ client_id: clientB, name: 'Sample Project B', is_active: false })),
  )
  await created(await harness.native('/tasks', json({ name: 'Sample Task One' })))
  await created(await harness.native('/tasks', json({ name: 'Sample Task Two', default_hourly_rate_cents: 9_000 })))
  await created(await harness.native('/tasks', json({ name: 'Sample Task Three', is_active: false })))
  await created(await harness.native('/roles', json({ name: 'Sample Finance', user_ids: [ada] })))
  await created(await harness.native('/user-assignments', json({ project_id: projectA, user_id: ada })))
  return { clientA, clientB, projectA, projectB, owner, ada }
}

type Page<Key extends string> = Record<Key, Array<Record<string, unknown>>> & {
  per_page: number
  total_pages: number
  total_entries: number
  next_page: number | null
  previous_page: number | null
  page: number
  links: { first: string; next: string | null; previous: string | null; last: string }
}

const page = async <Key extends string>(response: Response): Promise<Page<Key>> => {
  expect(response.status, await response.clone().text()).toBe(200)
  return (await response.json()) as Page<Key>
}

describe.each([
  ['SQLite', containerHarness],
  ['D1', d1Harness],
] as const)('[api] /harvest/v2 routes on %s', (_runtime, makeHarness) => {
  let harness: Harness
  let ids: Seeded

  beforeEach(async () => {
    harness = await makeHarness()
    ids = await seed(harness)
  })
  afterEach(async () => {
    await harness.close()
  })

  it('answers 401 without an Authorization header, even for a valid session', async () => {
    const response = await harness.shim('/clients', null, { headers: { cookie: 'session=anything' } })
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe('Bearer realm="ezacto"')
  })

  it('answers 401 for an unknown token and 403 for a token without the resource scope', async () => {
    expect((await harness.shim('/clients', 'nope')).status).toBe(401)
    const response = await harness.shim('/projects', 'clients-only')
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'insufficient_scope' } })
    expect((await harness.shim('/clients', 'clients-only')).status).toBe(200)
  })

  it('serves no mutating verbs', async () => {
    const response = await harness.shim('/clients', 'admin', json({ name: 'Sample Nope' }))
    expect(response.status).toBe(404)
  })

  it('lists clients in the Harvest page envelope with shim-rendered objects', async () => {
    const body = await page<'clients'>(await harness.shim('/clients'))
    expect(body).toMatchObject({
      per_page: 2000,
      total_pages: 1,
      total_entries: 2,
      next_page: null,
      previous_page: null,
      page: 1,
    })
    expect(body.links).toEqual({
      first: '/harvest/v2/clients?page=1&per_page=2000',
      next: null,
      previous: null,
      last: '/harvest/v2/clients?page=1&per_page=2000',
    })
    expect(body.clients).toEqual([
      {
        id: ids.clientA,
        name: 'Sample Client A',
        is_active: true,
        address: '1 Fixture Way',
        currency: 'USD',
        created_at: '2026-08-28T12:00:00Z',
        updated_at: '2026-08-28T12:00:00Z',
      },
      expect.objectContaining({ id: ids.clientB, is_active: false, currency: 'EUR', address: null }),
    ])
  })

  it('pages by offset and keeps the other parameters in the links', async () => {
    const second = await page<'clients'>(await harness.shim('/clients?per_page=1&page=2&updated_since=2026-08-01T00:00:00Z'))
    expect(second.clients.map((client) => client.id)).toEqual([ids.clientB])
    expect(second).toMatchObject({
      total_pages: 2,
      total_entries: 2,
      next_page: null,
      previous_page: 1,
      page: 2,
    })
    expect(second.links.previous).toBe('/harvest/v2/clients?updated_since=2026-08-01T00%3A00%3A00Z&page=1&per_page=1')
    const beyond = await page<'clients'>(await harness.shim('/clients?per_page=1&page=3'))
    expect(beyond.clients).toEqual([])
    expect(beyond.total_entries).toBe(2)
  })

  it('filters in the repository, so totals describe the filtered collection', async () => {
    const inactive = await page<'clients'>(await harness.shim('/clients?is_active=false'))
    expect(inactive.clients.map((client) => client.id)).toEqual([ids.clientB])
    expect(inactive.total_entries).toBe(1)
    const none = await page<'clients'>(await harness.shim('/clients?updated_since=2026-08-28T12:00:00Z'))
    expect(none.total_entries).toBe(0)
    expect(none.total_pages).toBe(1)
  })

  it('refuses malformed parameters with a validation error', async () => {
    for (const query of ['per_page=0', 'per_page=2001', 'page=abc', 'is_active=maybe']) {
      const response = await harness.shim(`/clients?${query}`)
      expect(response.status, query).toBe(422)
    }
  })

  it('renders projects with decimal money, Harvest casing and the embedded client', async () => {
    const body = await page<'projects'>(await harness.shim('/projects'))
    expect(body.total_entries).toBe(2)
    expect(body.projects[0]).toMatchObject({
      id: ids.projectA,
      name: 'Sample Project A',
      code: 'SMP-1',
      is_billable: true,
      is_fixed_fee: false,
      bill_by: 'Project',
      hourly_rate: 150,
      budget: 10,
      client: { id: ids.clientA, name: 'Sample Client A', currency: 'USD' },
    })
    const filtered = await page<'projects'>(await harness.shim(`/projects?client_id=${ids.clientB}&is_active=false`))
    expect(filtered.projects.map((project) => project.id)).toEqual([ids.projectB])
  })

  it('renders tasks', async () => {
    const body = await page<'tasks'>(await harness.shim('/tasks'))
    expect(body.tasks.map((task) => task.name)).toEqual([
      'Sample Task One',
      'Sample Task Two',
      'Sample Task Three',
    ])
    expect(body.tasks[1]).toMatchObject({ default_hourly_rate: 90, is_active: true })
    const archived = await page<'tasks'>(await harness.shim('/tasks?is_active=false'))
    expect(archived.tasks.map((task) => task.name)).toEqual(['Sample Task Three'])
  })

  it('renders users with their roles and the rates in force today', async () => {
    const body = await page<'users'>(await harness.shim('/users'))
    expect(body.total_entries).toBe(2)
    const ada = body.users.find((user) => user.id === ids.ada)
    expect(ada).toMatchObject({
      first_name: 'Sample',
      last_name: 'Ada',
      email: 'ada@example.test',
      is_contractor: true,
      roles: ['Sample Finance'],
      access_roles: ['member'],
      default_hourly_rate: 150.5,
      cost_rate: 80,
    })
    const owner = body.users.find((user) => user.id === ids.owner)
    expect(owner).toMatchObject({ roles: [], access_roles: ['administrator'], default_hourly_rate: null })
  })

  it('serves single records and the caller as users/me', async () => {
    const me = await harness.shim('/users/me')
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({ id: ids.owner, email: 'owner@example.test' })
    const client = await harness.shim(`/clients/${ids.clientA}`)
    expect(client.status).toBe(200)
    expect(await client.json()).toMatchObject({ id: ids.clientA, name: 'Sample Client A' })
    const project = await harness.shim(`/projects/${ids.projectA}`)
    expect(await project.json()).toMatchObject({ id: ids.projectA, client: { id: ids.clientA } })
    for (const path of ['/clients/9999', '/clients/abc', '/projects/0', '/users/9999']) {
      expect((await harness.shim(path)).status, path).toBe(404)
    }
  })

  it('applies the native visibility rules: a member sees only assigned work and no rates', async () => {
    const projects = await page<'projects'>(await harness.shim('/projects', 'member-ada'))
    expect(projects.projects.map((project) => project.id)).toEqual([ids.projectA])
    expect(projects.total_entries).toBe(1)
    // Hourly rate, fee and the commercial terms are not the member's to read.
    expect(projects.projects[0]).toMatchObject({
      hourly_rate: null,
      fee: null,
      cost_budget: null,
      is_billable: null,
      is_fixed_fee: null,
      bill_by: null,
    })
    const clients = await page<'clients'>(await harness.shim('/clients', 'member-ada'))
    expect(clients.clients.map((client) => client.id)).toEqual([ids.clientA])
    expect((await harness.shim(`/projects/${ids.projectB}`, 'member-ada')).status).toBe(404)
  })

  it('refuses users while the Team module is off, as the native route does', async () => {
    harness.setTeamModuleEnabled(false)
    for (const path of ['/users', '/users/me', `/users/${ids.ada}`]) {
      const response = await harness.shim(path)
      expect(response.status, path).toBe(403)
      expect(await response.json()).toMatchObject({ error: { code: 'module_disabled' } })
    }
    expect((await harness.shim('/clients')).status).toBe(200)
  })

  it('leaves the native API untouched: cursor pages and snake_case rows', async () => {
    const response = await harness.native('/clients?per_page=1')
    const body = (await response.json()) as { data: Array<{ id: number }>; page: { next_cursor: string | null } }
    expect(body.data.map((client) => client.id)).toEqual([ids.clientA])
    expect(body.page.next_cursor).not.toBeNull()
  })
})
