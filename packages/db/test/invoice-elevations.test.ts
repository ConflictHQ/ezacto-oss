import { unlinkElevatedInvoiceTime } from '../src/invoice-elevated-time.js'
import { executeInvoiceEdit } from '../src/invoice-state.js'
import BetterSqlite3 from 'better-sqlite3'
import { sql } from 'drizzle-orm'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { createInvoiceElevationStore } from '../src/invoice-elevations.js'
const now = '2026-10-01T09:00:00.000Z',
  later = '2026-10-01T09:01:00.000Z',
  expired = '2026-10-01T09:15:00.000Z'
const binding = { userId: 1, tokenId: 1, invoiceId: 1, credentialVersion: 1 },
  actor = { userId: 1, tokenId: 1 }
for (const runtime of ['SQLite', 'D1'])
  describe(`invoice elevation authority (${runtime})`, () => {
    let close: (() => Promise<void>) | undefined
    afterEach(async () => close?.())
    const setup = async () => {
      let db: Parameters<typeof createInvoiceElevationStore>[0]
      if (runtime === 'SQLite') {
        const sqlite = new BetterSqlite3(':memory:')
        migrateContainer(sqlite)
        db = createContainerDatabase(sqlite)
        close = async () => {
          sqlite.close()
        }
      } else {
        const mf = new Miniflare({
          modules: true,
          script: 'export default {fetch(){return new Response("ok")}}',
          d1Databases: ['DB'],
        })
        const d1 = await mf.getD1Database('DB')
        await migrateD1(d1)
        db = createD1Database(d1)
        close = async () => mf.dispose()
      }
      await db.run(
        sql`INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(3,'Keep','Owner','administrator','[]',${now},${now}),(1,'Invoice','Admin','administrator','[]',${now},${now}),(2,'Other','Admin','administrator','[]',${now},${now})`,
      )
      await db.run(
        sql`INSERT INTO user_passwords(user_id,credential_version,algorithm,iterations,salt,password_hash,created_at,updated_at) VALUES(1,1,'pbkdf2-sha256',600000,${'A'.repeat(22)},${'A'.repeat(43)},${now},${now})`,
      )
      await db.run(
        sql`INSERT INTO api_tokens(id,user_id,selector,secret_hash,name,scopes,created_at,updated_at) VALUES(1,1,'aaaaaaaaaaaaaaaa',${'1'.repeat(64)},'First','["invoices:read","invoices:write","time_entries:write"]',${now},${now}),(2,1,'bbbbbbbbbbbbbbbb',${'2'.repeat(64)},'Second','["invoices:read","invoices:write","time_entries:write"]',${now},${now})`,
      )
      await db.run(
        sql`INSERT INTO clients(id,name,currency,created_at,updated_at) VALUES(1,'Quote client','USD',${now},${now})`,
      )
      await db.run(
        sql`INSERT INTO invoices(id,client_id,number,currency,issue_date,due_date,state,created_at,updated_at) VALUES(1,1,'DRAFT-1','USD','2026-10-01','2026-10-31','draft',${now},${now}),(2,1,'DRAFT-2','USD','2026-10-01','2026-10-31','draft',${now},${now})`,
      )
      return { db, store: createInvoiceElevationStore(db) }
    }
    it('binds the hashed capability to one user, base token, invoice and fifteen-minute window', async () => {
      const { db, store } = await setup(),
        issued = await store.mint(binding, now)
      expect(issued.elevation.expiresAt).toBe(expired)
      expect(await store.verify(issued.credential, actor, 1, later)).toEqual(issued.elevation)
      expect(await store.verify(issued.credential, { ...actor, tokenId: 2 }, 1, later)).toBeNull()
      expect(await store.verify(issued.credential, { ...actor, userId: 2 }, 1, later)).toBeNull()
      expect(await store.verify(issued.credential, actor, 2, later)).toBeNull()
      expect(await store.verify(issued.credential, actor, 1, expired)).toBeNull()
      const rows = await db.all<Record<string, unknown>>(sql`SELECT * FROM invoice_elevations`)
      expect(JSON.stringify(rows)).not.toContain(issued.credential)
      await store.revoke(issued.elevation.id, actor, later)
      expect(await store.verify(issued.credential, actor, 1, later)).toBeNull()
    })
    it('requires a new factor proof when MFA is enabled after password-only elevation', async () => {
      const { db, store } = await setup(),
        issued = await store.mint(binding, now)
      await db.run(
        sql`INSERT INTO user_email_second_factors(user_id,enabled_at) VALUES(1,${later})`,
      )
      expect(await store.verify(issued.credential, actor, 1, later)).toBeNull()
      await expect(store.mint(binding, later)).rejects.toMatchObject({
        code: 'invoice_elevation_unavailable',
      })
      const challenge = 'E'.repeat(43)
      await store.createRequest(binding, challenge, expired, later)
      const verified = await store.mint(binding, later, challenge)
      expect(await store.verify(verified.credential, actor, 1, later)).toEqual(verified.elevation)
    })
    it('consumes a bound MFA request once and refuses mismatched or stale promotion', async () => {
      const { store } = await setup(),
        challenge = 'C'.repeat(43)
      await store.createRequest(binding, challenge, expired, now)
      expect(await store.pending(challenge, actor, later)).toMatchObject(binding)
      expect(await store.pending(challenge, { ...actor, tokenId: 2 }, later)).toBeNull()
      await expect(
        store.mint({ ...binding, invoiceId: 2 }, later, challenge),
      ).rejects.toMatchObject({ code: 'invoice_elevation_unavailable' })
      expect(await store.pending(challenge, actor, later)).toMatchObject(binding)
      const issued = await store.mint(binding, later, challenge)
      expect(await store.pending(challenge, actor, later)).toBeNull()
      await expect(store.mint(binding, later, challenge)).rejects.toMatchObject({
        code: 'invoice_elevation_unavailable',
      })
      expect(await store.verify(issued.credential, actor, 1, later)).toEqual(issued.elevation)
    })
    it('invalidates authority after password change or base-token revocation', async () => {
      const { db, store } = await setup(),
        issued = await store.mint(binding, now)
      await db.run(sql`UPDATE user_passwords SET credential_version=2 WHERE user_id=1`)
      expect(await store.verify(issued.credential, actor, 1, later)).toBeNull()
      await expect(store.mint(binding, later)).rejects.toMatchObject({
        code: 'invoice_elevation_unavailable',
      })
      const refreshed = await store.mint({ ...binding, credentialVersion: 2 }, later)
      await db.run(sql`UPDATE api_tokens SET revoked_at=${later},updated_at=${later} WHERE id=1`)
      expect(await store.verify(refreshed.credential, actor, 1, later)).toBeNull()
    })
    it('atomically unlinks only the named draft selection and preserves immutable before/after audit', async () => {
      const { db, store } = await setup(),
        issued = await store.mint(binding, now)
      await db.run(
        sql`INSERT INTO projects(id,client_id,name,billing_method,created_at,updated_at) VALUES(1,1,'Work','time_materials',${now},${now})`,
      )
      await db.run(
        sql`INSERT INTO tasks(id,name,created_at,updated_at) VALUES(1,'Advisory',${now},${now})`,
      )
      await db.run(
        sql`INSERT INTO user_assignments(id,project_id,user_id,created_at,updated_at) VALUES(1,1,1,${now},${now})`,
      )
      await db.run(
        sql`INSERT INTO task_assignments(id,project_id,task_id,billable,created_at,updated_at) VALUES(1,1,1,1,${now},${now})`,
      )
      await db.run(sql`INSERT INTO time_entries(id,user_id,project_id,task_id,user_assignment_id,task_assignment_id,spent_date,seconds,seconds_without_timer,rounded_seconds,billable,invoice_id,created_at,updated_at)
        VALUES(1,1,1,1,1,1,'2026-10-01',600,600,600,1,1,${now},${now}),
        (2,1,1,1,1,1,'2026-10-01',900,900,900,1,1,${now},${now}),
        (3,1,1,1,1,1,'2026-10-01',300,300,300,1,2,${now},${now})`)
      const command = {
        invoiceId: 1,
        commandId: 'selected-time',
        expectedVersion: 0,
        entryIds: [1, 3],
      }
      await expect(
        unlinkElevatedInvoiceTime(db, command, issued.elevation, later),
      ).rejects.toMatchObject({ code: 'invoice_time_conflict' })
      expect(await db.all(sql`SELECT id,invoice_id FROM time_entries ORDER BY id`)).toEqual([
        { id: 1, invoice_id: 1 },
        { id: 2, invoice_id: 1 },
        { id: 3, invoice_id: 2 },
      ])
      expect(await db.all(sql`SELECT count(*) AS n FROM invoice_elevated_time_commands`)).toEqual([
        { n: 0 },
      ])
      const selection = { ...command, entryIds: [2, 1] }
      const result = await unlinkElevatedInvoiceTime(db, selection, issued.elevation, later)
      expect(result.releasedEntryIds).toEqual([1, 2])
      expect(await unlinkElevatedInvoiceTime(db, selection, issued.elevation, later)).toEqual({
        ...result,
        replayed: true,
      })
      expect(await db.all(sql`SELECT id,invoice_id FROM time_entries ORDER BY id`)).toEqual([
        { id: 1, invoice_id: null },
        { id: 2, invoice_id: null },
        { id: 3, invoice_id: 2 },
      ])
      const audit = (
        await db.all<{ before_json: string; after_json: string }>(
          sql`SELECT before_json,after_json FROM invoice_elevated_time_commands`,
        )
      )[0]!
      expect(
        JSON.parse(audit.before_json).map((entry: { invoice_id: number }) => entry.invoice_id),
      ).toEqual([1, 1])
      expect(
        JSON.parse(audit.after_json).map((entry: { invoice_id: null }) => entry.invoice_id),
      ).toEqual([null, null])
      await expect(
        Promise.resolve().then(async () => {
          await db.run(sql`DELETE FROM invoice_elevated_time_commands`)
        }),
      ).rejects.toThrow()
      await expect(
        unlinkElevatedInvoiceTime(db, { ...command, entryIds: [3] }, issued.elevation, later),
      ).rejects.toMatchObject({ code: 'invoice_time_conflict' })
    })
    it('keeps capability and command provenance immutable and checks the current administrator', async () => {
      const { db, store } = await setup(),
        issued = await store.mint(binding, now)
      const denied = (action: () => unknown) =>
        expect(
          Promise.resolve().then(async () => {
            await action()
          }),
        ).rejects.toThrow()
      await denied(() =>
        db.run(sql`UPDATE invoice_elevations SET expires_at='2026-10-01T10:00:00.000Z'`),
      )
      await denied(() => db.run(sql`DELETE FROM invoice_elevations`))
      await executeInvoiceEdit(db, {
        invoiceId: 1,
        commandId: 'elevated-audit',
        actor: { type: 'user', id: 1 },
        expectedVersion: 0,
        occurredAt: now,
        eventIds: [crypto.randomUUID(), crypto.randomUUID()],
        authorize: () => true,
        elevation: { id: issued.elevation.id, tokenId: 1 },
        edit: { type: 'header', subject: 'Reviewed correction', notes: 'Payment notes' },
      })
      const row = (
        await db.all<{
          elevation_id: string
          elevation_before_json: string
          elevation_after_json: string
        }>(
          sql`SELECT elevation_id,elevation_before_json,elevation_after_json FROM invoice_command_ledger WHERE command_id='elevated-audit'`,
        )
      )[0]!
      expect(row.elevation_id).toBe(issued.elevation.id)
      expect(JSON.parse(row.elevation_before_json).header).toMatchObject({
        subject: null,
        notes: null,
        version: 0,
      })
      expect(JSON.parse(row.elevation_after_json).header).toMatchObject({
        subject: 'Reviewed correction',
        notes: 'Payment notes',
        version: 1,
      })
      expect(row.elevation_after_json).not.toContain('client_key')
      await denied(() =>
        db.run(
          sql`UPDATE invoice_command_ledger SET elevation_id=NULL,elevation_token_id=NULL WHERE command_id='elevated-audit'`,
        ),
      )
      await db.run(sql`UPDATE users SET is_owner=0,profile='accounting' WHERE id=1`)
      expect(await store.verify(issued.credential, actor, 1, later)).toBeNull()
      await expect(store.mint(binding, later)).rejects.toMatchObject({
        code: 'invoice_elevation_unavailable',
      })
    })
  })
