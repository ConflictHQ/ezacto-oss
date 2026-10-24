import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../../db/src/adapters.js'
import { createGeneralResourceRepository } from '../../db/src/general-resources.js'
import { createTeamRepository } from '../../db/src/team.js'
import { migrateContainer, migrateD1 } from '../../db/src/migrate.js'
import { DrizzleTrackedResourceRepository } from '../../db/src/tracked-resource-repository.js'
import {
  createApiApp,
  installGeneralResourceRoutes,
  installHarvestV2Routes,
  installTrackedResourceRoutes,
} from '../src/index.js'
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
    scopes: ['clients:read', 'projects:read', 'team:read', 'time_entries:read', 'expenses:read'],
  },
  'admin-invoices': {
    userId: 1,
    profile: 'administrator',
    scopes: [
      'clients:read',
      'projects:read',
      'team:read',
      'time_entries:read',
      'expenses:read',
      'invoices:read',
    ],
  },
  'clients-only': { userId: 1, profile: 'administrator', scopes: ['clients:read'] },
  'member-ada': {
    userId: 2,
    profile: 'member',
    scopes: ['clients:read', 'projects:read', 'time_entries:read', 'expenses:read'],
  },
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
  setExpensesModuleEnabled(enabled: boolean): void
  /** Run SQL against the organization's database, for state the API cannot reach. */
  exec(statement: string): Promise<void>
  close(): Promise<void>
}

