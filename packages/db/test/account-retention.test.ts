import BetterSqlite3 from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateContainer } from '../src/migrate.js'
import { createAccountRetentionRepository } from '../src/account-retention.js'
import * as schema from '../src/schema.js'

const at = '2026-10-09T00:00:00.000Z'
const policy = {
  frameworks: ['colorado_cpa', 'gdpr'],
  retained_records: [],
  response_target_days: 14,
  operator_contact: 'privacy@example.test',
  user_notice: 'Contact our operator for account closure.',
  backup_handling: 'Review backups and replay closures before restored data is used.',
  acknowledged: true,
}
let sqlite: BetterSqlite3.Database
const setup = () => {
  sqlite = new BetterSqlite3(':memory:')
  migrateContainer(sqlite)
  sqlite.exec(`INSERT INTO users (id, first_name, last_name, profile, is_active, manager_grants, created_at, updated_at)
    VALUES (1, 'Ada', 'Example', 'administrator', 1, '[]', '${at}', '${at}'),
    (2, 'Sam', 'Example', 'member', 1, '[]', '${at}', '${at}'),
    (3, 'Jo', 'Example', 'administrator', 0, '[]', '${at}', '${at}')`)
  return createAccountRetentionRepository(drizzle(sqlite, { schema }))
}
afterEach(() => sqlite?.close())

describe('versioned operator retention policies', () => {
  it('has no implied legal policy on an upgraded instance', async () => {
    expect(await setup().read()).toBeNull()
  })
  it('publishes with compare-and-swap and keeps earlier disclosures intact', async () => {
    const repository = setup()
    const first = await repository.publish({ expectedVersion: 0, actorUserId: 1, now: at, policy })
    expect(first).toMatchObject({ version: 1, policy, publishedByUserId: 1, publishedAt: at })
    const writes = await Promise.allSettled([
      repository.publish({
        expectedVersion: 1,
        actorUserId: 1,
        now: at,
        policy: { ...policy, response_target_days: 7 },
      }),
      repository.publish({
        expectedVersion: 1,
        actorUserId: 1,
        now: at,
        policy: { ...policy, response_target_days: 21 },
      }),
    ])
    expect(writes.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(writes.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'stale_policy' },
    })
    expect(await repository.read()).toMatchObject({ version: 2 })
    expect(
      JSON.parse(
        (
          sqlite
            .prepare('SELECT policy_json FROM account_retention_policies WHERE version=1')
            .get() as { policy_json: string }
        ).policy_json,
      ),
    ).toEqual(policy)
    expect(() =>
      sqlite.exec(
        "UPDATE account_retention_policies SET published_at='2026-10-10T00:00:00.000Z' WHERE version=1",
      ),
    ).toThrow('publish a new')
  })
  it.each([2, 3, 999])(
    'refuses member, inactive or missing publisher %s at the write itself',
    async (actorUserId) => {
      const repository = setup()
      await expect(
        repository.publish({ expectedVersion: 0, actorUserId, now: at, policy }),
      ).rejects.toMatchObject({ code: 'administrator_required' })
      expect(await repository.read()).toBeNull()
    },
  )
  it('rejects incomplete policy even when invoked without the API', async () => {
    const repository = setup()
    await expect(
      repository.publish({
        expectedVersion: 0,
        actorUserId: 1,
        now: at,
        policy: { ...policy, acknowledged: false },
      }),
    ).rejects.toMatchObject({ name: 'AccountRetentionPolicyError' })
    expect(await repository.read()).toBeNull()
  })
})

// A real D1 binding exercises RETURNING, STRICT storage and the CAS statement,
// rather than assuming SQLite's synchronous adapter proves Worker behaviour.
describe('D1 operator retention policy', () => {
  it('allows one competing publisher and retains both complete versions', async () => {
    const { Miniflare } = await import('miniflare')
    const { drizzle: d1Drizzle } = await import('drizzle-orm/d1')
    const { migrateD1 } = await import('../src/migrate.js')
    const miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: ['DB'],
    })
    try {
      const binding = await miniflare.getD1Database('DB')
      await migrateD1(binding)
      await binding
        .prepare(
          `INSERT INTO users (id, first_name, last_name, profile, is_active, manager_grants, created_at, updated_at)
        VALUES (1, 'Ada', 'Example', 'administrator', 1, '[]', ?, ?)`,
        )
        .bind(at, at)
        .run()
      const repository = createAccountRetentionRepository(
        d1Drizzle(binding as unknown as D1Database, { schema }),
      )
      expect(await repository.read()).toBeNull()
      await repository.publish({ expectedVersion: 0, actorUserId: 1, now: at, policy })
      const writes = await Promise.allSettled(
        [7, 21].map((days) =>
          repository.publish({
            expectedVersion: 1,
            actorUserId: 1,
            now: at,
            policy: { ...policy, response_target_days: days },
          }),
        ),
      )
      expect(writes.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(writes.find((result) => result.status === 'rejected')).toMatchObject({
        reason: { code: 'stale_policy' },
      })
      expect(await repository.read()).toMatchObject({ version: 2 })
      expect(
        await binding.prepare('SELECT count(*) AS count FROM account_retention_policies').first(),
      ).toEqual({ count: 2 })
    } finally {
      await miniflare.dispose()
    }
  })
})
