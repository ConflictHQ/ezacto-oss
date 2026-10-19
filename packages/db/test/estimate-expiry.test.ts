import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import {
  effectiveEstimateExpiry,
  estimateExpiryInstant,
  isEstimateExpired,
} from '../src/estimates.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import {
  createMoneyResourceRepository,
  MoneyResourceOperationError,
  type MoneyResourceDatabase,
  type MoneyResourceRepository,
} from '../src/money-resources.js'

// Issue 1010, owner decision 2026-10-19: a staff-set expiry per estimate, else the
// organization's N days from sent_at; editing it never invalidates the version the
// customer was shown; the boundary is midnight in the instance timezone.

const zone = 'America/Costa_Rica' // UTC-6, no daylight saving: midnight is 06:00Z.

describe('estimate expiry rules', () => {
  it('prefers the day staff set over the organization default', () => {
    expect(
      effectiveEstimateExpiry({
        expiresOn: '2026-11-30',
        sentAt: '2026-10-01T11:00:00.000Z',
        validityDays: 7,
        timeZone: zone,
      }),
    ).toBe('2026-11-30')
  })

  it('counts the default from the day it was sent in the instance timezone', () => {
    // 03:00Z on the 20th is still the 19th in Costa Rica, so 7 days ends on the 26th.
    expect(
      effectiveEstimateExpiry({
        expiresOn: null,
        sentAt: '2026-10-20T03:00:00.000Z',
        validityDays: 7,
        timeZone: zone,
      }),
    ).toBe('2026-10-26')
    expect(
      effectiveEstimateExpiry({
        expiresOn: null,
        sentAt: '2026-10-20T03:00:00.000Z',
        validityDays: 7,
        timeZone: 'UTC',
      }),
    ).toBe('2026-10-27')
  })

  it('does not expire without a staff day or a default and a send', () => {
    const base = { expiresOn: null, sentAt: '2026-10-01T11:00:00.000Z', validityDays: 7, timeZone: zone }
    expect(effectiveEstimateExpiry({ ...base, validityDays: null })).toBeNull()
    expect(effectiveEstimateExpiry({ ...base, sentAt: null })).toBeNull()
    expect(isEstimateExpired(null, zone, '2099-01-01T00:00:00.000Z')).toBe(false)
  })

  it('stays open through the expiry day and closes at the next midnight', () => {
    expect(estimateExpiryInstant('2026-10-20', zone)).toBe('2026-10-21T06:00:00.000Z')
    expect(isEstimateExpired('2026-10-20', zone, '2026-10-21T05:59:59.999Z')).toBe(false)
    expect(isEstimateExpired('2026-10-20', zone, '2026-10-21T06:00:00.000Z')).toBe(true)
    // A timestamp without milliseconds compares by instant, not by string.
    expect(isEstimateExpired('2026-10-20', zone, '2026-10-21T06:00:00Z')).toBe(true)
    expect(isEstimateExpired('2026-10-20', zone, '2026-10-21T05:59:59Z')).toBe(false)
    // The same day is a different instant in UTC.
    expect(isEstimateExpired('2026-10-20', 'UTC', '2026-10-21T00:00:00.000Z')).toBe(true)
  })

  it('crosses month and year ends', () => {
    expect(estimateExpiryInstant('2026-12-31', 'UTC')).toBe('2027-01-01T00:00:00.000Z')
    expect(estimateExpiryInstant('2028-02-28', 'UTC')).toBe('2028-02-29T00:00:00.000Z')
  })
})

interface Harness {
  repo: MoneyResourceRepository
  run(sql: string, ...params: unknown[]): Promise<void>
  rows<T>(sql: string, ...params: unknown[]): Promise<T[]>
  close(): Promise<void>
}

const t0 = '2026-10-01T10:00:00.000Z'
const sentAt = '2026-10-01T11:00:00.000Z'

