import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { migrateContainer } from '../src/migrate.js'
import { createPayoutAccountStore } from '../src/payout-accounts.js'
import {
  createPayoutTransferStore,
  type PayoutTransferStore,
} from '../src/payout-transfers.js'

const t = (minute: number): string =>
  `2026-09-11T12:${String(minute).padStart(2, '0')}:00.000Z`

const period = { start: '2026-09-01', end: '2026-09-15' }

let sqlite: BetterSqlite3.Database | null = null

const fixture = async () => {
  const database = new BetterSqlite3(':memory:')
  await migrateContainer(database)
  database.pragma('foreign_keys = ON')
  database.exec(`
    INSERT INTO organizations (name, modules, created_at, updated_at)
      VALUES ('Fixture', '{}', '${t(0)}', '${t(0)}');
    INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
      VALUES (1, 'Operator', 'One', 'administrator', '[]', '${t(0)}', '${t(0)}');
    INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
      VALUES (2, 'Paid', 'Contractor', 'member', '[]', '${t(0)}', '${t(0)}');
    INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
      VALUES (3, 'Unlinked', 'Contractor', 'member', '[]', '${t(0)}', '${t(0)}');
  `)
  sqlite = database
  const orm = createContainerDatabase(database)
  const accounts = createPayoutAccountStore(orm)
  const linked = await accounts.link({
    userId: 2,
    provider: 'wise',
    externalId: 'wise-person-1',
    linkedByUserId: 1,
    now: t(1),
  })
  return {
    sqlite: database,
    orm,
    accounts,
    transfers: createPayoutTransferStore(orm),
    accountId: (linked as { account: { id: number } }).account.id,
  }
}

const claim = (
  transfers: PayoutTransferStore,
  accountId: number,
  overrides: Record<string, unknown> = {},
) =>
  transfers.claim({
    userId: 2,
    period,
    payoutAccountId: accountId,
    amountCents: 250_000,
    currency: 'USD',
    now: t(2),
    ...overrides,
  } as never)

afterEach(() => {
  sqlite?.close()
  sqlite = null
})

describe('planning a payout run (#543)', () => {
  it('[money] resolves to the stored account, never to an email', async () => {
    // The line that closes the guess in #421. An address is a guess about
    // identity; the failure mode of a wrong guess is paying the wrong person.
    const { transfers, accountId } = await fixture()
    expect(
      await transfers.plan(period, [{ userId: 2, amountCents: 250_000, currency: 'USD' }]),
    ).toEqual([
      {
        status: 'payable',
        userId: 2,
        amountCents: 250_000,
        currency: 'USD',
        provider: 'wise',
        payoutAccountId: accountId,
        verifiedAt: null,
      },
    ])
  })

  it('[money] reports a person with no account rather than skipping them', async () => {
    // Somebody who worked and cannot be paid is exactly what a run has to say
    // out loud. A silent skip is a plan that looks complete and is not.
    const { transfers } = await fixture()
    expect(
      await transfers.plan(period, [{ userId: 3, amountCents: 90_000, currency: 'USD' }]),
    ).toEqual([
      { status: 'no_account', userId: 3, amountCents: 90_000, currency: 'USD' },
    ])
  })

  it('[money] keeps every candidate in the plan, whatever their status', async () => {
    const { transfers } = await fixture()
    const plan = await transfers.plan(period, [
      { userId: 2, amountCents: 250_000, currency: 'USD' },
      { userId: 3, amountCents: 90_000, currency: 'USD' },
    ])
    expect(plan.map((entry) => entry.status)).toEqual(['payable', 'no_account'])
  })

  it('[money] will not plan a period that is already claimed', async () => {
    const { transfers, accountId } = await fixture()
    await claim(transfers, accountId)
    expect(
      await transfers.plan(period, [{ userId: 2, amountCents: 250_000, currency: 'USD' }]),
    ).toEqual([
      {
        status: 'already_transferred',
        userId: 2,
        transferId: expect.any(Number) as unknown as number,
        transferState: 'planned',
      },
    ])
  })

  it('[money] plans again once an attempt has failed', async () => {
    // A failed attempt releases the period; that is the only state that does.
    const { transfers, accountId } = await fixture()
    const claimed = await claim(transfers, accountId)
    await transfers.markFailed(claimed.transfer.id, 'Wise rejected the transfer', t(3))
    expect(
      (await transfers.plan(period, [{ userId: 2, amountCents: 250_000, currency: 'USD' }]))[0]
        ?.status,
    ).toBe('payable')
  })

  it('[unit] narrows to one provider when asked', async () => {
    const { transfers, accounts } = await fixture()
    await accounts.link({
      userId: 3,
      provider: 'deel',
      externalId: 'deel-person-3',
      linkedByUserId: 1,
      now: t(1),
    })
    const plan = await transfers.plan(
      period,
      [
        { userId: 2, amountCents: 1, currency: 'USD' },
        { userId: 3, amountCents: 1, currency: 'USD' },
      ],
      'deel',
    )
    // The Wise-only person is not payable through a Deel run, and says so.
    expect(plan.map((entry) => entry.status)).toEqual(['no_account', 'payable'])
  })

  it('[money] ignores an account that has been detached', async () => {
    const { transfers, accounts, accountId } = await fixture()
    await accounts.detach(accountId, t(3))
    expect(
      (await transfers.plan(period, [{ userId: 2, amountCents: 1, currency: 'USD' }]))[0]
        ?.status,
    ).toBe('no_account')
  })
})

