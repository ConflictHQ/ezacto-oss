import { IdempotencyClaimConflict } from '@ezacto/core'
import BetterSqlite3 from 'better-sqlite3'
import { drizzle as drizzleBetterSqlite } from 'drizzle-orm/better-sqlite3'
import { drizzle as drizzleD1 } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createContainerIdempotencyStore,
  createD1IdempotencyStore,
  createIdempotentD1,
  createIdempotentSqlite,
  isReadOnlySql,
  outsideClaim,
  runWithClaim,
  type IdempotencyClaim,
  type IdempotencyStore,
} from '../src/idempotency.js'
import { idempotencyKeysMigration } from '../src/migrations/0107_idempotency_keys.js'

const notes = sqliteTable('notes', {
  id: integer('id').primaryKey(),
  body: text('body').notNull(),
})

const createdAt = '2026-10-07T12:00:00.000Z'
const expiresAt = '2026-10-08T12:00:00.000Z'
const keyId = 'a'.repeat(64)

const claimFor = (attempt: string, overrides: Partial<IdempotencyClaim> = {}): IdempotencyClaim => ({
  id: keyId,
  fingerprint: 'f'.repeat(64),
  secretVersion: 'd'.repeat(64),
  holder: 'e'.repeat(64),
  attempt,
  createdAt,
  expiresAt,
  ...overrides,
})

/**
 * One runtime's database, three ways in: the riding handle the services write
 * through, the bare handle the test inspects with, and the store.
 */
interface Harness {
  /** A single statement through the riding handle. */
  write(sql: string, ...params: unknown[]): Promise<void>
  read<T>(sql: string, ...params: unknown[]): Promise<T[]>
  /** Several statements as one unit: a D1 batch, or a container transaction. */
  writeTogether(statements: readonly (readonly [string, ...unknown[]])[]): Promise<void>
  /** Inspection through the bare handle, never through the rider. */
  rows<T>(sql: string, ...params: unknown[]): Promise<T[]>
  /**
   * Typed as the D1 driver's: both expose the same query builder, and the
   * container's synchronous results are awaited just the same.
   */
  drizzle(): ReturnType<typeof drizzleD1>
  exec(sql: string): Promise<void>
  store: IdempotencyStore
  close(): Promise<void>
}

const schema = [...idempotencyKeysMigration, 'CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL) STRICT']

const d1Harness = async (): Promise<Harness> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const binding = await miniflare.getD1Database('DB')
  for (const statement of schema) await binding.prepare(statement).run()
  const riding = createIdempotentD1(binding)
  return {
    write: async (sql, ...params) => {
      await riding
        .prepare(sql)
        .bind(...params)
        .run()
    },
    read: async <T>(sql: string, ...params: unknown[]) =>
      (
        await riding
          .prepare(sql)
          .bind(...params)
          .all<T>()
      ).results,
    writeTogether: async (statements) => {
      await riding.batch(statements.map(([sql, ...params]) => riding.prepare(sql).bind(...params)))
    },
    rows: async <T>(sql: string, ...params: unknown[]) =>
      (
        await binding
          .prepare(sql)
          .bind(...params)
          .all<T>()
      ).results,
    drizzle: () => drizzleD1(riding),
    exec: async (sql) => {
      await riding.exec(sql)
    },
    store: createD1IdempotencyStore(binding),
    close: async () => miniflare.dispose(),
  }
}

const sqliteHarness = async (): Promise<Harness> => {
  const handle = new BetterSqlite3(':memory:')
  for (const statement of schema) handle.exec(statement)
  const riding = createIdempotentSqlite(handle)
  return {
    write: async (sql, ...params) => {
      riding.prepare(sql).run(...params)
    },
    read: async <T>(sql: string, ...params: unknown[]) => riding.prepare(sql).all(...params) as T[],
    writeTogether: async (statements) => {
      riding.transaction(() => {
        for (const [sql, ...params] of statements) riding.prepare(sql).run(...params)
      })()
    },
    rows: async <T>(sql: string, ...params: unknown[]) => handle.prepare(sql).all(...params) as T[],
    drizzle: () => drizzleBetterSqlite(riding) as unknown as ReturnType<typeof drizzleD1>,
    exec: async (sql) => {
      riding.exec(sql)
    },
    store: createContainerIdempotencyStore(handle),
    close: async () => {
      handle.close()
    },
  }
}

