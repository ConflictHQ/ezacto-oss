import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../../db/src/adapters.js'
import { createGeneralResourceRepository } from '../../db/src/general-resources.js'
import { migrateContainer, migrateD1 } from '../../db/src/migrate.js'
import { createApiApp, installGeneralResourceRoutes } from '../src/index.js'

interface Harness {
  request(path: string, init?: RequestInit): Promise<Response>
  close(): Promise<void>
}

const signingKey = new Uint8Array(32).fill(0x71)
const now = '2026-08-28T12:00:00.000Z'

const containerHarness = async (): Promise<Harness> => {
  const sqlite = new BetterSqlite3(':memory:')
  migrateContainer(sqlite)
  const repository = createGeneralResourceRepository(createContainerDatabase(sqlite))
  const app = createApiApp({ installApi: (api) => installGeneralResourceRoutes(api, { repository, cursorSigningKey: signingKey, clock: () => now }) })
  return {
    request: (path, init) => Promise.resolve(app.request(`https://api.test/api/v1${path}`, init)),
    close: async () => { sqlite.close() },
  }
}

const d1Harness = async (): Promise<Harness> => {
  const miniflare = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'] })
  const d1 = await miniflare.getD1Database('DB')
  await migrateD1(d1)
  const repository = createGeneralResourceRepository(createD1Database(d1))
  const app = createApiApp({ installApi: (api) => installGeneralResourceRoutes(api, { repository, cursorSigningKey: signingKey, clock: () => now }) })
  return {
    request: (path, init) => Promise.resolve(app.request(`https://api.test/api/v1${path}`, init)),
    close: async () => { await miniflare.dispose() },
  }
}

const factories = [['SQLite', containerHarness], ['D1', d1Harness]] as const

const json = (body: unknown, method = 'POST'): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

const data = async (response: Response): Promise<Record<string, unknown>> => {
  expect(response.status, await response.clone().text()).toBeLessThan(300)
  return (await response.json() as { data: Record<string, unknown> }).data
}