const compose = (
  database: Parameters<typeof createGeneralResourceRepository>[0],
  exec: (statement: string) => Promise<void>,
  close: () => Promise<void>,
): Harness => {
  const repository = createGeneralResourceRepository(database)
  const teamRepository = createTeamRepository(database)
  const tracked = new DrizzleTrackedResourceRepository(database, { isLocked: async () => false })
  let teamModuleEnabled = true
  let expensesModuleEnabled = true
  const app = createApiApp({
    authentication,
    installApi: (api) => {
      installGeneralResourceRoutes(api, {
        repository,
        cursorSigningKey: signingKey,
        clock: () => now,
        isExpensesModuleEnabled: async () => true,
        teamRepository,
      })
      installTrackedResourceRoutes(api, {
        repository: tracked,
        clock: { now: () => ({ instant: now, date: '2026-08-28', time: '12:00' }) },
        cursorSigningKey: signingKey,
        isExpensesModuleEnabled: async () => true,
      })
    },
    installHarvestV2: (harvest) =>
      installHarvestV2Routes(harvest, {
        repository,
        timeEntries: tracked,
        expenses: tracked,
        isExpensesModuleEnabled: async () => expensesModuleEnabled,
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
    setExpensesModuleEnabled: (enabled) => {
      expensesModuleEnabled = enabled
    },
    exec,
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
  return compose(
    database,
    async (statement) => {
      sqlite.exec(statement)
    },
    async () => {
      sqlite.close()
    },
  )
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
  return compose(
    database,
    async (statement) => {
      await d1.exec(statement.replaceAll('\n', ' '))
    },
    () => miniflare.dispose(),
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

  describe('time entries and project assignments', () => {
    let taskOne = 0
    let entries: { duration: number; startEnd: number }

    const post = async (path: string, body: unknown): Promise<number> =>
      created(await harness.native(path, json(body)))

    beforeEach(async () => {
      const tasks = await page<'tasks'>(await harness.shim('/tasks'))
      taskOne = tasks.tasks[0]!.id as number
      const taskTwo = tasks.tasks[1]!.id as number
      await post('/task-assignments', {
        project_id: ids.projectA,
        task_id: taskOne,
        hourly_rate_cents: 9_500,
        budget_seconds: 7_200,
      })
      await post('/task-assignments', { project_id: ids.projectA, task_id: taskTwo, billable: false })
      const duration = await post('/time-entries', {
        user_id: ids.ada,
        project_id: ids.projectA,
        task_id: taskOne,
        spent_date: '2026-08-27',
        seconds: 5_400,
        notes: 'Invented note.',
      })
      await harness.exec("UPDATE organizations SET time_entry_mode = 'start_end', clock = '12h'")
      const startEnd = await post('/time-entries', {
        user_id: ids.ada,
        project_id: ids.projectA,
        task_id: taskOne,
        spent_date: '2026-08-26',
        started_time: '08:05',
        ended_time: '17:30',
      })
      entries = { duration, startEnd }
    })

    const list = (query = '', token = 'admin') => harness.shim(`/time_entries${query}`, token)

    it('needs a bearer with the time_entries:read scope', async () => {
      expect((await list('', 'clients-only')).status).toBe(403)
      expect((await harness.shim('/time_entries', null)).status).toBe(401)
      expect((await harness.shim(`/time_entries/${entries.duration}`, 'clients-only')).status).toBe(403)
    })

    it('lists every person\'s entries for an administrator, in the Harvest envelope', async () => {
      const body = await page<'time_entries'>(await list())
      expect(body).toMatchObject({ per_page: 2000, total_pages: 1, total_entries: 2, page: 1 })
      expect(body.links.first).toBe('/harvest/v2/time_entries?page=1&per_page=2000')
      expect(body.time_entries.map((entry) => entry.id)).toEqual([entries.duration, entries.startEnd])
    })

    it('renders the start/end entry in the organization clock with embedded rows', async () => {
      const body = await page<'time_entries'>(await list(`?user_id=${ids.ada}&from=2026-08-26&to=2026-08-26`))
      expect(body.total_entries).toBe(1)
      expect(body.time_entries[0]).toEqual({
        id: entries.startEnd,
        spent_date: '2026-08-26',
        hours: 9.42,
        hours_without_timer: 9.42,
        rounded_hours: 9.42,
        notes: null,
        is_locked: false,
        locked_reason: null,
        is_closed: false,
        approval_status: 'unsubmitted',
        is_billed: null,
        timer_started_at: null,
        started_time: '8:05am',
        ended_time: '5:30pm',
        is_running: false,
        billable: true,
        budgeted: false,
        // The project bills by project, so the entry took the project's rate.
        billable_rate: 150,
        cost_rate: 80,
        created_at: '2026-08-28T12:00:00Z',
        updated_at: '2026-08-28T12:00:00Z',
        user: { id: ids.ada, name: 'Sample Ada' },
        client: { id: ids.clientA, name: 'Sample Client A', currency: 'USD' },
        project: { id: ids.projectA, name: 'Sample Project A', code: 'SMP-1' },
        task: { id: taskOne, name: 'Sample Task One' },
        user_assignment: expect.objectContaining({ is_active: true, is_project_manager: false }),
        task_assignment: expect.objectContaining({ billable: true, hourly_rate: 95, budget: 2 }),
        invoice: null,
        external_reference: null,
      })
    })

    it('shows the same entry on a 24h clock once the organization changes it', async () => {
      await harness.exec("UPDATE organizations SET clock = '24h'")
      const entry = await (await harness.shim(`/time_entries/${entries.startEnd}`)).json()
      expect(entry).toMatchObject({ started_time: '08:05', ended_time: '17:30' })
    })

    it('renders a duration-mode entry with hours and no clock times', async () => {
      const entry = (await (await harness.shim(`/time_entries/${entries.duration}`)).json()) as Record<string, unknown>
      expect(entry).toMatchObject({
        hours: 1.5,
        notes: 'Invented note.',
        started_time: null,
        ended_time: null,
        is_running: false,
      })
    })

    it('pages by offset and filters in the repository', async () => {
      const second = await page<'time_entries'>(await list('?per_page=1&page=2'))
      expect(second.time_entries.map((entry) => entry.id)).toEqual([entries.startEnd])
      expect(second).toMatchObject({ total_pages: 2, total_entries: 2, next_page: null, previous_page: 1 })
      const beyond = await page<'time_entries'>(await list('?per_page=1&page=3'))
      expect(beyond.time_entries).toEqual([])
      const byProject = await page<'time_entries'>(await list(`?project_id=${ids.projectB}`))
      expect(byProject.total_entries).toBe(0)
      const byDate = await page<'time_entries'>(await list('?from=2026-08-27'))
      expect(byDate.time_entries.map((entry) => entry.id)).toEqual([entries.duration])
      expect((await list('?from=2026-02-30')).status).toBe(422)
    })

    it('shows a member only their own time, with no rates unless the organization allows it', async () => {
      // The member is Ada (id 2): her entries only, and an id that is not hers is not found.
      const own = await page<'time_entries'>(await list('', 'member-ada'))
      expect(own.time_entries.map((entry) => entry.id)).toEqual([entries.duration, entries.startEnd])
      expect(own.time_entries[0]).toMatchObject({ billable_rate: null, cost_rate: null })
      expect((await list(`?user_id=${ids.owner}`, 'member-ada')).status).toBe(403)
      const mine = await harness.shim(`/time_entries/${entries.duration}`, 'member-ada')
      expect(mine.status).toBe(200)
    })

    it('hides invoice state without the invoices:read scope and refuses the filters', async () => {
      expect((await list('?is_billed=true')).status).toBe(403)
      expect((await list('?is_billed=false', 'admin-invoices')).status).toBe(200)
      const body = await page<'time_entries'>(await list('', 'admin'))
      expect(body.time_entries.every((entry) => entry.is_billed === null && entry.invoice === null)).toBe(true)
    })

    it('embeds the invoice number for a billed entry and says it is locked', async () => {
      await harness.exec(`INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date, state,
        foregone_billable_cents, created_at, updated_at)
        VALUES (900, ${ids.clientA}, 'SMP-0042', 'USD', '2026-08-28', '2026-09-28', 'open', 0,
        '${now}', '${now}');
        UPDATE time_entries SET invoice_id = 900 WHERE id = ${entries.duration}`)
      const billed = (await (await harness.shim(`/time_entries/${entries.duration}`, 'admin-invoices')).json()) as Record<string, unknown>
      expect(billed).toMatchObject({
        is_billed: true,
        is_locked: true,
        locked_reason: 'Invoiced',
        invoice: { id: 900, number: 'SMP-0042' },
      })
      const hidden = (await (await harness.shim(`/time_entries/${entries.duration}`, 'admin')).json()) as Record<string, unknown>
      expect(hidden).toMatchObject({ is_billed: null, invoice: null, locked_reason: 'This record is locked.' })
      const billedList = await page<'time_entries'>(await list('?is_billed=true', 'admin-invoices'))
      expect(billedList.time_entries.map((entry) => entry.id)).toEqual([entries.duration])
    })

    it('answers 404 for an unknown or malformed entry id', async () => {
      for (const path of ['/time_entries/9999', '/time_entries/abc', '/time_entries/0'])
        expect((await harness.shim(path)).status, path).toBe(404)
    })

    it('serves the bootstrap project assignments of the caller and of a named user', async () => {
      const mine = await page<'project_assignments'>(await harness.shim('/users/me/project_assignments', 'member-ada'))
      expect(mine.total_entries).toBe(1)
      expect(mine.links.first).toBe('/harvest/v2/users/me/project_assignments?page=1&per_page=2000')
      expect(mine.project_assignments[0]).toMatchObject({
        is_project_manager: false,
        is_active: true,
        use_default_rates: true,
        // Rates are not a member's to read.
        hourly_rate: null,
        budget: null,
        project: { id: ids.projectA, name: 'Sample Project A', code: 'SMP-1' },
        client: { id: ids.clientA, name: 'Sample Client A', currency: 'USD' },
      })
      expect(mine.project_assignments[0]!.task_assignments).toEqual([
        expect.objectContaining({ billable: true, hourly_rate: null, budget: 2, task: { id: taskOne, name: 'Sample Task One' } }),
        expect.objectContaining({ billable: false, task: expect.objectContaining({ name: 'Sample Task Two' }) }),
      ])
      const named = await page<'project_assignments'>(await harness.shim(`/users/${ids.ada}/project_assignments`))
      expect(named.project_assignments[0]!.task_assignments).toEqual([
        expect.objectContaining({ hourly_rate: 95 }),
        expect.objectContaining({ hourly_rate: null }),
      ])
    })

    it('pages and filters assignments, and refuses what the caller may not reach', async () => {
      const inactive = await page<'project_assignments'>(
        await harness.shim(`/users/${ids.ada}/project_assignments?is_active=false`),
      )
      expect(inactive.total_entries).toBe(0)
      const beyond = await page<'project_assignments'>(
        await harness.shim(`/users/${ids.ada}/project_assignments?per_page=1&page=2`),
      )
      expect(beyond).toMatchObject({ total_entries: 1, total_pages: 1, project_assignments: [] })
      expect((await harness.shim(`/users/${ids.ada}/project_assignments?page=0`)).status).toBe(422)
      expect((await harness.shim('/users/9999/project_assignments')).status).toBe(404)
      expect((await harness.shim('/users/abc/project_assignments')).status).toBe(404)
      // Another person's assignments are Team data: not a member's to list.
      expect((await harness.shim(`/users/${ids.owner}/project_assignments`, 'member-ada')).status).toBe(403)
      expect((await harness.shim('/users/me/project_assignments', 'clients-only')).status).toBe(403)
      // With the Team module off a person still reads their own, and nobody else's.
      harness.setTeamModuleEnabled(false)
      expect((await harness.shim('/users/me/project_assignments', 'member-ada')).status).toBe(200)
      const refused = await harness.shim(`/users/${ids.ada}/project_assignments`)
      expect(refused.status).toBe(403)
      expect(await refused.json()).toMatchObject({ error: { code: 'module_disabled' } })
    })
  })
  describe('expenses', () => {
    let mileage = 0
    let expenses: { ada: number; owner: number }

    const insert = async (userId: number, units: number | null, totalCents: number, category: number) => {
      const id = userId * 100
      await harness.exec(`INSERT INTO expenses (id, user_id, project_id, expense_category_id, spent_date, notes, units,
        total_cost_cents, billable, created_at, updated_at)
        VALUES (${id}, ${userId}, ${ids.projectA}, ${category}, '2026-08-27', 'Invented note.',
        ${units ?? 'NULL'}, ${totalCents}, 1, '${now}', '${now}')`)
      return id
    }

    beforeEach(async () => {
      mileage = await created(
        await harness.native(
          '/expense-categories',
          json({ name: 'Sample Mileage', unit_name: 'Sample mile', unit_price_cents: 67 }),
        ),
      )
      expenses = {
        ada: await insert(ids.ada, 120, 8_040, mileage),
        owner: await insert(ids.owner, null, 1_999, mileage),
      }
    })

    const list = (query = '', token = 'admin') => harness.shim(`/expenses${query}`, token)

    it('needs a bearer with the expenses:read scope and the module on', async () => {
      expect((await list('', 'clients-only')).status).toBe(403)
      expect((await harness.shim('/expenses', null)).status).toBe(401)
      expect((await harness.shim(`/expenses/${expenses.ada}`, 'clients-only')).status).toBe(403)
      harness.setExpensesModuleEnabled(false)
      for (const path of ['/expenses', `/expenses/${expenses.ada}`]) {
        const response = await harness.shim(path)
        expect(response.status, path).toBe(403)
        expect(await response.json()).toMatchObject({ error: { code: 'module_disabled' } })
      }
    })

    it('lists every person\'s expenses for an administrator, in the Harvest envelope', async () => {
      const body = await page<'expenses'>(await list())
      expect(body).toMatchObject({ per_page: 2000, total_pages: 1, total_entries: 2, page: 1 })
      expect(body.links.first).toBe('/harvest/v2/expenses?page=1&per_page=2000')
      expect(body.expenses.map((expense) => expense.id)).toEqual([expenses.owner, expenses.ada])
    })

    it('renders decimal money with the embedded category, project, client, user and assignment', async () => {
      const expense = await (await harness.shim(`/expenses/${expenses.ada}`)).json()
      expect(expense).toEqual({
        id: expenses.ada,
        notes: 'Invented note.',
        total_cost: 80.4,
        units: 120,
        is_closed: false,
        approval_status: 'unsubmitted',
        is_locked: false,
        is_billed: null,
        locked_reason: null,
        spent_date: '2026-08-27',
        created_at: '2026-08-28T12:00:00Z',
        updated_at: '2026-08-28T12:00:00Z',
        billable: true,
        user: { id: ids.ada, name: 'Sample Ada' },
        user_assignment: expect.objectContaining({ is_active: true, is_project_manager: false }),
        project: { id: ids.projectA, name: 'Sample Project A', code: 'SMP-1' },
        expense_category: { id: mileage, name: 'Sample Mileage', unit_name: 'Sample mile', unit_price: 0.67 },
        client: { id: ids.clientA, name: 'Sample Client A', currency: 'USD' },
        invoice: null,
      })
      // The owner was never assigned to the project, so there is no assignment to embed.
      const unassigned = (await (await harness.shim(`/expenses/${expenses.owner}`)).json()) as Record<string, unknown>
      expect(unassigned).toMatchObject({ total_cost: 19.99, units: null, user_assignment: null })
    })

    it('pages by offset and filters in the repository', async () => {
      const second = await page<'expenses'>(await list('?per_page=1&page=2'))
      expect(second.expenses.map((expense) => expense.id)).toEqual([expenses.ada])
      expect(second).toMatchObject({ total_pages: 2, total_entries: 2, next_page: null, previous_page: 1 })
      expect((await page<'expenses'>(await list('?per_page=1&page=3'))).expenses).toEqual([])
      expect((await page<'expenses'>(await list(`?project_id=${ids.projectB}`))).total_entries).toBe(0)
      expect((await page<'expenses'>(await list(`?client_id=${ids.clientA}`))).total_entries).toBe(2)
      expect((await page<'expenses'>(await list('?from=2026-08-28'))).total_entries).toBe(0)
      const named = await page<'expenses'>(await list(`?user_id=${ids.ada}`))
      expect(named.expenses.map((expense) => expense.id)).toEqual([expenses.ada])
      expect(named.links.first).toBe(`/harvest/v2/expenses?user_id=${ids.ada}&page=1&per_page=2000`)
      for (const query of ['?from=2026-02-30', '?user_id=abc', '?is_billed=maybe', '?page=0'])
        expect((await list(query)).status, query).toBe(422)
    })

    it('shows a member only their own expenses and refuses naming anyone else', async () => {
      const own = await page<'expenses'>(await list('', 'member-ada'))
      expect(own.expenses.map((expense) => expense.id)).toEqual([expenses.ada])
      expect((await list(`?user_id=${ids.owner}`, 'member-ada')).status).toBe(403)
      expect((await harness.shim(`/expenses/${expenses.owner}`, 'member-ada')).status).toBe(404)
      expect((await harness.shim(`/expenses/${expenses.ada}`, 'member-ada')).status).toBe(200)
    })

    it('hides invoice state without the invoices:read scope and refuses the filters', async () => {
      expect((await list('?is_billed=true')).status).toBe(403)
      expect((await list('?is_billed=false', 'admin-invoices')).status).toBe(200)
      const body = await page<'expenses'>(await list())
      expect(body.expenses.every((expense) => expense.is_billed === null && expense.invoice === null)).toBe(true)
    })

    it('embeds the invoice number for a billed expense and says it is locked', async () => {
      await harness.exec(`INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date, state,
        foregone_billable_cents, created_at, updated_at)
        VALUES (900, ${ids.clientA}, 'SMP-0042', 'USD', '2026-08-28', '2026-09-28', 'open', 0,
        '${now}', '${now}');
        UPDATE expenses SET invoice_id = 900 WHERE id = ${expenses.ada}`)
      const billed = await (await harness.shim(`/expenses/${expenses.ada}`, 'admin-invoices')).json()
      expect(billed).toMatchObject({
        is_billed: true,
        is_locked: true,
        locked_reason: 'Invoiced',
        invoice: { id: 900, number: 'SMP-0042' },
      })
      const hidden = await (await harness.shim(`/expenses/${expenses.ada}`, 'admin')).json()
      expect(hidden).toMatchObject({ is_billed: null, invoice: null, locked_reason: 'This record is locked.' })
      const billedList = await page<'expenses'>(await list('?is_billed=true', 'admin-invoices'))
      expect(billedList.expenses.map((expense) => expense.id)).toEqual([expenses.ada])
    })

    it('answers 404 for an unknown or malformed expense id and serves no mutating verbs', async () => {
      for (const path of ['/expenses/9999', '/expenses/abc', '/expenses/0'])
        expect((await harness.shim(path)).status, path).toBe(404)
      expect((await harness.shim('/expenses', 'admin', json({ notes: 'Sample' }))).status).toBe(404)
    })
  })
})