const runtimes = [
  ['D1', d1Harness],
  ['container', sqliteHarness],
] as const

describe('isReadOnlySql', () => {
  it('[unit] reads only plain reads as reads', () => {
    expect(isReadOnlySql('SELECT 1')).toBe(true)
    expect(isReadOnlySql('  -- leading comment\n /* block */ select * from notes')).toBe(true)
    expect(isReadOnlySql('VALUES (1)')).toBe(true)
    expect(isReadOnlySql('EXPLAIN QUERY PLAN SELECT 1')).toBe(true)
    expect(isReadOnlySql('WITH t AS (SELECT 1) SELECT * FROM t')).toBe(true)
  })

  it('[security] treats every statement that could write as a write', () => {
    expect(isReadOnlySql('INSERT INTO notes VALUES (1, ?)')).toBe(false)
    expect(isReadOnlySql('update notes set body = ?')).toBe(false)
    expect(isReadOnlySql('DELETE FROM notes')).toBe(false)
    expect(isReadOnlySql('REPLACE INTO notes VALUES (1, ?)')).toBe(false)
    expect(isReadOnlySql('WITH t AS (SELECT 1) INSERT INTO notes SELECT 1, ? FROM t')).toBe(false)
    expect(isReadOnlySql('PRAGMA user_version = 3')).toBe(false)
    expect(isReadOnlySql('/* SELECT */ DELETE FROM notes')).toBe(false)
  })
})

