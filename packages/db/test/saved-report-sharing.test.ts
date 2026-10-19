// #933: a saved report is private to its author, shared with named people or
// with whole roles, and visible in full to administrators. Run on both
// runtimes because the visibility rule is SQL and D1 is not better-sqlite3.
import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { createReportRepository } from '../src/reports.js'

const at = '2026-10-18T12:00:00.000Z'
const authority = { billableMoney: true, costMoney: true }
const presentation = { result: 'summary', grouped: true, includeZeroValues: false } as const

const users = [
  [1, 'Ada', 'Admin', 'administrator'],
  [2, 'Olive', 'Owner', 'accounting'],
  [3, 'Nora', 'Named', 'accounting'],
  [4, 'Otto', 'Outside', 'accounting'],
  [5, 'Pia', 'Manager', 'project_manager'],
  [6, 'Mo', 'Member', 'member'],
] as const

const seedStatements = [
  `INSERT INTO organizations (name, modules, created_at, updated_at) VALUES ('Org', '{}', '${at}', '${at}')`,
  ...users.map(
    ([id, first, last, profile]) =>
      `INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
        VALUES (${id}, '${first}', '${last}', '${profile}', '[]', '${at}', '${at}')`,
  ),
]

interface Harness {
  readonly repository: ReturnType<typeof createReportRepository>
  readonly migrateAgain: () => Promise<void>
  readonly close: () => Promise<void>
}

const containerHarness = async (): Promise<Harness> => {
  const client = new BetterSqlite3(':memory:')
  migrateContainer(client)
  for (const statement of seedStatements) client.exec(statement)
  return {
    repository: createReportRepository(createContainerDatabase(client)),
    migrateAgain: async () => migrateContainer(client),
    close: async () => {
      client.close()
    },
  }
}

const d1Harness = async (): Promise<Harness> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const client = await miniflare.getD1Database('DB')
  await migrateD1(client)
  for (const statement of seedStatements) await client.prepare(statement).run()
  return {
    repository: createReportRepository(createD1Database(client)),
    migrateAgain: async () => migrateD1(client),
    close: async () => miniflare.dispose(),
  }
}

const create = (harness: Harness, id: string, ownerUserId = 2) =>
  harness.repository.createSavedReport({
    id,
    name: `Report ${id}`,
    fields: [{ id: 'client_name', label: 'Client', visible: true }],
    metrics: ['hours'],
    filters: [],
    groupBy: { dimension: 'client' },
    ownerUserId,
    presentation,
    createdAt: at,
  })

