import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { migrateContainer } from '../src/migrate.js'
import { createQuickBooksStore, type QuickBooksStore } from '../src/quickbooks.js'

const t = (minute: number): string =>
  `2026-09-11T12:${String(minute).padStart(2, '0')}:00.000Z`

let sqlite: BetterSqlite3.Database | null = null

const fixture = async (): Promise<QuickBooksStore> => {
  sqlite = new BetterSqlite3(':memory:')
  await migrateContainer(sqlite)
  const database = createContainerDatabase(sqlite)
  sqlite.exec(`
    INSERT INTO organizations (name, modules, created_at, updated_at)
      VALUES ('Fixture', '{}', '${t(0)}', '${t(0)}');
    INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
      VALUES (1, 'Operator', 'One', 'administrator', '[]', '${t(0)}', '${t(0)}');
    INSERT INTO clients (id, name, currency, created_at, updated_at)
      VALUES (1, 'Kestrel Environmental', 'USD', '${t(0)}', '${t(0)}');
  `)
  return createQuickBooksStore(database)
}

afterEach(() => {
  sqlite?.close()
  sqlite = null
})

const connected = async (store: QuickBooksStore, realmId = 'realm-a'): Promise<void> => {
  await store.saveConnection({
    realmId,
    accessToken: 'access',
    refreshToken: 'refresh',
    accessTokenExpiresAt: t(59),
    refreshTokenExpiresAt: t(59),
    scope: 'com.intuit.quickbooks.accounting',
    connectedByUserId: 1,
    companyName: 'Sandbox Company',
    now: t(1),
  })
}

describe('QuickBooks connection storage', () => {
  it('[db] stores a connection and reads it back', async () => {
    const store = await fixture()
    expect(await store.readConnection()).toBeNull()
    await connected(store)
    expect(await store.readConnection()).toMatchObject({
      realmId: 'realm-a',
      companyName: 'Sandbox Company',
      scope: 'com.intuit.quickbooks.accounting',
      // Off unless asked. It only does anything where the company has
      // QuickBooks Payments, and it changes how a client is invited to pay.
      allowOnlinePayment: false,
      connectedByUserId: 1,
    })
  })

  it('[security] a disconnected connection reads as no connection', async () => {
    const store = await fixture()
    await connected(store)
    await store.disconnect({ now: t(5) })
    // Not deleted -- the links keep a company to point at and an operator can
    // still read what was mirrored -- but nothing may treat it as live.
    expect(await store.readConnection()).toBeNull()
  })

  it('[security] connecting a different company retires the first rather than editing it', async () => {
    const store = await fixture()
    await connected(store, 'realm-a')
    await store.saveLink({
      realmId: 'realm-a',
      kind: 'customer',
      ezactoId: 1,
      quickBooksId: 'qb-1',
      syncToken: '0',
      now: t(2),
    })

    // A new accountant, a restructure, a sandbox somebody was testing against.
    await connected(store, 'realm-b')
    expect(await store.readConnection()).toMatchObject({ realmId: 'realm-b' })

    // The link made against the old company must not be reachable from the new
    // one. Reusing it would update an invoice in somebody else's books.
    expect(
      await store.readLink({ realmId: 'realm-b', kind: 'customer', ezactoId: 1 }),
    ).toBeNull()
    // And it is still on record under the company it was made against.
    expect(
      await store.readLink({ realmId: 'realm-a', kind: 'customer', ezactoId: 1 }),
    ).toMatchObject({ quickBooksId: 'qb-1' })
  })

  it('[db] a refresh replaces both tokens', async () => {
    const store = await fixture()
    await connected(store)
    await store.saveTokens({
      realmId: 'realm-a',
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      accessTokenExpiresAt: t(58),
      refreshTokenExpiresAt: t(58),
      now: t(6),
    })
    // Intuit rotates the refresh token on every refresh and the old one stops
    // working, so storing only the access token loses the connection.
    expect(await store.readConnection()).toMatchObject({
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
    })
  })
})

describe('the OAuth handshake', () => {
  it('[security] a state is single use', async () => {
    const store = await fixture()
    await store.beginAuthorization({
      state: 'state-value-0123456789',
      userId: 1,
      redirectUri: 'https://app.example.test/cb',
      now: t(1),
      expiresAt: t(11),
    })
    expect(
      await store.consumeAuthorization({ state: 'state-value-0123456789', now: t(2) }),
    ).toMatchObject({ userId: 1, redirectUri: 'https://app.example.test/cb' })
    // A replayed callback finds nothing. Without this, a captured callback URL
    // can be fired again.
    expect(
      await store.consumeAuthorization({ state: 'state-value-0123456789', now: t(3) }),
    ).toBeNull()
  })

  it('[security] an expired state is refused', async () => {
    const store = await fixture()
    await store.beginAuthorization({
      state: 'state-value-0123456789',
      userId: 1,
      redirectUri: 'https://app.example.test/cb',
      now: t(1),
      expiresAt: t(11),
    })
    expect(
      await store.consumeAuthorization({ state: 'state-value-0123456789', now: t(12) }),
    ).toBeNull()
  })

  it('[security] an unknown state is refused', async () => {
    const store = await fixture()
    // The forged-callback case: a state this instance never issued.
    expect(
      await store.consumeAuthorization({ state: 'never-issued-0123456789', now: t(2) }),
    ).toBeNull()
  })
})