for (const [runtime, harness] of runtimes) {
  describe(`idempotency claim rider (${runtime})`, () => {
    let database: Harness | undefined
    const open = async (): Promise<Harness> => {
      database = await harness()
      return database
    }

    afterEach(async () => {
      await database?.close()
      database = undefined
    })

    const keyRows = (db: Harness) =>
      db.rows<{ attempt: string; state: string }>(
        'SELECT attempt, state FROM idempotency_keys WHERE id = ?',
        keyId,
      )

    it('[unit] outside a claim scope, a write passes through and claims nothing', async () => {
      const db = await open()
      await db.write('INSERT INTO notes (id, body) VALUES (?, ?)', 1, 'plain')
      expect(await db.rows('SELECT id, body FROM notes')).toEqual([{ id: 1, body: 'plain' }])
      expect(await db.rows('SELECT id FROM idempotency_keys')).toEqual([])
    })

    it('[security] a write in a claim scope commits together with the claim', async () => {
      const db = await open()
      const execution = await runWithClaim(claimFor('first'), () =>
        db.write('INSERT INTO notes (id, body) VALUES (?, ?)', 1, 'keyed'),
      )
      expect(execution).toMatchObject({ ok: true, wrote: true, lost: false })
      expect(await db.rows('SELECT id, body FROM notes')).toEqual([{ id: 1, body: 'keyed' }])
      expect(await keyRows(db)).toEqual([{ attempt: 'first', state: 'claimed' }])
    })

    it('[security] settles an already-started database write before recording the outcome', async () => {
      const db = await open()
      let pending: Promise<void> = Promise.resolve()
      const execution = await runWithClaim(claimFor('first'), async () => {
        pending = db.write('INSERT INTO notes VALUES (?, ?)', 1, 'in flight')
        return 'response'
      })
      await pending
      expect(execution).toMatchObject({ ok: true, value: 'response', wrote: true, lost: false })
      expect(await keyRows(db)).toEqual([{ attempt: 'first', state: 'claimed' }])
    })

    it('[unit] a read in a claim scope claims nothing', async () => {
      const db = await open()
      await db.write('INSERT INTO notes (id, body) VALUES (?, ?)', 1, 'existing')
      const execution = await runWithClaim(claimFor('reader'), () =>
        db.read<{ body: string }>('SELECT body FROM notes WHERE id = ?', 1),
      )
      expect(execution).toMatchObject({ ok: true, value: [{ body: 'existing' }], wrote: false, lost: false })
      expect(await keyRows(db)).toEqual([])
    })

    it('[unit] the same attempt writes again and again under one claim', async () => {
      const db = await open()
      const execution = await runWithClaim(claimFor('first'), async () => {
        await db.write('INSERT INTO notes (id, body) VALUES (?, ?)', 1, 'one')
        await db.write('UPDATE notes SET body = ? WHERE id = ?', 'two', 1)
        await db.writeTogether([
          ['INSERT INTO notes (id, body) VALUES (?, ?)', 2, 'three'],
          ['SELECT count(*) FROM notes'],
        ])
      })
      expect(execution).toMatchObject({ ok: true, wrote: true, lost: false })
      expect(await db.rows('SELECT id, body FROM notes ORDER BY id')).toEqual([
        { id: 1, body: 'two' },
        { id: 2, body: 'three' },
      ])
      expect(await keyRows(db)).toEqual([{ attempt: 'first', state: 'claimed' }])
    })

    it('[security] another attempt cannot commit a write once the key is claimed', async () => {
      const db = await open()
      await runWithClaim(claimFor('first'), () =>
        db.write('INSERT INTO notes (id, body) VALUES (?, ?)', 1, 'first'),
      )

      const lone = await runWithClaim(claimFor('second'), () =>
        db.write('INSERT INTO notes (id, body) VALUES (?, ?)', 2, 'second'),
      )
      if (!lone.ok) expect(lone.error).toBeInstanceOf(IdempotencyClaimConflict)
      expect(lone).toMatchObject({ ok: false, wrote: false, lost: true })

      const together = await runWithClaim(claimFor('third'), () =>
        db.writeTogether([
          ['UPDATE notes SET body = ? WHERE id = ?', 'overwritten', 1],
          ['INSERT INTO notes (id, body) VALUES (?, ?)', 3, 'third'],
        ]),
      )
      expect(together).toMatchObject({ ok: false, wrote: false, lost: true })
      if (!together.ok) expect(together.error).toBeInstanceOf(IdempotencyClaimConflict)

      // Nothing of either losing attempt landed, not even the statements that
      // came before the claim in the same unit.
      expect(await db.rows('SELECT id, body FROM notes ORDER BY id')).toEqual([{ id: 1, body: 'first' }])
      expect(await keyRows(db)).toEqual([{ attempt: 'first', state: 'claimed' }])
    })

    it('[security] does not classify a business constraint as claim contention even with another owner', async () => {
      const db = await open()
      await runWithClaim(claimFor('winner'), () => db.write('INSERT INTO notes (id, body) VALUES (?, ?)', 1, 'kept'))
      const failed = await runWithClaim(claimFor('loser'), () => db.write('INSERT INTO notes (id, body) VALUES (?, ?)', 1, 'duplicate'))
      expect(failed.ok).toBe(false)
      if (!failed.ok) {
        expect(failed.error).not.toBeInstanceOf(IdempotencyClaimConflict)
        expect((failed.error as Error).message).toContain('notes.id')
      }
      expect(await db.rows('SELECT body FROM notes')).toEqual([{ body: 'kept' }])
    })

    it('[unit] a unit of reads claims nothing', async () => {
      const db = await open()
      const execution = await runWithClaim(claimFor('reader'), () =>
        db.writeTogether([['SELECT count(*) FROM notes'], ['SELECT 1']]),
      )
      expect(execution).toMatchObject({ ok: true, wrote: false })
      expect(await keyRows(db)).toEqual([])
    })

    it('[unit] drizzle reads back the same rows through the rider as without it', async () => {
      const db = await open()
      const orm = db.drizzle()
      const operations = async (base: number) => {
        const inserted = await orm.insert(notes).values({ id: base, body: 'inserted' }).returning().get()
        const many = await orm
          .insert(notes)
          .values([
            { id: base + 1, body: 'many-1' },
            { id: base + 2, body: 'many-2' },
          ])
          .returning({ id: notes.id })
          .all()
        const updated = await orm
          .update(notes)
          .set({ body: 'updated' })
          .where(eq(notes.id, base))
          .returning({ body: notes.body })
          .get()
        const deleted = await orm.delete(notes).where(eq(notes.id, base + 2)).returning().all()
        const plain = await orm.update(notes).set({ body: 'plain' }).where(eq(notes.id, base + 1)).run()
        return {
          inserted: { ...inserted, id: inserted.id - base },
          many: many.map(({ id }) => id - base),
          updated,
          deleted: deleted.map((row) => ({ ...row, id: row.id - base })),
          changed: 'changes' in plain ? plain.changes : plain.meta.changes,
        }
      }

      const bare = await operations(100)
      const execution = await runWithClaim(claimFor('orm'), () => operations(200))
      expect(execution).toMatchObject({ ok: true, wrote: true, lost: false })
      expect(execution.ok && execution.value).toEqual(bare)
      expect(bare).toEqual({
        inserted: { id: 0, body: 'inserted' },
        many: [1, 2],
        updated: { body: 'updated' },
        deleted: [{ id: 2, body: 'many-2' }],
        changed: 1,
      })
    })

    it('[security] a completed request cannot silently write outside its claim', async () => {
      const db = await open()
      let release: () => void = () => undefined
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let background: Promise<void> = Promise.resolve()
      await runWithClaim(claimFor('first'), async () => {
        background = gate.then(() => db.write('INSERT INTO notes (id, body) VALUES (?, ?)', 9, 'later'))
      })
      // Another attempt holds the key by the time the background work writes.
      await runWithClaim(claimFor('second'), () =>
        db.write('INSERT INTO notes (id, body) VALUES (?, ?)', 1, 'second'),
      )
      const refused = expect(background).rejects.toThrow('idempotency claim has closed')
      release()
      await refused
      expect(await db.rows('SELECT id FROM notes ORDER BY id')).toEqual([{ id: 1 }])
      expect(await keyRows(db)).toEqual([{ attempt: 'second', state: 'claimed' }])
    })

    it('[api] explicitly detached queue work keeps its independent write scope', async () => {
      const db = await open()
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      let background: Promise<void> = Promise.resolve()
      await runWithClaim(claimFor('request'), async () => {
        background = outsideClaim(() => gate.then(() => db.write('INSERT INTO notes VALUES (?, ?)', 9, 'queue')))
      })
      await runWithClaim(claimFor('retry'), () => db.write('INSERT INTO notes VALUES (?, ?)', 1, 'request'))
      release()
      await background
      expect(await db.rows('SELECT id FROM notes ORDER BY id')).toEqual([{ id: 1 }, { id: 9 }])
      expect(await keyRows(db)).toEqual([{ attempt: 'retry', state: 'claimed' }])
    })

    it('[security] what authentication writes outside the claim does not claim the key', async () => {
      const db = await open()
      const touchOnly = await runWithClaim(claimFor('refused'), () =>
        outsideClaim(() => db.write('INSERT INTO notes (id, body) VALUES (?, ?)', 1, 'last seen')),
      )
      expect(touchOnly).toMatchObject({ ok: true, wrote: false })
      expect(await keyRows(db)).toEqual([])

      // Another attempt holds the key: authentication's write still lands, and
      // the request's own write does not.
      await runWithClaim(claimFor('first'), () =>
        db.write('INSERT INTO notes (id, body) VALUES (?, ?)', 2, 'first'),
      )
      const second = await runWithClaim(claimFor('second'), async () => {
        await outsideClaim(() => db.write('UPDATE notes SET body = ? WHERE id = ?', 'seen again', 1))
        await db.write('INSERT INTO notes (id, body) VALUES (?, ?)', 3, 'second')
      })
      expect(second).toMatchObject({ ok: false, wrote: false, lost: true })
      expect(await db.rows('SELECT id, body FROM notes ORDER BY id')).toEqual([
        { id: 1, body: 'seen again' },
        { id: 2, body: 'first' },
      ])
    })

    it('[security] refuses exec inside a claim scope, where it could not carry the claim', async () => {
      const db = await open()
      const execution = await runWithClaim(claimFor('first'), () =>
        db.exec("INSERT INTO notes (id, body) VALUES (1, 'exec')"),
      )
      expect(execution).toMatchObject({ ok: false, wrote: false })
      expect(String((execution as { error: unknown }).error)).toMatch(/cannot carry an idempotency claim/)
      expect(await db.rows('SELECT id FROM notes')).toEqual([])
      await db.exec("INSERT INTO notes (id, body) VALUES (2, 'outside')")
      expect(await db.rows('SELECT id FROM notes')).toEqual([{ id: 2 }])
    })
  })

  describe(`idempotency store (${runtime})`, () => {
    let database: Harness | undefined
    afterEach(async () => {
      await database?.close()
      database = undefined
    })

    /** A row as a keyed request leaves it: claimed by its first write. */
    const claimWith = async (db: Harness, claim: IdempotencyClaim, note: number): Promise<void> => {
      const execution = await runWithClaim(claim, () =>
        db.write('INSERT INTO notes (id, body) VALUES (?, ?)', note, claim.attempt),
      )
      expect(execution).toMatchObject({ ok: true, wrote: true })
    }

    it('[unit] reads back a completed row whole', async () => {
      database = await harness()
      const db = database
      expect(await db.store.read(keyId)).toBeNull()
      await claimWith(db, claimFor('first'), 1)
      expect(await db.store.read(keyId)).toMatchObject({ state: 'claimed', nonce: null, sealed: null })
      expect(await db.store.complete(claimFor('first'), { nonce: 'bm9uY2U=', sealed: 'c2VhbGVk' }, createdAt)).toBe(
        true,
      )
      expect(await db.store.read(keyId)).toEqual({
        id: keyId,
        fingerprint: 'f'.repeat(64),
        secretVersion: 'd'.repeat(64),
        holder: 'e'.repeat(64),
        attempt: 'first',
        state: 'done',
        nonce: 'bm9uY2U=',
        sealed: 'c2VhbGVk',
        createdAt,
        expiresAt,
      })
    })

    it('[security] completes only the claim this attempt made', async () => {
      database = await harness()
      const db = database
      await runWithClaim(claimFor('first'), () =>
        db.write('INSERT INTO notes (id, body) VALUES (?, ?)', 1, 'first'),
      )
      expect(await db.store.complete(claimFor('second'), null, createdAt)).toBe(false)
      expect(await db.store.complete(claimFor('first'), { nonce: 'bg==', sealed: 'cw==' }, createdAt)).toBe(
        true,
      )
      expect(await db.store.complete(claimFor('first'), null, createdAt)).toBe(false)
      expect(await db.store.read(keyId)).toMatchObject({ attempt: 'first', state: 'done', sealed: 'cw==' })
    })

    it('[unit] forgets an expired row so its key can be claimed afresh, and nothing younger', async () => {
      database = await harness()
      const db = database
      await claimWith(db, claimFor('old'), 1)
      await db.store.forget(keyId, '2026-10-08T11:59:59.999Z')
      expect(await db.store.read(keyId)).not.toBeNull()
      await db.store.forget(keyId, expiresAt)
      expect(await db.store.read(keyId)).toBeNull()
      // And the key is free: a new attempt claims it.
      await claimWith(db, claimFor('new', { createdAt: expiresAt, expiresAt: '2026-10-09T12:00:00.000Z' }), 2)
      expect(await db.store.read(keyId)).toMatchObject({ attempt: 'new' })
    })

    it('[unit] purges expired rows as it completes new ones', async () => {
      database = await harness()
      const db = database
      await claimWith(db, claimFor('stale', { id: 'b'.repeat(64) }), 1)
      const fresh = claimFor('fresh', {
        id: 'c'.repeat(64),
        createdAt: '2026-10-09T00:00:00.000Z',
        expiresAt: '2026-10-10T00:00:00.000Z',
      })
      await claimWith(db, fresh, 2)
      expect(await db.store.complete(fresh, null, '2026-10-09T00:00:00.000Z')).toBe(true)
      expect(await db.rows('SELECT attempt FROM idempotency_keys')).toEqual([{ attempt: 'fresh' }])
    })
  })
}

