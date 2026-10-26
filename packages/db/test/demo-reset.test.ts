import { createCalendarGrantVault } from '@ezacto/core'
import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import {
  billDemoBacklog,
  createContainerDemoResetDriver,
  createD1DemoResetDriver,
  PRESERVED_TABLES,
  wipeAndSeedDemo,
  type DemoResetDriver,
} from '../src/demo-reset.js'
import type { InvoiceGenerationDatabase } from '../src/invoice-generation.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { createManagedQuickBooksGrantStore } from '../src/managed-quickbooks.js'
import { createManagedQuickBooksLifecycleStore } from '../src/managed-quickbooks-lifecycle.js'
import type { ManagedQuickBooksGrantCommand } from '@ezacto/core'

const now = '2026-09-09T12:00:00.000Z'
// Long enough that several client-months are billable, short enough that the
// suite is not billing three years of eight clients to prove it can bill one.
const years = 0.3

let open: BetterSqlite3.Database | undefined
afterEach(() => {
  open?.close()
  open = undefined
})

const harness = (): { client: BetterSqlite3.Database; driver: DemoResetDriver } => {
  const client = new BetterSqlite3(':memory:')
  open = client
  client.pragma('foreign_keys = ON')
  const orm = createContainerDatabase(client) as unknown as InvoiceGenerationDatabase
  return { client, driver: createContainerDemoResetDriver(client, orm, migrateContainer) }
}