const containerHarness = async (): Promise<Harness> => {
  const sqlite = new BetterSqlite3(':memory:')
  migrateContainer(sqlite)
  return {
    repo: createMoneyResourceRepository(
      createContainerDatabase(sqlite) as unknown as MoneyResourceDatabase,
    ),
    run: async (sql, ...params) => {
      sqlite.prepare(sql).run(...params)
    },
    rows: async <T>(sql: string, ...params: unknown[]) => sqlite.prepare(sql).all(...params) as T[],
    close: async () => {
      sqlite.close()
    },
  }
}

const d1Harness = async (): Promise<Harness> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const d1 = await miniflare.getD1Database('DB')
  await migrateD1(d1)
  return {
    repo: createMoneyResourceRepository(createD1Database(d1) as unknown as MoneyResourceDatabase),
    run: async (sql, ...params) => {
      await d1
        .prepare(sql)
        .bind(...params)
        .run()
    },
    rows: async <T>(sql: string, ...params: unknown[]) =>
      (
        await d1
          .prepare(sql)
          .bind(...params)
          .all<T>()
      ).results,
    close: async () => miniflare.dispose(),
  }
}

let messageIds = 1_000_000
const send = async (db: Harness, estimateId: number): Promise<void> => {
  const current = await db.repo.getEstimate(estimateId)
  messageIds += 1000
  await db.repo.executeEstimateMessage({
    estimateId,
    commandId: `cmd-${messageIds}`,
    actorUserId: 1,
    messageId: messageIds,
    expectedVersion: current!.version,
    eventType: 'send',
    sentBy: 'Staff',
    sentByEmail: 'staff@org.test',
    sentFrom: null,
    sentFromEmail: null,
    recipients: [{ name: 'Alice', email: 'alice@one.test' }],
    subject: null,
    body: null,
    sendMeACopy: false,
    occurredAt: sentAt,
  })
}

// Estimate 1 stays a draft; 2, 3 and 4 are sent.
const seed = async (db: Harness): Promise<void> => {
  await db.run(
    `INSERT INTO organizations (name, modules, timezone, created_at, updated_at)
     VALUES ('Org', '{}', ?, ?, ?)`,
    zone,
    t0,
    t0,
  )
  await db.run(
    `INSERT INTO clients (id, name, currency, created_at, updated_at) VALUES (1, 'Client', 'USD', ?, ?)`,
    t0,
    t0,
  )
  await db.run(
    `INSERT INTO contacts (id, client_id, first_name, last_name, email, created_at, updated_at)
     VALUES (1, 1, 'Alice', 'Tester', 'alice@one.test', ?, ?)`,
    t0,
    t0,
  )
  for (const id of [1, 2, 3, 4]) {
    await db.run(
      `INSERT INTO estimates (id, client_id, number, currency, issue_date, amount_cents,
         created_at, updated_at) VALUES (?, 1, ?, 'USD', '2026-10-01', 20000, ?, ?)`,
      id,
      `EST-${id}`,
      t0,
      t0,
    )
    await db.run(
      `INSERT INTO estimate_line_items (estimate_id, position, kind, description, quantity,
         unit_price_cents, amount_cents, taxed, created_at, updated_at)
       VALUES (?, 0, 'Service', 'Design', 1, 20000, 20000, 0, ?, ?)`,
      id,
      t0,
      t0,
    )
  }
  for (const id of [2, 3, 4]) await send(db, id)
}

const failureCode = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise
  } catch (error) {
    if (error instanceof MoneyResourceOperationError) return error.code
    throw error
  }
  return 'resolved'
}

const lastMomentOpen = '2026-10-21T05:59:59.999Z'
const firstMomentExpired = '2026-10-21T06:00:00.000Z'