for (const [runtime, factory] of [
  ['container', containerHarness],
  ['D1', d1Harness],
] as const) {
  describe(`saved report sharing (${runtime})`, () => {
    let harness: Harness
    beforeAll(async () => {
      harness = await factory()
    })
    afterAll(async () => {
      await harness.close()
    })

    it('keeps a new report private: another person can neither read, list, run nor pin it', async () => {
      const created = await create(harness, 'private')
      expect(created).toMatchObject({ ownedByViewer: true, canDelete: true, shared: false })
      for (const stranger of [3, 4, 5, 6]) {
        await expect(harness.repository.readSavedReport('private', stranger)).resolves.toBeNull()
        await expect(harness.repository.runSavedReport('private', stranger, authority)).resolves.toBeNull()
        await expect(harness.repository.listSavedReports({ viewerUserId: stranger })).resolves.toEqual([])
        await expect(harness.repository.pinSavedReport('private', stranger, true, at)).resolves.toBe(false)
      }
      await expect(harness.repository.runSavedReport('private', 2, authority)).resolves.toMatchObject({
        definitionId: 'private',
      })
    })

    it('lets administrators read, run, list and delete every report but not change its sharing', async () => {
      await create(harness, 'admin-sees')
      await expect(harness.repository.readSavedReport('admin-sees', 1)).resolves.toMatchObject({
        ownedByViewer: false,
        canDelete: true,
        shared: false,
        sharing: { users: [], profiles: [] },
      })
      await expect(harness.repository.runSavedReport('admin-sees', 1, authority)).resolves.toMatchObject({
        definitionId: 'admin-sees',
      })
      const listed = await harness.repository.listSavedReports({ viewerUserId: 1 })
      expect(listed.map((report) => report.definition.id)).toEqual(
        expect.arrayContaining(['private', 'admin-sees']),
      )
      await expect(harness.repository.shareSavedReport('admin-sees', 1, 4, true, at)).resolves.toBe(false)
      await expect(
        harness.repository.shareSavedReportWithProfile('admin-sees', 1, 'member', true, at),
      ).resolves.toBe(false)
      await expect(harness.repository.deleteSavedReport('admin-sees', 1)).resolves.toBe(true)
      await expect(harness.repository.readSavedReport('admin-sees', 2)).resolves.toBeNull()
    })

    it('shares with a named person and only that person', async () => {
      await create(harness, 'named')
      await expect(harness.repository.shareSavedReport('named', 2, 3, true, at)).resolves.toBe(true)
      await expect(harness.repository.readSavedReport('named', 3)).resolves.toMatchObject({
        shared: true,
        ownedByViewer: false,
        canDelete: false,
        sharing: { users: [], profiles: [] },
      })
      await expect(harness.repository.runSavedReport('named', 3, authority)).resolves.toMatchObject({
        definitionId: 'named',
      })
      await expect(harness.repository.readSavedReport('named', 4)).resolves.toBeNull()
      await expect(harness.repository.runSavedReport('named', 4, authority)).resolves.toBeNull()
      // The owner alone sees who the report was shared with.
      await expect(harness.repository.readSavedReport('named', 2)).resolves.toMatchObject({
        sharing: { users: [{ userId: 3, name: 'Nora Named' }], profiles: [] },
      })
      await expect(harness.repository.deleteSavedReport('named', 3)).resolves.toBe(false)
      await expect(harness.repository.shareSavedReport('named', 2, 3, false, at)).resolves.toBe(true)
      await expect(harness.repository.readSavedReport('named', 3)).resolves.toBeNull()
    })

    it('shares with a role: its members see the report, everyone else does not', async () => {
      await create(harness, 'role')
      await expect(
        harness.repository.shareSavedReportWithProfile('role', 3, 'project_manager', true, at),
      ).resolves.toBe(false)
      await expect(
        harness.repository.shareSavedReportWithProfile('role', 2, 'project_manager', true, at),
      ).resolves.toBe(true)
      await expect(
        harness.repository.shareSavedReportWithProfile('role', 2, 'project_manager', true, at),
      ).resolves.toBe(true)
      await expect(harness.repository.readSavedReport('role', 5)).resolves.toMatchObject({
        shared: true,
        canDelete: false,
      })
      await expect(harness.repository.runSavedReport('role', 5, authority)).resolves.toMatchObject({
        definitionId: 'role',
      })
      await expect(harness.repository.listSavedReports({ viewerUserId: 5, view: 'shared' })).resolves.toHaveLength(1)
      for (const outsider of [3, 4, 6]) {
        await expect(harness.repository.readSavedReport('role', outsider)).resolves.toBeNull()
        await expect(harness.repository.runSavedReport('role', outsider, authority)).resolves.toBeNull()
      }
      await expect(harness.repository.readSavedReport('role', 2)).resolves.toMatchObject({
        sharing: { users: [], profiles: ['project_manager'] },
      })
      await expect(
        harness.repository.shareSavedReportWithProfile('role', 2, 'project_manager', false, at),
      ).resolves.toBe(true)
      await expect(harness.repository.readSavedReport('role', 5)).resolves.toBeNull()
    })

    it('deletes for the owner and administrators only', async () => {
      await create(harness, 'mine')
      await harness.repository.shareSavedReportWithProfile('mine', 2, 'accounting', true, at)
      await expect(harness.repository.readSavedReport('mine', 4)).resolves.toMatchObject({ canDelete: false })
      await expect(harness.repository.deleteSavedReport('mine', 4)).resolves.toBe(false)
      await expect(harness.repository.deleteSavedReport('mine', 6)).resolves.toBe(false)
      await expect(harness.repository.deleteSavedReport('mine', 2)).resolves.toBe(true)
      await expect(harness.repository.deleteSavedReport('mine', 2)).resolves.toBe(false)
    })

    it('migrating again changes nothing', async () => {
      await expect(harness.migrateAgain()).resolves.not.toThrow()
    })
  })
}
