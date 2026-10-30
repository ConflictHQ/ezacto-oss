import BetterSqlite3 from 'better-sqlite3'
import { sql } from 'drizzle-orm'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { createEstimateTemplateRepository } from '../src/estimate-templates.js'
const now = '2026-10-01T09:00:00.000Z'
const actor = { userId: 1, profile: 'accounting' as const }
const content = {
  subject: 'Monthly services',
  notes: 'Quote notes',
  currency: 'USD',
  tax_rate_ppm: 100000,
  tax2_rate_ppm: 50000,
  discount_rate_ppm: 100000,
  lines: [
    {
      kind: 'Service',
      description: 'Work',
      quantity: 2.5,
      unit_price_cents: 1001,
      taxed: true,
      taxed2: false,
    },
    {
      kind: 'Service',
      description: null,
      quantity: 1,
      unit_price_cents: 1000,
      taxed: false,
      taxed2: true,
    },
  ],
}
for (const runtime of ['SQLite', 'D1'])
  describe(`estimate templates (${runtime})`, () => {
    let close: (() => Promise<void>) | undefined
    afterEach(async () => close?.())
    const setup = async () => {
      let db: Parameters<typeof createEstimateTemplateRepository>[0]
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
        sql`INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(2,'Keep','Admin','administrator','[]',${now},${now}),(1,'Quote','Writer','accounting','[]',${now},${now})`,
      )
      await db.run(
        sql`INSERT INTO clients(id,name,currency,created_at,updated_at) VALUES(1,'First client','USD',${now},${now}),(2,'Other client','EUR',${now},${now})`,
      )
      return { db, repository: createEstimateTemplateRepository(db) }
    }
    it('copies fresh draft identities, exact discounted taxes and immutable audited content', async () => {
      const { db, repository } = await setup()
      const template = await repository.save(actor, { name: 'Monthly', content }, now)
      const input = {
        client_id: 2,
        number: 'Q-NEW',
        issue_date: '2026-10-01',
        content: template.content,
        template_id: template.id,
        template_version: 0,
      }
      const draft = await repository.createDraft(actor, input, 'create-1', now)
      expect(await repository.createDraft(actor, input, 'create-1', now)).toEqual(draft)
      const second = await repository.createDraft(
        actor,
        { ...input, client_id: 1, number: 'Q-OTHER' },
        'create-2',
        now,
      )
      const rows = await db.all<Record<string, unknown>>(sql`SELECT * FROM estimates ORDER BY id`)
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject({
        client_id: 2,
        state: 'draft',
        version: 0,
        number: 'Q-NEW',
        amount_cents: 3423,
        discount_amount_cents: 350,
        tax_amount_cents: 225,
        tax2_amount_cents: 45,
        sent_at: null,
        accepted_at: null,
        declined_at: null,
        harvest_id: null,
        source_creator_id: null,
      })
      expect(rows[0]!.client_key).not.toBe(rows[1]!.client_key)
      expect(second.id).not.toBe(draft.id)
      const updated = await repository.save(
        actor,
        {
          id: template.id,
          expected_version: 0,
          name: 'Renamed',
          content: { ...content, notes: 'Later changes' },
        },
        now,
      )
      expect(updated.version).toBe(1)
      expect(
        (await db.all<{ notes: string }>(sql`SELECT notes FROM estimates WHERE id=${draft.id}`))[0]!
          .notes,
      ).toBe('Quote notes')
      expect(
        await db.all(
          sql`SELECT version FROM estimate_template_versions WHERE template_id=${template.id} ORDER BY version`,
        ),
      ).toEqual([{ version: 0 }, { version: 1 }])
      await expect(
        Promise.resolve().then(async () => {
          await db.run(sql`DELETE FROM estimate_template_versions`)
        }),
      ).rejects.toThrow()
      await expect(
        repository.createDraft(actor, { ...input, number: 'Q-STALE' }, 'stale', now),
      ).rejects.toMatchObject({ code: 'estimate_template_conflict' })
      await expect(
        repository.createDraft(actor, { ...input, number: 'Q-DIFFERENT' }, 'create-1', now),
      ).rejects.toMatchObject({ code: 'estimate_draft_conflict' })
      expect((await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM invoices`))[0]!.n).toBe(0)
      expect(
        (await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM estimate_messages`))[0]!.n,
      ).toBe(0)
    })
    it('atomically deduplicates concurrent retries and rolls back a number collision', async () => {
      const { db, repository } = await setup()
      const input = {
        client_id: 1,
        number: 'CONCURRENT',
        issue_date: '2026-10-01',
        content,
        template_id: null,
        template_version: null,
      }
      const results = await Promise.all([
        repository.createDraft(actor, input, 'same-key', now),
        repository.createDraft(actor, input, 'same-key', now),
      ])
      expect(results[0]).toEqual(results[1])
      await expect(
        repository.createDraft(actor, input, 'different-key', now),
      ).rejects.toMatchObject({ code: 'estimate_draft_conflict' })
      expect(await db.all(sql`SELECT count(*) AS n FROM estimate_draft_commands`)).toEqual([
        { n: 1 },
      ])
      expect(await db.all(sql`SELECT count(*) AS n FROM estimates`)).toEqual([{ n: 1 }])
      expect(await db.all(sql`SELECT count(*) AS n FROM estimate_line_items`)).toEqual([{ n: 2 }])
    })
    it('rejects private fields, unauthorized writes, stale edits and archived templates', async () => {
      const { db, repository } = await setup()
      await expect(
        repository.save({ ...actor, profile: 'member' }, { name: 'Bad', content }, now),
      ).rejects.toThrow()
      for (const field of [
        'client_id',
        'number',
        'client_key',
        'recipients',
        'state',
        'invoice_id',
      ])
        await expect(
          repository.save(
            actor,
            { name: 'Unsafe', content: { ...content, [field]: 'private' } },
            now,
          ),
        ).rejects.toMatchObject({ code: 'invalid_estimate_content' })
      const template = await repository.save(actor, { name: 'One', content }, now)
      await repository.save(
        actor,
        { id: template.id, expected_version: 0, name: 'One', content, archived: true },
        now,
      )
      await expect(
        repository.save(
          actor,
          { id: template.id, expected_version: 0, name: 'Lost update', content },
          now,
        ),
      ).rejects.toMatchObject({ code: 'estimate_template_conflict' })
      await expect(
        repository.createDraft(
          actor,
          {
            client_id: 1,
            number: 'NEVER',
            issue_date: '2026-10-01',
            content,
            template_id: template.id,
            template_version: 1,
          },
          'archived',
          now,
        ),
      ).rejects.toMatchObject({ code: 'estimate_template_conflict' })
      await db.run(sql`UPDATE users SET profile='member' WHERE id=1`)
      await expect(
        repository.save(actor, { name: 'Forged profile', content }, now),
      ).rejects.toThrow()
      expect((await repository.list())[0]!.archived).toBe(true)
    })
  })