describe.each([
  ['container', containerHarness],
  ['D1', d1Harness],
] as const)('estimate expiry (%s)', (_name, factory) => {
  let open: Harness | null = null
  afterEach(async () => {
    await open?.close()
    open = null
  })
  const ready = async (): Promise<Harness> => {
    open = await factory()
    await seed(open)
    return open
  }
  const setExpiry = (db: Harness, estimateId: number, expiresOn: string | null, version: number) =>
    db.repo.setEstimateExpiry({
      estimateId,
      expectedVersion: version,
      expiresOn,
      occurredAt: '2026-10-05T10:00:00.000Z',
    })
  const answer = (db: Harness, estimateId: number, version: string, occurredAt: string) =>
    db.repo.respondToEstimate({
      estimateId,
      clientId: 1,
      contactId: 1,
      decision: 'accept',
      version,
      occurredAt,
    })

  it('lets staff set, see and clear an expiry without changing the version the customer was shown', async () => {
    const db = await ready()
    const before = (await db.repo.getCustomerEstimate(1, 2, t0))!
    const estimate = (await db.repo.getEstimate(2))!
    expect(estimate.expires_on).toBeNull()
    expect(estimate.effective_expires_on).toBeNull()

    const set = await setExpiry(db, 2, '2026-10-20', estimate.version)
    expect(set).toMatchObject({
      expires_on: '2026-10-20',
      effective_expires_on: '2026-10-20',
      version: estimate.version + 1,
    })
    const after = (await db.repo.getCustomerEstimate(1, 2, t0))!
    expect(after.version).toBe(before.version)
    expect(after).toMatchObject({ expires_on: '2026-10-20', expired: false, answerable: true })

    // The customer who opened the quote before the expiry moved can still answer it.
    expect((await answer(db, 2, before.version, '2026-10-06T10:00:00.000Z')).replayed).toBe(false)

    // Staff-set expiry can be set on a draft too.
    const draft = (await db.repo.getEstimate(1))!
    expect((await setExpiry(db, 1, '2026-12-01', draft.version)).expires_on).toBe('2026-12-01')
    const cleared = await setExpiry(db, 1, null, draft.version + 1)
    expect(cleared).toMatchObject({ expires_on: null, effective_expires_on: null })
  })

  it('is safe to repeat and refuses stale versions, answered estimates and unknown ids', async () => {
    const db = await ready()
    const estimate = (await db.repo.getEstimate(2))!
    await setExpiry(db, 2, '2026-10-20', estimate.version)
    const bumped = (await db.repo.getEstimate(2))!
    // A retry of the same request, with the version it carried, changes nothing.
    const again = await setExpiry(db, 2, '2026-10-20', estimate.version)
    expect(again.version).toBe(bumped.version)
    // A different day against a stale version is refused and writes nothing.
    expect(await failureCode(setExpiry(db, 2, '2026-10-22', estimate.version))).toBe(
      'estimate_version_conflict',
    )
    expect((await db.repo.getEstimate(2))!.expires_on).toBe('2026-10-20')
    expect(await failureCode(setExpiry(db, 999, '2026-10-22', 0))).toBe('estimate_not_found')

    const view = (await db.repo.getCustomerEstimate(1, 3, t0))!
    await answer(db, 3, view.version, '2026-10-06T10:00:00.000Z')
    const answered = (await db.repo.getEstimate(3))!
    expect(await failureCode(setExpiry(db, 3, '2026-10-22', answered.version))).toBe(
      'estimate_state_conflict',
    )
    await expect(setExpiry(db, 2, 'not-a-day', bumped.version)).rejects.toThrow(RangeError)
    await expect(setExpiry(db, 2, '2026-02-30', bumped.version)).rejects.toThrow(RangeError)
  })

  it('answers through the last moment of the expiry day and refuses at midnight, with a distinct error', async () => {
    const db = await ready()
    const four = (await db.repo.getEstimate(4))!
    const two = (await db.repo.getEstimate(2))!
    await setExpiry(db, 4, '2026-10-20', four.version)
    await setExpiry(db, 2, '2026-10-20', two.version)
    const lateView = (await db.repo.getCustomerEstimate(1, 4, lastMomentOpen))!
    expect(lateView).toMatchObject({ expired: false, answerable: true })
    expect((await answer(db, 4, lateView.version, lastMomentOpen)).replayed).toBe(false)

    const view = (await db.repo.getCustomerEstimate(1, 2, firstMomentExpired))!
    expect(view).toMatchObject({ expires_on: '2026-10-20', expired: true, answerable: false })
    const messages = await db.rows<{ n: number }>(`SELECT count(*) AS n FROM estimate_messages`)
    expect(await failureCode(answer(db, 2, view.version, firstMomentExpired))).toBe(
      'estimate_expired',
    )
    // Refused means nothing was written and the estimate is still open for staff.
    expect(await db.rows<{ n: number }>(`SELECT count(*) AS n FROM estimate_messages`)).toEqual(
      messages,
    )
    expect((await db.repo.getEstimate(2))!.state).toBe('sent')
    // Expired is not the same refusal as a stale or already-answered quote.
    expect(await failureCode(answer(db, 2, 'f'.repeat(64), firstMomentExpired))).toBe(
      'estimate_expired',
    )
  })

  it('replays an answer already recorded even after the expiry passed', async () => {
    const db = await ready()
    const two = (await db.repo.getEstimate(2))!
    await setExpiry(db, 2, '2026-10-20', two.version)
    const view = (await db.repo.getCustomerEstimate(1, 2, lastMomentOpen))!
    await answer(db, 2, view.version, lastMomentOpen)
    const replay = await answer(db, 2, view.version, firstMomentExpired)
    expect(replay.replayed).toBe(true)
    expect(replay.estimate.expired).toBe(false) // answered, so nothing is left to expire
  })

  it('falls back to the organization days from the day it was sent, and a staff day overrides it', async () => {
    const db = await ready()
    await db.run(`UPDATE organizations SET estimate_validity_days = 7`)
    // Sent 2026-10-01 in Costa Rica, so the seventh day after is the 8th.
    const view = (await db.repo.getCustomerEstimate(1, 2, t0))!
    expect(view).toMatchObject({ expires_on: '2026-10-08', expired: false, answerable: true })
    const estimate = (await db.repo.getEstimate(2))!
    expect(estimate).toMatchObject({ expires_on: null, effective_expires_on: '2026-10-08' })

    expect(
      await failureCode(answer(db, 2, view.version, '2026-10-09T06:00:00.000Z')),
    ).toBe('estimate_expired')

    await setExpiry(db, 2, '2026-10-31', estimate.version)
    const extended = (await db.repo.getCustomerEstimate(1, 2, '2026-10-09T06:00:00.000Z'))!
    expect(extended).toMatchObject({ expires_on: '2026-10-31', expired: false, answerable: true })
    expect(extended.version).toBe(view.version)
    expect((await answer(db, 2, view.version, '2026-10-09T06:00:00.000Z')).replayed).toBe(false)
  })

  it('does not expire an estimate when neither a staff day nor an organization default exists', async () => {
    const db = await ready()
    const view = (await db.repo.getCustomerEstimate(1, 2, '2099-01-01T00:00:00.000Z'))!
    expect(view).toMatchObject({ expires_on: null, expired: false, answerable: true })
  })

  it('rejects an out-of-range organization default and a malformed estimate day in storage', async () => {
    const db = await ready()
    await expect(db.run(`UPDATE organizations SET estimate_validity_days = 0`)).rejects.toThrow()
    await expect(db.run(`UPDATE organizations SET estimate_validity_days = 3651`)).rejects.toThrow()
    await expect(db.run(`UPDATE estimates SET expires_on = '2026-13-01' WHERE id = 2`)).rejects.toThrow()
    await expect(db.run(`UPDATE estimates SET expires_on = '10/20/2026' WHERE id = 2`)).rejects.toThrow()
  })
})
