import BetterSqlite3 from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'
import { createMagicLinkService } from '../src/magic-link-service.js'
import { migrateContainer } from '../src/migrate.js'
import type { MagicLinkStore } from '../src/magic-link-state.js'

const signingKey = new Uint8Array(32).fill(7)
const now = '2026-09-08T12:00:00.000Z'

const database = () => {
  const sqlite = new BetterSqlite3(':memory:')
  migrateContainer(sqlite)
  sqlite
    .prepare(
      `INSERT INTO clients (id, name, currency, is_active, created_at, updated_at)
       VALUES (1, 'Northpeak', 'USD', 1, ?, ?), (2, 'Gone', 'USD', 0, ?, ?)`,
    )
    .run(now, now, now, now)
  sqlite
    .prepare(
      `INSERT INTO contacts (id, client_id, first_name, last_name, email, created_at, updated_at)
       VALUES (1, 1, 'Ada', 'Byron', 'Ada.Byron@Example.test', ?, ?),
              (2, 2, 'Gus', 'Ives', 'gus@gone.test', ?, ?),
              (3, 1, 'Twin', 'One', 'twin@example.test', ?, ?),
              (4, 1, 'Twin', 'Two', 'twin@example.test', ?, ?)`,
    )
    .run(now, now, now, now, now, now, now, now)
  return {
    all: async <Row>({ sql, params }: { sql: string; params: readonly unknown[] }) =>
      sqlite.prepare(sql).all(...params) as Row[],
    close: () => sqlite.close(),
  }
}

const store = (): MagicLinkStore & { consumed: string[] } => {
  const consumed: string[] = []
  const created = new Map<string, { contactId: number; clientId: number; contactEmail: string }>()
  return {
    consumed,
    create: async (input) => {
      created.set(input.jti, {
        contactId: input.contactId,
        clientId: input.clientId,
        contactEmail: input.contactEmail,
      })
      return { id: 1, usedAt: null, createdAt: now, ...input }
    },
    consume: async (jti) => {
      consumed.push(jti)
      const record = created.get(jti)
      if (record === undefined) return null
      created.delete(jti)
      return record
    },
    // #734. The live-link check the service asks before mailing again; this
    // fake answers from whatever create() has recorded and not yet consumed.
    hasActiveLink: async (contactEmail) =>
      [...created.values()].some(
        (record) => record.contactEmail.toLowerCase() === contactEmail.toLowerCase(),
      ),
  }
}

describe('portal magic link service', () => {
  it('[db] finds a contact whatever case they typed', async () => {
    // The record says Ada.Byron@Example.test. Nobody reproduces their own
    // address's casing, and "no such contact" for a capital letter is
    // indistinguishable from "you have no account".
    const db = database()
    const service = createMagicLinkService({ database: db, store: store(), signingKey })
    expect(await service.findContactByEmail('ada.byron@example.test')).toMatchObject({
      contactId: 1,
      clientId: 1,
    })
    db.close()
  })

  it('[security] refuses a contact whose client is archived', async () => {
    // The portal shows money. A client we have stopped working with should not
    // keep a door open to it.
    const db = database()
    const service = createMagicLinkService({ database: db, store: store(), signingKey })
    expect(await service.findContactByEmail('gus@gone.test')).toBeNull()
    db.close()
  })

  it('[security] refuses an address two contacts share', async () => {
    // Picking one would sign somebody into a client they may not belong to.
    const db = database()
    const service = createMagicLinkService({ database: db, store: store(), signingKey })
    expect(await service.findContactByEmail('twin@example.test')).toBeNull()
    db.close()
  })

  it('[security] verifies the signature before touching the database', async () => {
    // A forged token must never reach `consume`. If it did, a stream of guesses
    // could burn real records -- anyone could invalidate a link they cannot use
    // by submitting its jti.
    const db = database()
    const records = store()
    const service = createMagicLinkService({ database: db, store: records, signingKey })

    expect(await service.verifyAndConsume('ezacto_magic_forged.nonsense')).toBeNull()
    expect(records.consumed).toEqual([])
    db.close()
  })

  it('[security] a real token round-trips once, and only once', async () => {
    const db = database()
    const records = store()
    const service = createMagicLinkService({ database: db, store: records, signingKey })
    const contact = (await service.findContactByEmail('ada.byron@example.test'))!
    const issued = await service.createToken(contact)
    await service.recordToken({
      jti: issued.jti,
      contactEmail: contact.email,
      contactId: contact.contactId,
      clientId: contact.clientId,
      tokenHash: 'hash',
      expiresAt: issued.expiresAt,
    })

    expect(await service.verifyAndConsume(issued.token)).toMatchObject({ contactId: 1 })
    // Second redemption: the signature still verifies, and the record is gone.
    // Single use is the store's job, which is why it is asserted through it.
    expect(await service.verifyAndConsume(issued.token)).toBeNull()
    db.close()
  })

  it('[security] refuses a key too short to sign with', () => {
    expect(() =>
      createMagicLinkService({
        database: database(),
        store: store(),
        signingKey: new Uint8Array(16),
      }),
    ).toThrow(/at least 32 bytes/)
  })

  it('[db] expires a token when its lifetime has passed', async () => {
    const db = database()
    const records = store()
    const clock = vi.fn(() => new Date('2026-09-08T12:00:00.000Z'))
    const service = createMagicLinkService({
      database: db,
      store: records,
      signingKey,
      now: clock,
    })
    const contact = (await service.findContactByEmail('ada.byron@example.test'))!
    const issued = await service.createToken(contact)
    await service.recordToken({
      jti: issued.jti,
      contactEmail: contact.email,
      contactId: contact.contactId,
      clientId: contact.clientId,
      tokenHash: 'hash',
      expiresAt: issued.expiresAt,
    })

    clock.mockReturnValue(new Date('2026-09-08T12:30:00.000Z'))
    expect(await service.verifyAndConsume(issued.token)).toBeNull()
    expect(records.consumed).toEqual([])
    db.close()
  })
})