describe('idempotency claim rider (container transactions)', () => {
  const setup = () => {
    const handle = new BetterSqlite3(':memory:')
    for (const statement of schema) handle.exec(statement)
    return { handle, riding: createIdempotentSqlite(handle) }
  }

  it('[security] a rolled-back transaction leaves no claim behind', async () => {
    const { handle, riding } = setup()
    const execution = await runWithClaim(claimFor('first'), async () =>
      riding.transaction(() => {
        riding.prepare('INSERT INTO notes (id, body) VALUES (?, ?)').run(1, 'doomed')
        throw new Error('the business rule said no')
      })(),
    )
    expect(execution).toMatchObject({ ok: false, wrote: false, lost: false })
    expect(handle.prepare('SELECT count(*) AS n FROM notes').get()).toEqual({ n: 0 })
    expect(handle.prepare('SELECT count(*) AS n FROM idempotency_keys').get()).toEqual({ n: 0 })
    handle.close()
  })

  it('[unit] nested transactions claim once, in the outermost', async () => {
    const { handle, riding } = setup()
    const execution = await runWithClaim(claimFor('first'), async () =>
      riding.transaction(() => {
        riding.prepare('INSERT INTO notes (id, body) VALUES (?, ?)').run(1, 'outer')
        riding.transaction(() => {
          riding.prepare('INSERT INTO notes (id, body) VALUES (?, ?)').run(2, 'inner')
        }).immediate()
      }).immediate(),
    )
    expect(execution).toMatchObject({ ok: true, wrote: true })
    expect(handle.prepare('SELECT id FROM notes ORDER BY id').all()).toEqual([{ id: 1 }, { id: 2 }])
    expect(handle.prepare('SELECT attempt FROM idempotency_keys').all()).toEqual([{ attempt: 'first' }])
    handle.close()
  })

  it('[security] refuses a write inside a transaction it did not open', async () => {
    const { handle, riding } = setup()
    handle.exec('BEGIN')
    const execution = await runWithClaim(claimFor('first'), async () =>
      riding.prepare('INSERT INTO notes (id, body) VALUES (?, ?)').run(1, 'unclaimed'),
    )
    handle.exec('ROLLBACK')
    expect(execution).toMatchObject({ ok: false, wrote: false })
    expect(String((execution as { error: unknown }).error)).toMatch(/cannot carry an idempotency claim/)
    handle.close()
  })
})