const count = (client: BetterSqlite3.Database, table: string): number =>
  (client.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n

const tablesOf = (client: BetterSqlite3.Database): string[] =>
  (
    client
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      .all() as { name: string }[]
  ).map((row) => row.name)

describe('demo reset', () => {
  it('[unit] refuses without the spelled-out confirmation', async () => {
    // The first thing a reset does is empty every table. A boolean would read
    // as a flag; this has to read as a decision at the call site.
    const { driver } = harness()

    await expect(
      wipeAndSeedDemo(driver, { now, years, confirm: 'yes' as 'wipe-and-reload' }),
    ).rejects.toThrow('wipe-and-reload')
  })

  it('[unit] preserves exactly the tables a fresh migration run fills', () => {
    // The drift guard. A migration that seeds a new table has to be added to
    // PRESERVED_TABLES, or the nightly wipe empties it and the install breaks
    // in a way nobody would connect back to the migration.
    const { client } = harness()
    migrateContainer(client)
    const filled = tablesOf(client).filter((table) => count(client, table) > 0)

    expect([...filled].sort()).toEqual([...PRESERVED_TABLES].sort())
  })

  it('[security] preserves the original account closure secret across a demo reset', async () => {
    const { client, driver } = harness()
    migrateContainer(client)
    const before = client.prepare('SELECT secret FROM account_closure_security WHERE id = 1').get() as {
      secret: string
    }

    await wipeAndSeedDemo(driver, { now, years, confirm: 'wipe-and-reload' })

    // Compare inside SQLite so an assertion failure never prints key material.
    const unchanged = client
      .prepare('SELECT count(*) AS n FROM account_closure_security WHERE id = 1 AND secret = ?')
      .get(before.secret) as { n: number }
    expect(unchanged.n).toBe(1)
    expect(count(client, 'account_closure_security')).toBe(1)
  })

  it('[security] keeps authorization revisions advancing after a demo reset', async () => {
    const { client, driver } = harness()
    migrateContainer(client)
    client.exec('UPDATE idempotency_authorization SET revision = 1000 WHERE id = 1')
    client.exec('UPDATE contractor_source_clock SET revision = 2000 WHERE id=1')
    const revision = () => client
      .prepare('SELECT revision FROM idempotency_authorization WHERE id = 1')
      .get() as { revision: number } | undefined

    await wipeAndSeedDemo(driver, { now, years, confirm: 'wipe-and-reload' })

    const rebuilt = revision()
    expect(rebuilt?.revision).toBeGreaterThan(1000)
    const source = client.prepare('SELECT revision FROM contractor_source_clock WHERE id=1').get() as {revision:number}
    expect(source.revision).toBeGreaterThan(2000)
    const revoked = client.prepare(`UPDATE users SET is_active = 0 WHERE id = (
      SELECT id FROM users WHERE is_active = 1 AND profile = 'member' ORDER BY id LIMIT 1
    )`).run()
    expect(revoked.changes).toBe(1)
    expect(revision()?.revision).toBe(rebuilt!.revision + 1)
  })

  it('[security] clears QuickBooks credentials/receipts but fences pending grants across a completed demo wipe', async () => {
    const { client, driver } = harness()
    migrateContainer(client)
    client
      .prepare(
        `INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at)
      VALUES(1,'Owned','Administrator','administrator','[]',?,?)`,
      )
      .run(now, now)
    const db = createContainerDatabase(client)
    const grants = createManagedQuickBooksGrantStore(db)
    const lifecycle = createManagedQuickBooksLifecycleStore(db)
    const authority = { kind: 'guarded-session' as const, userId: 1 }
    const command: ManagedQuickBooksGrantCommand = {
      grantId: 'a'.repeat(64),
      browserHash: 'b'.repeat(64),
      credentialHash: 'c'.repeat(64),
      expectedActorUserId: 1,
      expectedConnectionGeneration: 0,
      expiresAt: Date.parse(now) + 600_000,
      tokens: {
        realmId: 'owned-demo-realm',
        companyName: null,
        accessToken: 'OWNED_DEMO_ACCESS',
        refreshToken: 'OWNED_DEMO_REFRESH',
        accessTokenExpiresAt: '2026-09-09T13:00:00.000Z',
        refreshTokenExpiresAt: '2027-09-09T12:00:00.000Z',
        scope: 'com.intuit.quickbooks.accounting',
      },
    }
    await grants.accept(command, authority, now)
    await lifecycle.fence(
      {
        revocationId: 'e'.repeat(64),
        grantId: command.grantId,
        expectedActorUserId: 1,
        expectedConnectionGeneration: 1,
        environment: 'sandbox',
        reason: 'disconnect',
      },
      authority,
      now,
    )
    const pending = { ...command, grantId: 'd'.repeat(64), expectedConnectionGeneration: 2 }
    expect(await grants.prepare(authority, now)).toEqual({
      connectionGeneration: 2,
      connected: false,
    })
    expect(count(client, 'quickbooks_managed_grants')).toBe(1)
    expect(count(client, 'quickbooks_revocations')).toBe(1)

    await wipeAndSeedDemo(driver, { now, years, confirm: 'wipe-and-reload' })

    expect(count(client, 'quickbooks_managed_grants')).toBe(0)
    expect(count(client, 'quickbooks_revocations')).toBe(0)
    expect(count(client, 'quickbooks_connections')).toBe(0)
    await expect(grants.accept(pending, authority, now)).rejects.toMatchObject({ kind: 'conflict' })
    expect(await grants.prepare(authority, now)).toEqual({
      connectionGeneration: 3,
      connected: false,
    })
    expect(count(client, 'quickbooks_managed_grants')).toBe(0)
    expect(count(client, 'quickbooks_connections')).toBe(0)
    await expect(
      grants.accept(
        { ...pending, grantId: 'e'.repeat(64), expectedConnectionGeneration: 3 },
        authority,
        now,
      ),
    ).resolves.toEqual({ outcome: 'accepted', connectionGeneration: 4, connected: true })
  })

  for(const kind of ['sqlite','d1'] as const)it(`[security] ${kind} reset retains encrypted calendar revocation custody as manual-required`,async()=>{
    let cleanup:()=>Promise<void>,driver:DemoResetDriver
    let run:(sql:string,...params:unknown[])=>Promise<void>,rows:<T>(sql:string)=>Promise<T[]>
    if(kind==='sqlite'){
      const raw=new BetterSqlite3(':memory:');migrateContainer(raw)
      driver=createContainerDemoResetDriver(raw,createContainerDatabase(raw) as unknown as InvoiceGenerationDatabase,migrateContainer)
      run=async(sql,...params)=>{raw.prepare(sql).run(...params)};rows=async<T>(sql:string)=>raw.prepare(sql).all() as T[];cleanup=async()=>{raw.close()}
    }else{
      const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB']});const raw=await mf.getD1Database('DB');await migrateD1(raw);driver=createD1DemoResetDriver(raw)
      run=async(sql,...params)=>{await raw.prepare(sql).bind(...params).run()};rows=async<T>(sql:string)=>(await raw.prepare(sql).all<T>()).results;cleanup=()=>mf.dispose()
    }
    try{
      const before=(await rows<{nonce:string}>('SELECT nonce FROM calendar_sync_instance'))[0]!.nonce
      await run("INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(1,'Owned','Admin','administrator','[]',?,?)",now,now)
      const vault=await createCalendarGrantVault(new Uint8Array(32).fill(7)),sealed=await vault.sealGrant({refreshToken:'PRIVATE_RESET_REFRESH',scopes:['calendar.readonly']},{instance:before,userId:1,provider:'google',generation:1,credentialRevision:1})
      await run("INSERT INTO calendar_connections(user_id,provider,instance_nonce,generation,credential_revision,status,key_id,sealed_grant,updated_at) VALUES(1,'google',?,1,1,'connected',?,?,?)",before,vault.keyId,sealed,now)
      await expect(wipeAndSeedDemo({...driver,bootstrap:async()=>{throw new Error('owned interrupted rebuild')}},{now,years,confirm:'wipe-and-reload'})).rejects.toThrow('owned interrupted rebuild')
      expect((await rows<{nonce:string}>('SELECT nonce FROM calendar_sync_instance'))[0]!.nonce).not.toBe(before)
      expect(await rows('SELECT count(*) AS n FROM calendar_connections')).toEqual([{n:0}])
      expect(await rows('SELECT status,sealed_grant FROM calendar_cleanup_obligations')).toEqual([{status:'manual_required',sealed_grant:sealed}])
    }finally{await cleanup()}
  },60000)

  it('[security] invalidates pre-wipe authority even if rebuilding never starts', async () => {
    const { client, driver } = harness()
    migrateContainer(client)
    client.exec('UPDATE idempotency_authorization SET revision = 1000 WHERE id = 1')
    client.exec('UPDATE quickbooks_connection_generation SET generation=generation+1 WHERE singleton=1')

    await expect(wipeAndSeedDemo({
      ...driver,
      bootstrap: async () => { throw new Error('interrupted before bootstrap') },
    }, { now, years, confirm: 'wipe-and-reload' })).rejects.toThrow('interrupted before bootstrap')

    expect(client.prepare('SELECT revision FROM idempotency_authorization WHERE id = 1').get())
      .toEqual({ revision: 1001 })
    expect(client.prepare('SELECT generation FROM quickbooks_connection_generation WHERE singleton=1').get())
      .toEqual({ generation: 2 })
  })

  it('[security] advances the retained D1 QuickBooks fence before an interrupted rebuild', async () => {
    const runtime = new Miniflare({
      modules: true,
      script: 'export default {fetch(){return new Response("owned fixture")}}',
      d1Databases: ['DB'],
    })
    try {
      const binding = await runtime.getD1Database('DB')
      await migrateD1(binding)
      await binding
        .prepare(
          'UPDATE quickbooks_connection_generation SET generation=generation+1 WHERE singleton=1',
        )
        .run()
      const driver = createD1DemoResetDriver(binding)
      await expect(
        wipeAndSeedDemo(
          {
            ...driver,
            bootstrap: async () => {
              throw new Error('owned D1 interruption')
            },
          },
          { now, years, confirm: 'wipe-and-reload' },
        ),
      ).rejects.toThrow('owned D1 interruption')
      expect(
        await binding
          .prepare('SELECT generation FROM quickbooks_connection_generation WHERE singleton=1')
          .first(),
      ).toEqual({ generation: 2 })
      // The retained singleton remains protected after the atomic trigger lift.
      await expect(
        binding.prepare('DELETE FROM quickbooks_connection_generation').run(),
      ).rejects.toThrow()
    } finally {
      await runtime.dispose()
    }
  })

  it('[security] puts the triggers back when the wipe fails halfway through', async () => {
    // The wipe drops every trigger before it empties anything, so if the drops
    // commit and the rest does not, what is left is a live database with no
    // write guards on it -- and nothing says so. That is what happened to
    // ezacto.io: one refused DELETE, and three hundred triggers gone until
    // somebody thought to count them. One transaction is the whole defence.
    const { client, driver } = harness()
    migrateContainer(client)
    const triggers = () =>
      (client.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger'`).get() as {
        n: number
      }).n
    const before = triggers()
    // A table in the list that is not in the database. Any statement of the
    // wipe failing earns the same rollback; this is the cheapest one to stage.
    const failing: DemoResetDriver = {
      ...driver,
      schemaObjects: async () => {
        const objects = await driver.schemaObjects()
        return { ...objects, tables: [...objects.tables, 'table_that_is_not_there'] }
      },
    }

    await expect(
      wipeAndSeedDemo(failing, { now, years, confirm: 'wipe-and-reload' }),
    ).rejects.toThrow()

    expect(before).toBeGreaterThan(300)
    expect(triggers()).toBe(before)
  })

  it('[unit] leaves the bookkeeping table D1 keeps for itself alone', async () => {
    // The wipe reads its table list out of sqlite_master, and on D1 that list
    // includes `_cf_KV`, which D1's authorizer refuses every statement against.
    // A DELETE against it does not empty a table -- it fails the batch with
    // SQLITE_AUTH, and the demo stays wiped-but-unbuilt until someone notices.
    // Nothing creates `_cf_KV` here, so the test puts one there itself; the
    // surviving row is the proof no DELETE was ever aimed at it.
    const { client, driver } = harness()
    migrateContainer(client)
    client.exec('CREATE TABLE "_cf_KV" (key TEXT PRIMARY KEY, value BLOB)')
    client.prepare('INSERT INTO "_cf_KV" (key, value) VALUES (?, ?)').run('k', 'v')

    await wipeAndSeedDemo(driver, { now, years, confirm: 'wipe-and-reload' })

    expect(count(client, '_cf_KV')).toBe(1)
  })

  it('[unit] empties everything else and puts every trigger back', async () => {
    const { client, driver } = harness()
    const summary = await wipeAndSeedDemo(driver, { now, years, confirm: 'wipe-and-reload' })
    const triggersAfter = (
      client.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger'`).get() as {
        n: number
      }
    ).n

    expect(summary.restoredTriggers).toBeGreaterThan(300)
    expect(triggersAfter).toBe(summary.restoredTriggers)
    // Rebuilt, not reinstalled: the ledger still records every migration, so
    // the next request does not try to apply them over the tables they made.
    expect(count(client, '_ezacto_migrations')).toBeGreaterThan(0)
    expect(count(client, 'users')).toBe(21)
  })

  it('[security] leaves the write guards biting after the wipe put them back', async () => {
    // The wipe drops every trigger and recreates it from its own SQL. If that
    // round trip lost one, the demo would keep working and the product's
    // invariants would be gone -- which is the failure this test exists for.
    const { client, driver } = harness()
    await wipeAndSeedDemo(driver, { now, years, confirm: 'wipe-and-reload' })

    expect(() =>
      client
        .prepare(
          `INSERT INTO invoice_line_items
             (id, invoice_id, position, kind, description, quantity,
              unit_price_cents, amount_cents, created_at, updated_at)
           VALUES (1, 1, 0, 'Service', 'x', 1, 100, 100, ?, ?)`,
        )
        .run(now, now),
    ).toThrow()
  })

  it('[unit] starts the demo at invoice number one however many it issued before', async () => {
    // The counter is preserved through the wipe because generation needs a row
    // to read, and reset because every invoice below it has just been deleted.
    const { client, driver } = harness()
    migrateContainer(client)
    client.prepare('UPDATE invoice_number_sequence SET next_number = 5000').run()
    await wipeAndSeedDemo(driver, { now, years, confirm: 'wipe-and-reload' })

    expect(
      (client.prepare('SELECT next_number AS n FROM invoice_number_sequence').get() as {
        n: number
      }).n,
    ).toBe(1)
  })

  it('[reliability] rebuilds even after an operator saved a template on the demo', async () => {
    // A saved template version names the user who saved it, and the wipe
    // deletes every user. With foreign keys deferred, that surfaced only at
    // commit -- as a rolled-back rebuild every night from 2026-09-12 until
    // somebody read Sentry. The template is kept; its authorship is not.
    const { client, driver } = harness()
    migrateContainer(client)
    client
      .prepare(
        `INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
         VALUES (1, 'Casey', 'Ng', 'administrator', '[]', ?, ?)`,
      )
      .run(now, now)
    const next =
      (client
        .prepare(`SELECT max(version) + 1 AS n FROM email_template_versions WHERE template_kind = 'invoice'`)
        .get() as { n: number }).n
    client
      .prepare(
        `INSERT INTO email_template_versions
           (template_kind, version, subject_template, text_template, html_template, created_by_user_id, created_at)
         VALUES ('invoice', ?, 'Invoice %invoice_id%', 'body', NULL, 1, ?)`,
      )
      .run(next, now)
    await wipeAndSeedDemo(driver, { now, years, confirm: 'wipe-and-reload' })
    expect(
      client
        .prepare(`SELECT created_by_user_id AS by FROM email_template_versions WHERE template_kind = 'invoice' AND version = ?`)
        .get(next),
    ).toEqual({ by: null })
    expect(count(client, 'users')).toBeGreaterThan(0)
  })

  it('[unit] bills a bounded slice and resumes where the last one stopped', async () => {
    // The caller is a cron tick with a CPU budget, so a reset that can only run
    // to completion in one go is a reset that never completes.
    const { client, driver } = harness()
    await wipeAndSeedDemo(driver, { now, years, confirm: 'wipe-and-reload' })
    const tick = (limit: number) =>
      billDemoBacklog(driver, { now, years, confirm: 'wipe-and-reload', limit })

    const first = await tick(4)
    const afterFirst = count(client, 'invoices')
    const second = await tick(4)

    // Resumed, not restarted: the backlog shrinks by exactly what the tick took
    // on, because what is done is read off the invoices themselves rather than
    // counted in memory that a dead tick would have taken with it.
    expect(first.billed).toBe(4)
    expect(second.remaining).toBe(first.remaining - 4)
    expect(count(client, 'invoices')).toBe(afterFirst + 4)
  }, 120_000)

  it('[unit] issues no second invoice for a month it has already billed', async () => {
    const { client, driver } = harness()
    await wipeAndSeedDemo(driver, { now, years, confirm: 'wipe-and-reload' })
    await billDemoBacklog(driver, { now, years, confirm: 'wipe-and-reload' })
    const settled = count(client, 'invoices')

    const again = await billDemoBacklog(driver, { now, years, confirm: 'wipe-and-reload' })

    // The backlog is the uninvoiced work, so a completed demo has none left.
    expect(again).toMatchObject({ billed: 0, remaining: 0 })
    expect(count(client, 'invoices')).toBe(settled)
    const duplicates = client
      .prepare(
        `SELECT count(*) AS n FROM (
           SELECT client_id, period_start FROM invoices
           GROUP BY client_id, period_start HAVING count(*) > 1
         )`,
      )
      .get() as { n: number }
    expect(duplicates.n).toBe(0)
  }, 300_000)

  it('[unit] leaves recent invoices outstanding and settles the older ones', async () => {
    // An accounts-receivable screen where everything is paid shows nothing, and
    // the aging buckets are among the things a visitor came to look at.
    const { client, driver } = harness()
    await wipeAndSeedDemo(driver, { now, years, confirm: 'wipe-and-reload' })
    await billDemoBacklog(driver, { now, years, confirm: 'wipe-and-reload' })

    const states = client
      .prepare(`SELECT state, count(*) AS n FROM invoices GROUP BY state`)
      .all() as { state: string; n: number }[]
    const by = new Map(states.map((row) => [row.state, row.n]))

    expect(by.get('paid') ?? 0).toBeGreaterThan(0)
    expect(by.get('open') ?? 0).toBeGreaterThan(0)
    expect(by.get('draft') ?? 0).toBe(0)
  }, 300_000)

})
