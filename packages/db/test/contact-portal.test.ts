import BetterSqlite3 from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createContainerContactSessionStore,
  type ContactSessionStore,
} from '../src/contact-sessions.js'
import {
  createContainerMagicLinkStore,
  type MagicLinkStore,
} from '../src/magic-link-state.js'
import { migrateContainer } from '../src/migrate.js'

interface Harness {
  sessions: ContactSessionStore
  magicLinks: MagicLinkStore
  setNow(value: string): void
  close(): Promise<void>
}

const initialTime = '2026-09-01T00:00:00.000Z'
const idleTtlMs = 24 * 60 * 60 * 1_000
const absoluteTtlMs = 7 * 24 * 60 * 60 * 1_000

const seedStatements = [
  {
    query: `INSERT INTO organizations (id, name, modules, created_at, updated_at)
      VALUES (1, 'Portal Test Org', '{}', ?, ?)`,
    bindings: [initialTime, initialTime],
  },
  {
    query: `INSERT INTO clients (id, name, currency, created_at, updated_at)
      VALUES (1, 'Acme Corp', 'USD', ?, ?)`,
    bindings: [initialTime, initialTime],
  },
  {
    query: `INSERT INTO contacts (id, client_id, first_name, last_name, email, created_at, updated_at)
      VALUES (1, 1, 'Alice', 'Smith', 'alice@acme.test', ?, ?)`,
    bindings: [initialTime, initialTime],
  },
  {
    query: `INSERT INTO contacts (id, client_id, first_name, last_name, email, created_at, updated_at)
      VALUES (2, 1, 'Bob', 'Jones', 'bob@acme.test', ?, ?)`,
    bindings: [initialTime, initialTime],
  },
] as const

const containerHarness = async (): Promise<Harness> => {
  const database = new BetterSqlite3(':memory:')
  migrateContainer(database)
  for (const statement of seedStatements) {
    database.prepare(statement.query).run(...statement.bindings)
  }
  let currentTime = initialTime
  const nowFn = () => currentTime
  return {
    sessions: createContainerContactSessionStore(database, {
      now: nowFn,
      idleTtlMs,
      absoluteTtlMs,
    }),
    magicLinks: createContainerMagicLinkStore(database, { now: nowFn }),
    setNow: (value) => {
      currentTime = value
    },
    close: async () => {
      database.close()
    },
  }
}

const factories = [
  ['container', containerHarness],
] as const

for (const [runtime, factory] of factories) {
  describe(`contact portal (${runtime})`, () => {
    let harness: Harness

    beforeAll(async () => {
      harness = await factory()
    })

    afterAll(async () => harness.close())

    // --- Contact session tests ---

    it('[unit] issues a portal session and authenticates it', async () => {
      const issued = await harness.sessions.issue(1, 1)
      expect(issued.token).toMatch(
        /^ezacto_portal_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{43}$/,
      )
      expect(issued.session).toMatchObject({
        contactId: 1,
        clientId: 1,
        createdAt: initialTime,
        lastSeenAt: initialTime,
      })
      expect(Date.parse(issued.session.absoluteExpiresAt)).toBe(
        Date.parse(initialTime) + absoluteTtlMs,
      )

      const authed = await harness.sessions.authenticate(issued.token)
      expect(authed).not.toBeNull()
      expect(authed!.contactId).toBe(1)
      expect(authed!.clientId).toBe(1)
    })

    it('[unit] rejects an invalid portal token', async () => {
      const result = await harness.sessions.authenticate('not_a_valid_token')
      expect(result).toBeNull()
    })

    it('[unit] rejects a correctly formatted but unknown portal token', async () => {
      const fakeToken =
        'ezacto_portal_AAAAAAAAAAAAAAAA_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
      const result = await harness.sessions.authenticate(fakeToken)
      expect(result).toBeNull()
    })

    it('[unit] enforces idle expiry on contact sessions', async () => {
      harness.setNow('2026-09-02T00:00:00.000Z')
      const issued = await harness.sessions.issue(1, 1)
      // Advance past idle TTL (24 hours)
      harness.setNow('2026-09-03T00:00:00.000Z')
      const result = await harness.sessions.authenticate(issued.token)
      expect(result).toBeNull()
    })

    it('[unit] enforces absolute expiry on contact sessions', async () => {
      harness.setNow('2026-09-03T00:00:00.000Z')
      const issued = await harness.sessions.issue(2, 1)
      // Touch within idle to keep alive, but advance past absolute (7 days)
      for (let day = 1; day <= 6; day += 1) {
        harness.setNow(
          new Date(Date.parse('2026-09-03T00:00:00.000Z') + day * 23 * 60 * 60 * 1_000).toISOString(),
        )
        await harness.sessions.authenticate(issued.token)
      }
      // Now past absolute
      harness.setNow('2026-09-10T00:00:00.000Z')
      const result = await harness.sessions.authenticate(issued.token)
      expect(result).toBeNull()
    })

    it('[unit] touches idle expiry on authenticate', async () => {
      harness.setNow('2026-09-10T12:00:00.000Z')
      const issued = await harness.sessions.issue(1, 1)
      const initialIdle = issued.session.idleExpiresAt

      harness.setNow('2026-09-11T00:00:00.000Z')
      const authed = await harness.sessions.authenticate(issued.token)
      expect(authed).not.toBeNull()
      expect(Date.parse(authed!.session.idleExpiresAt)).toBeGreaterThan(
        Date.parse(initialIdle),
      )
    })

    // --- Magic-link token tests ---

    it('[unit] creates and consumes a magic-link token record', async () => {
      harness.setNow('2026-09-11T12:00:00.000Z')
      const record = await harness.magicLinks.create({
        jti: 'test-jti-001',
        contactEmail: 'alice@acme.test',
        contactId: 1,
        clientId: 1,
        tokenHash: 'a'.repeat(64),
        expiresAt: '2026-09-11T12:15:00.000Z',
      })
      expect(record.jti).toBe('test-jti-001')
      expect(record.usedAt).toBeNull()

      const consumed = await harness.magicLinks.consume('test-jti-001')
      expect(consumed).toMatchObject({
        contactId: 1,
        clientId: 1,
        contactEmail: 'alice@acme.test',
      })
    })

    it('[security] magic-link token is single-use', async () => {
      harness.setNow('2026-09-12T00:00:00.000Z')
      await harness.magicLinks.create({
        jti: 'single-use-test',
        contactEmail: 'bob@acme.test',
        contactId: 2,
        clientId: 1,
        tokenHash: 'b'.repeat(64),
        expiresAt: '2026-09-12T00:15:00.000Z',
      })
      const first = await harness.magicLinks.consume('single-use-test')
      expect(first).not.toBeNull()
      const second = await harness.magicLinks.consume('single-use-test')
      expect(second).toBeNull()
    })

    it('[security] expired magic-link token cannot be consumed', async () => {
      harness.setNow('2026-09-13T00:00:00.000Z')
      await harness.magicLinks.create({
        jti: 'expired-test',
        contactEmail: 'alice@acme.test',
        contactId: 1,
        clientId: 1,
        tokenHash: 'c'.repeat(64),
        expiresAt: '2026-09-13T00:05:00.000Z',
      })
      harness.setNow('2026-09-13T00:05:00.001Z')
      const result = await harness.magicLinks.consume('expired-test')
      expect(result).toBeNull()
    })

    it('[unit] consume returns null for unknown jti', async () => {
      const result = await harness.magicLinks.consume('does-not-exist')
      expect(result).toBeNull()
    })
  })
}