it('[security] preserves the raw D1 claim error when competing ownership cannot be read', async () => {
  const miniflare = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'] })
  try {
    const binding = await miniflare.getD1Database('DB')
    for (const sql of schema) await binding.prepare(sql).run()
    const winner = createIdempotentD1(binding)
    await runWithClaim(claimFor('winner'), () => winner.prepare('INSERT INTO notes VALUES (1, ?)').bind('kept').run())
    const unreadable = new Proxy(binding, {
      get(target, property) {
        if (property === 'prepare') return (sql: string) => {
          const statement = target.prepare(sql)
          if (sql !== 'SELECT attempt FROM idempotency_keys WHERE id = ?') return statement
          return { bind: () => ({ first: async () => { throw new Error('owner read unavailable') } }) }
        }
        const value: unknown = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const losing = createIdempotentD1(unreadable)
    const result = await runWithClaim(claimFor('loser'), () => losing.prepare('INSERT INTO notes VALUES (2, ?)').bind('rolled back').run())
    expect(result).toMatchObject({ ok: false, wrote: false, lost: false })
    if (!result.ok) {
      expect(result.error).not.toBeInstanceOf(IdempotencyClaimConflict)
      expect((result.error as Error).message).toContain('idempotency_keys.id')
    }
    expect((await binding.prepare('SELECT id FROM notes').all()).results).toEqual([{ id: 1 }])
  } finally { await miniflare.dispose() }
})