describe('mirror links', () => {
  it('[db] a link updates its sync token in place', async () => {
    const store = await fixture()
    await connected(store)
    await store.saveLink({
      realmId: 'realm-a',
      kind: 'customer',
      ezactoId: 1,
      quickBooksId: 'qb-1',
      syncToken: '0',
      now: t(2),
    })
    await store.saveLink({
      realmId: 'realm-a',
      kind: 'customer',
      ezactoId: 1,
      quickBooksId: 'qb-1',
      syncToken: '1',
      now: t(3),
    })
    expect(
      await store.readLink({ realmId: 'realm-a', kind: 'customer', ezactoId: 1 }),
    ).toMatchObject({ quickBooksId: 'qb-1', syncToken: '1' })
  })

  it('[security] refuses a link to a client that does not exist', async () => {
    const store = await fixture()
    await connected(store)
    // A link is a claim that two records are the same thing. One end being
    // absent means the claim is already false.
    const refusal = await store
      .saveLink({
        realmId: 'realm-a',
        kind: 'customer',
        ezactoId: 9_999,
        quickBooksId: 'qb-9',
        syncToken: '0',
        now: t(2),
      })
      .then(
        () => null,
        (error: unknown) => error,
      )
    expect(refusal).not.toBeNull()
    // Drizzle wraps the driver error, so the trigger's own sentence is on the
    // cause. Asserting it rather than "something threw" is what keeps this from
    // passing on a typo in the SQL above.
    const cause = (refusal as { cause?: unknown }).cause
    expect(String((cause as Error | undefined)?.message ?? refusal)).toMatch(
      /client that does not exist/u,
    )
  })

  it('[security] refuses two of our records pointing at one QuickBooks document', async () => {
    const store = await fixture()
    await connected(store)
    sqlite!.exec(`
      INSERT INTO clients (id, name, currency, created_at, updated_at)
        VALUES (2, 'Northpeak', 'USD', '${t(0)}', '${t(0)}');
    `)
    await store.saveLink({
      realmId: 'realm-a',
      kind: 'customer',
      ezactoId: 1,
      quickBooksId: 'qb-1',
      syncToken: '0',
      now: t(2),
    })
    // Two clients on one customer means one of them overwrites the other every
    // time it mirrors.
    await expect(
      store.saveLink({
        realmId: 'realm-a',
        kind: 'customer',
        ezactoId: 2,
        quickBooksId: 'qb-1',
        syncToken: '0',
        now: t(3),
      }),
    ).rejects.toThrow()
  })
})

describe('webhook deliveries', () => {
  const delivery = {
    realmId: 'realm-a',
    entityName: 'Payment',
    entityId: 'qb-pay-1',
    operation: 'Create',
    lastUpdated: t(20),
  }

  it('[security] the same delivery is claimed once', async () => {
    const store = await fixture()
    await connected(store)
    expect(await store.claimWebhookDelivery({ ...delivery, now: t(21) })).toBe(true)
    // Intuit retries, and a retry after a slow-but-successful handler is
    // indistinguishable from a first delivery. Recording a payment twice against
    // one invoice is money, not bookkeeping.
    expect(await store.claimWebhookDelivery({ ...delivery, now: t(22) })).toBe(false)
  })

  it('[db] a later change to the same entity is its own delivery', async () => {
    const store = await fixture()
    await connected(store)
    expect(await store.claimWebhookDelivery({ ...delivery, now: t(21) })).toBe(true)
    // A second, genuine edit. Same entity, different instant: not a retry.
    expect(
      await store.claimWebhookDelivery({ ...delivery, lastUpdated: t(30), now: t(31) }),
    ).toBe(true)
  })

  it('[db] completing a delivery records why it was skipped', async () => {
    const store = await fixture()
    await connected(store)
    await store.claimWebhookDelivery({ ...delivery, now: t(21) })
    await store.completeWebhookDelivery({
      ...delivery,
      now: t(22),
      skippedReason: 'entity is not mirrored',
    })
    const rows = sqlite!
      .prepare(
        `SELECT processed_at, skipped_reason FROM quickbooks_webhook_deliveries
         WHERE entity_id = ?`,
      )
      .all('qb-pay-1') as { processed_at: string; skipped_reason: string }[]
    expect(rows[0]).toMatchObject({
      processed_at: t(22),
      skipped_reason: 'entity is not mirrored',
    })
  })
})