describe('the transfer log', () => {
  it('[money] the same work cannot be paid twice', async () => {
    // The guarantee this table exists for, and the one #103 asks for too.
    const { transfers, accountId } = await fixture()
    const first = await claim(transfers, accountId)
    expect(first.outcome).toBe('claimed')
    const second = await claim(transfers, accountId)
    expect(second.outcome).toBe('already_claimed')
    expect(second.transfer.id).toBe(first.transfer.id)
  })

  it('[security] the index refuses a second live claim, whatever wrote it', async () => {
    // The store checks first so a caller gets an answer; the partial unique
    // index is what actually holds, including against a racing run.
    const { sqlite: database, transfers, accountId } = await fixture()
    await claim(transfers, accountId)
    expect(() =>
      database
        .prepare(
          `INSERT INTO payout_transfers
             (user_id, period_start, period_end, payout_account_id, amount_cents,
              currency, state, created_at, updated_at)
           VALUES (2, ?, ?, ?, 1, 'USD', 'planned', ?, ?)`,
        )
        .run(period.start, period.end, accountId, t(9), t(9)),
    ).toThrow()
  })

  it('[money] a sent transfer carries the provider’s own id for it', async () => {
    const { transfers, accountId } = await fixture()
    const claimed = await claim(transfers, accountId)
    expect(await transfers.markSent(claimed.transfer.id, 'wise-transfer-1', t(4))).toBe(true)
    const rows = await transfers.listForPeriod(period)
    expect(rows[0]).toMatchObject({ state: 'sent', externalTransferId: 'wise-transfer-1' })
  })

  it('[security] the schema refuses a sent transfer with no external id', async () => {
    // A transfer nobody can look up at the provider is one nobody can
    // reconcile.
    const { sqlite: database, accountId } = await fixture()
    expect(() =>
      database
        .prepare(
          `INSERT INTO payout_transfers
             (user_id, period_start, period_end, payout_account_id, amount_cents,
              currency, state, created_at, updated_at)
           VALUES (2, ?, ?, ?, 1, 'USD', 'sent', ?, ?)`,
        )
        .run(period.start, period.end, accountId, t(9), t(9)),
    ).toThrow()
  })

  it('[security] a sent transfer is immutable', async () => {
    // Money that moved is a record of what happened. Correcting it is a new
    // row, not a rewrite.
    const { sqlite: database, transfers, accountId } = await fixture()
    const claimed = await claim(transfers, accountId)
    await transfers.markSent(claimed.transfer.id, 'wise-transfer-1', t(4))
    for (const statement of [
      `UPDATE payout_transfers SET amount_cents = 1 WHERE id = ?`,
      `UPDATE payout_transfers SET user_id = 3 WHERE id = ?`,
      `UPDATE payout_transfers SET state = 'failed' WHERE id = ?`,
      `UPDATE payout_transfers SET external_transfer_id = 'other' WHERE id = ?`,
    ]) {
      expect(() => database.prepare(statement).run(claimed.transfer.id)).toThrow(
        /sent payout transfer is immutable/u,
      )
    }
  })

  it('[unit] only a planned transfer can be sent or failed', async () => {
    const { transfers, accountId } = await fixture()
    const claimed = await claim(transfers, accountId)
    await transfers.markSent(claimed.transfer.id, 'wise-transfer-1', t(4))
    expect(await transfers.markSent(claimed.transfer.id, 'again', t(5))).toBe(false)
    expect(await transfers.markFailed(claimed.transfer.id, 'no', t(5))).toBe(false)
  })

  it('[db] refuses a period that ends before it starts', async () => {
    const { sqlite: database, accountId } = await fixture()
    expect(() =>
      database
        .prepare(
          `INSERT INTO payout_transfers
             (user_id, period_start, period_end, payout_account_id, amount_cents,
              currency, state, created_at, updated_at)
           VALUES (2, '2026-09-15', '2026-09-01', ?, 1, 'USD', 'planned', ?, ?)`,
        )
        .run(accountId, t(9), t(9)),
    ).toThrow()
  })

  it('[db] refuses a zero amount and a malformed currency', async () => {
    const { transfers, accountId } = await fixture()
    await expect(claim(transfers, accountId, { amountCents: 0 })).rejects.toThrow()
    await expect(
      claim(transfers, accountId, { currency: 'usd', userId: 3 }),
    ).rejects.toThrow()
  })
})