for (const [runtime, createHarness] of factories) {
  describe(`${runtime} general-resource API`, () => {
    let harness: Harness
    beforeEach(async () => { harness = await createHarness() }, 20_000)
    afterEach(async () => harness.close())

    it('[api] provides CRUD and every combinable general-resource list filter', async () => {
      const parent = await data(await harness.request('/clients', json({ name: 'Parent', currency: 'USD' })))
      const parentId = parent.id as number
      const child = await data(await harness.request('/clients', json({ name: 'Child', currency: 'USD', parent_client_id: parentId, bill_to_client_id: parentId })))
      const childId = child.id as number
      await data(await harness.request('/clients', json({ name: 'Inactive sibling', currency: 'USD', is_active: false, parent_client_id: parentId })))

      await data(await harness.request('/users', json({ first_name: 'Owner', last_name: 'Admin', email: 'owner@example.test' })))
      const user = await data(await harness.request('/users', json({ first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.test', profile: 'accounting', is_contractor: true })))
      const userId = user.id as number
      expect(user).toMatchObject({ email: 'ada@example.test', profile: 'accounting', is_contractor: true, is_active: true })
      expect((await harness.request('/users', json({ first_name: 'Duplicate', last_name: 'Email', email: 'ADA@example.test' }))).status).toBe(409)
      await data(await harness.request('/users', json({ first_name: 'Grace', last_name: 'Hopper', email: 'grace@example.test', is_active: false, profile: 'member' })))

      const commonTask = await data(await harness.request('/tasks', json({ name: 'Common', is_default: true, billable_by_default: false })))
      const project = await data(await harness.request('/projects', json({ client_id: childId, name: 'Launch' })))
      const projectId = project.id as number
      const commonAssignmentsResponse = await harness.request(`/task-assignments?project_id=${projectId}&task_id=${commonTask.id as number}`)
      expect(commonAssignmentsResponse.status).toBe(200)
      expect((await commonAssignmentsResponse.json() as { data: Array<{ billable: boolean }> }).data).toEqual([expect.objectContaining({ billable: false })])
      await data(await harness.request(`/tasks/${commonTask.id as number}`, json({ is_active: false }, 'PATCH')))
      await data(await harness.request('/projects', json({ client_id: childId, name: 'Old', is_active: false })))

      const task = await data(await harness.request('/tasks', json({ name: 'Engineering' })))
      const taskId = task.id as number
      await data(await harness.request('/tasks', json({ name: 'Retired', is_active: false })))

      const contact = await data(await harness.request('/contacts', json({ client_id: childId, first_name: 'Bill' })))
      const contactId = contact.id as number
      const taskAssignment = await data(await harness.request('/task-assignments', json({ project_id: projectId, task_id: taskId })))
      const taskAssignmentId = taskAssignment.id as number
      expect(taskAssignment.billable).toBe(true)
      const userAssignment = await data(await harness.request('/user-assignments', json({ project_id: projectId, user_id: userId })))
      const userAssignmentId = userAssignment.id as number
      const role = await data(await harness.request('/roles', json({ name: 'Finance', user_ids: [userId] })))
      const roleId = role.id as number
      expect(role.user_ids).toEqual([userId])

      const since = encodeURIComponent('2026-08-28T00:00:00.000Z')
      for (const suffix of ['is_active=true', 'is_contractor=true', 'profile=accounting', `updated_since=${since}`]) {
        const response = await harness.request(`/users?${suffix}`)
        expect((await response.json() as { data: Array<{ id: number }> }).data.map(({ id }) => id), suffix).toContain(userId)
      }
      const queries: readonly [string, number][] = [
        [`/clients?is_active=true&parent_client_id=${parentId}&bill_to_client_id=${parentId}&updated_since=${since}`, childId],
        [`/contacts?client_id=${childId}&updated_since=${since}`, contactId],
        [`/projects?client_id=${childId}&is_active=true&updated_since=${since}`, projectId],
        [`/tasks?is_active=true&updated_since=${since}`, taskId],
        [`/task-assignments?project_id=${projectId}&task_id=${taskId}&is_active=true&updated_since=${since}`, taskAssignmentId],
        [`/user-assignments?project_id=${projectId}&user_id=${userId}&is_active=true&updated_since=${since}`, userAssignmentId],
        [`/users?is_active=true&is_contractor=true&profile=accounting&updated_since=${since}`, userId],
      ]
      for (const [path, expectedId] of queries) {
        const response = await harness.request(path)
        expect(response.status, path).toBe(200)
        const body = await response.json() as { data: Array<{ id: number }> }
        expect(body.data.map(({ id }) => id), path).toEqual([expectedId])
      }

      const updates: readonly [string, unknown, string, unknown][] = [
        [`/clients/${childId}`, { address: 'San Jose' }, 'address', 'San Jose'],
        [`/contacts/${contactId}`, { title: 'Controller' }, 'title', 'Controller'],
        [`/projects/${projectId}`, { notes: 'Ready' }, 'notes', 'Ready'],
        [`/tasks/${taskId}`, { name: 'Build' }, 'name', 'Build'],
        [`/task-assignments/${taskAssignmentId}`, { budget_seconds: 3600 }, 'budget_seconds', 3600],
        [`/user-assignments/${userAssignmentId}`, { is_project_manager: true }, 'is_project_manager', true],
        [`/users/${userId}`, { telephone: '+506', email: 'ada.new@example.test' }, 'telephone', '+506'],
        [`/roles/${roleId}`, { name: 'Accounting', user_ids: [] }, 'name', 'Accounting'],
      ]
      for (const [path, body, field, expected] of updates) {
        const updated = await data(await harness.request(path, json(body, 'PATCH')))
        expect(updated[field], path).toEqual(expected)
      }

      expect((await data(await harness.request(`/users/${userId}`))).email).toBe('ada.new@example.test')
      expect((await data(await harness.request(`/roles/${roleId}`))).user_ids).toEqual([])
      expect((await harness.request(`/contacts/${contactId}`, { method: 'DELETE' })).status).toBe(204)
      expect((await harness.request(`/contacts/${contactId}`)).status).toBe(404)
      expect((await harness.request(`/roles/${roleId}`, { method: 'DELETE' })).status).toBe(204)
      expect((await harness.request(`/roles/${roleId}`)).status).toBe(404)
      for (const path of [`/task-assignments/${taskAssignmentId}`, `/user-assignments/${userAssignmentId}`, `/projects/${projectId}`, `/tasks/${taskId}`, `/users/${userId}`, `/clients/${childId}`]) {
        expect((await harness.request(path, { method: 'DELETE' })).status, path).toBe(204)
        expect((await data(await harness.request(path))).is_active, path).toBe(false)
      }
    }, 20_000)

    it('[api] exposes rates as append-only POST/read collections', async () => {
      const user = await data(await harness.request('/users', json({ first_name: 'Rate', last_name: 'Owner', email: 'rate@example.test' })))
      const userId = user.id as number
      const first = await data(await harness.request(`/users/${userId}/billable-rates`, json({ amount_cents: 12_500, start_date: null })))
      const second = await data(await harness.request(`/users/${userId}/billable-rates`, json({ amount_cents: 15_000, start_date: '2026-08-28' })))
      const cost = await data(await harness.request(`/users/${userId}/cost-rates`, json({ amount_cents: 8_000, start_date: null })))
      expect(second.end_date).toBeNull()
      expect(cost.amount_cents).toBe(8_000)

      const list = await harness.request(`/users/${userId}/billable-rates`)
      expect(list.status).toBe(200)
      expect((await list.json() as { data: Array<{ id: number }> }).data.map(({ id }) => id)).toEqual([first.id, second.id])
      const reloadedFirst = await data(await harness.request(`/users/${userId}/billable-rates/${first.id as number}`))
      expect(reloadedFirst.end_date).toBe('2026-08-27')

      for (const method of ['PATCH', 'DELETE']) {
        const response = await harness.request(`/users/${userId}/billable-rates/${second.id as number}`, method === 'PATCH' ? json({ amount_cents: 1 }, method) : { method })
        expect(response.status).toBe(405)
        expect(response.headers.get('allow')).toBe('GET, POST')
        const collectionResponse = await harness.request(`/users/${userId}/billable-rates`, method === 'PATCH' ? json({ amount_cents: 1 }, method) : { method })
        expect(collectionResponse.status).toBe(405)
      }
      expect((await data(await harness.request(`/users/${userId}/billable-rates/${second.id as number}`))).amount_cents).toBe(15_000)
      expect((await harness.request('/users/999/billable-rates')).status).toBe(404)
    }, 20_000)

    it('[api] rejects unknown/non-combinable query inputs and translates DB constraints', async () => {
      const invalidFilter = await harness.request('/clients?is_active=true&unsupported=x')
      expect(invalidFilter.status).toBe(422)
      const invalidReference = await harness.request('/contacts', json({ client_id: 999, first_name: 'Nobody' }))
      expect(invalidReference.status, await invalidReference.clone().text()).toBe(422)
      expect((await invalidReference.json() as { error: { fields: Array<{ code: string }> } }).error.fields[0]?.code).toBe('invalid_reference')

      const first = await data(await harness.request('/clients', json({ name: 'Tree A', currency: 'USD' })))
      const second = await data(await harness.request('/clients', json({ name: 'Tree B', currency: 'USD', parent_client_id: first.id })))
      const cycle = await harness.request(`/clients/${first.id as number}`, json({ parent_client_id: second.id }, 'PATCH'))
      expect(cycle.status).toBe(422)
    }, 20_000)
  })
}
