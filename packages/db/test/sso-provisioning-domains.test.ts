import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  SsoProvisioningDomainError,
  createContainerSsoProvisioningDomainStore,
  createD1SsoProvisioningDomainStore,
  type SsoProvisioningDomainStore,
} from '../src/sso-provisioning-domains.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'

const created = '2026-09-05T12:00:00.000Z'
const checked = '2026-09-05T12:05:00.000Z'
const later = '2026-09-12T09:00:00.000Z'

interface Harness {
  store: SsoProvisioningDomainStore
  run(sql: string, ...bindings: unknown[]): Promise<void>
  rows<T>(sql: string, ...bindings: unknown[]): Promise<T[]>
  close(): Promise<void>
}

const tokens = ['A'.repeat(43), 'B'.repeat(43), 'C'.repeat(43)]
let issued = 0
const nextToken = (): string => tokens[issued++ % tokens.length]!

const containerHarness = async (): Promise<Harness> => {
  const database = new BetterSqlite3(':memory:')
  migrateContainer(database)
  return {
    store: createContainerSsoProvisioningDomainStore(database, { challengeToken: nextToken }),
    run: async (sql, ...bindings) => {
      database.prepare(sql).run(...bindings)
    },
    rows: async <T>(sql: string, ...bindings: unknown[]) =>
      database.prepare(sql).all(...bindings) as T[],
    close: async () => {
      database.close()
    },
  }
}

const d1Harness = async (): Promise<Harness> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const database = await miniflare.getD1Database('DB')
  await migrateD1(database)
  return {
    store: createD1SsoProvisioningDomainStore(database, { challengeToken: nextToken }),
    run: async (sql, ...bindings) => {
      await database
        .prepare(sql)
        .bind(...bindings)
        .run()
    },
    rows: async <T>(sql: string, ...bindings: unknown[]) =>
      (
        await database
          .prepare(sql)
          .bind(...bindings)
          .all<T>()
      ).results,
    close: async () => miniflare.dispose(),
  }
}

const factories = [
  ['container', containerHarness],
  ['D1', d1Harness],
] as const

for (const [runtime, factory] of factories) {
  describe(`SSO provisioning domain store (${runtime})`, () => {
    let harness: Harness

    beforeAll(async () => {
      harness = await factory()
    })

    beforeEach(async () => {
      await harness.run(`DELETE FROM sso_provisioning_domains`)
      issued = 0
    })

    afterAll(async () => harness.close())

    it('[unit] claims a domain unverified, with a challenge nobody could derive', async () => {
      const record = await harness.store.add('Example.Test.', created)
      expect(record).toMatchObject({
        domain: 'example.test',
        challengeToken: tokens[0],
        verifiedAt: null,
        lastCheckedAt: null,
        createdAt: created,
      })
      // Claiming is not owning: the row grants nothing until a check passes.
      expect(await harness.rows(`SELECT id FROM sso_provisioning_domains WHERE verified_at IS NOT NULL`)).toEqual([])
    })

    it('[unit] refuses a name no resolver could ever answer for', async () => {
      for (const value of ['', 'localhost', 'exam ple.com', 'example..com', '-bad.com', 'bad-.com']) {
        await expect(harness.store.add(value, created)).rejects.toMatchObject({
          code: 'invalid_domain',
        })
      }
      expect(await harness.rows(`SELECT id FROM sso_provisioning_domains`)).toEqual([])
    })

    it('[unit] refuses the same domain twice, however it is spelled', async () => {
      await harness.store.add('example.test', created)
      await expect(harness.store.add('EXAMPLE.TEST', created)).rejects.toBeInstanceOf(
        SsoProvisioningDomainError,
      )
      await expect(harness.store.add('example.test.', created)).rejects.toMatchObject({
        code: 'conflict',
      })
      expect(await harness.rows(`SELECT id FROM sso_provisioning_domains`)).toHaveLength(1)
    })

    it('[security] a failed re-check takes the provisioning right away again', async () => {
      const added = await harness.store.add('example.test', created)
      const verified = await harness.store.recordCheck(added.id, true, checked)
      expect(verified).toMatchObject({ verifiedAt: checked, lastCheckedAt: checked })

      const lapsed = await harness.store.recordCheck(added.id, false, later)
      expect(lapsed).toMatchObject({ verifiedAt: null, lastCheckedAt: later })
      // The check is still recorded, so a lapsed domain reads differently from
      // one nobody has ever looked at.
      expect(lapsed.lastCheckedAt).not.toBeNull()
    })

    it('[unit] reports a missing row rather than inventing one', async () => {
      await expect(harness.store.get(4_040)).rejects.toMatchObject({ code: 'not_found' })
      await expect(harness.store.remove(4_040)).rejects.toMatchObject({ code: 'not_found' })
      await expect(harness.store.recordCheck(4_040, true, checked)).rejects.toMatchObject({
        code: 'not_found',
      })
    })

    it('[unit] removes a domain, and with it the right it carried', async () => {
      const added = await harness.store.add('example.test', created)
      await harness.store.recordCheck(added.id, true, checked)
      await harness.store.remove(added.id)
      expect(await harness.store.list()).toEqual([])
    })
  })
}
