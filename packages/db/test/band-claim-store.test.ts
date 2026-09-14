import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { migrateContainer } from '../src/migrate.js'
import { createMoneyResourceRepository } from '../src/money-resources.js'

/**
 * What a band claims, written and read back through the store (#707).
 *
 * The engine tests set these columns with SQL, which proves the claim but not
 * that anything can store one: `createRecurring` writes a column list nothing
 * in this package exercised, and a definition edited afterwards goes through a
 * second statement entirely. A PATCH on this resource replaces the whole
 * definition, so an update that dropped the ceiling would quietly widen a band
 * to every hour the next time somebody corrected its day of month.
 */
const at = '2026-09-12T12:00:00.000Z'
const later = '2026-09-12T13:00:00.000Z'
let sqlite: BetterSqlite3.Database | null = null
afterEach(() => {
  sqlite?.close()
  sqlite = null
})

const config = {
  schema_version: 1,
  type: 'fixed_lines',
  line_items: [
    {
      kind: 'Service',
      description: 'Monthly band',
      quantity: 1,
      unit_price_cents: 125_000,
      taxed: false,
      taxed2: false,
      project_id: null,
    },
  ],
} as const

const fixture = async () => {
  const database = new BetterSqlite3(':memory:')
  await migrateContainer(database)
  database.pragma('foreign_keys = ON')
  database.exec(`
    INSERT INTO organizations (name, modules, created_at, updated_at)
      VALUES ('Fixture', '{}', '${at}', '${at}');
    INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
      VALUES (1, 'Operator', 'One', 'administrator', '[]', '${at}', '${at}');
    INSERT INTO clients (id, name, currency, created_at, updated_at)
      VALUES (1, 'Kestrel Environmental', 'USD', '${at}', '${at}');
    INSERT INTO projects (id, client_id, name, code, created_at, updated_at)
      VALUES (1, 1, 'Platform', 'PLT', '${at}', '${at}');
  `)
  sqlite = database
  return createMoneyResourceRepository(createContainerDatabase(database))
}

const terms = (overrides: Record<string, unknown> = {}) => ({
  resourceId: 1,
  commandId: '11111111-1111-4111-8111-111111111111',
  actorUserId: 1,
  clientId: 1,
  subjectTemplate: 'Banded team',
  notesTemplate: '',
  everyNMonths: 1,
  dayOfMonth: 10,
  nextIssueOn: '2026-10-10',
  amountConfig: config,
  canDrawFromRetainerId: null,
  claimsProjectIds: [1],
  occurredAt: later,
  ...overrides,
})

describe('storing what a band claims', () => {
  it('[money] writes a ceiling in time and hands the same one back', async () => {
    const repository = await fixture()
    const created = await repository.createRecurring(
      terms({ claimMode: 'ceiling', claimCeilingSeconds: 1_440_000 }) as never,
    )
    expect(created).toMatchObject({
      claim_mode: 'ceiling',
      claim_ceiling_seconds: 1_440_000,
      claim_ceiling_cents: null,
    })
    expect(await repository.getRecurring(created.id)).toMatchObject({
      claim_mode: 'ceiling',
      claim_ceiling_seconds: 1_440_000,
      claim_ceiling_cents: null,
    })
  })

  it('[money] writes a ceiling in money and hands the same one back', async () => {
    const repository = await fixture()
    const created = await repository.createRecurring(
      terms({ claimMode: 'ceiling', claimCeilingCents: 9_368_500 }) as never,
    )
    expect(await repository.getRecurring(created.id)).toMatchObject({
      claim_mode: 'ceiling',
      claim_ceiling_seconds: null,
      claim_ceiling_cents: 9_368_500,
    })
  })

  it('[money] defaults a definition that says nothing to claiming everything', async () => {
    const repository = await fixture()
    const created = await repository.createRecurring(terms() as never)
    expect(created).toMatchObject({
      claim_mode: 'all',
      claim_ceiling_seconds: null,
      claim_ceiling_cents: null,
    })
  })

  it('[money] carries the ceiling through an edit rather than dropping it', async () => {
    // The update is a replace. An edit to the day of month must not widen the
    // band to every hour, and an edit that narrows it must actually narrow it.
    const repository = await fixture()
    const created = await repository.createRecurring(
      terms({ claimMode: 'ceiling', claimCeilingSeconds: 1_440_000 }) as never,
    )
    const kept = await repository.updateRecurring(
      created.id,
      terms({ dayOfMonth: 12, claimMode: 'ceiling', claimCeilingSeconds: 1_440_000 }) as never,
    )
    expect(kept).toMatchObject({
      day_of_month: 12,
      claim_mode: 'ceiling',
      claim_ceiling_seconds: 1_440_000,
    })
    const narrowed = await repository.updateRecurring(
      created.id,
      terms({ claimMode: 'ceiling', claimCeilingCents: 9_368_500 }) as never,
    )
    expect(narrowed).toMatchObject({
      claim_mode: 'ceiling',
      claim_ceiling_seconds: null,
      claim_ceiling_cents: 9_368_500,
    })
    const widened = await repository.updateRecurring(created.id, terms() as never)
    expect(widened).toMatchObject({
      claim_mode: 'all',
      claim_ceiling_seconds: null,
      claim_ceiling_cents: null,
    })
  })

  it('[money] writes the claim scope and carries it through an edit', async () => {
    const repository = await fixture()
    const created = await repository.createRecurring(terms({ claimScope: 'tracked' }) as never)
    expect(created).toMatchObject({ claim_scope: 'tracked' })
    expect(
      await repository.updateRecurring(created.id, terms({ dayOfMonth: 12 }) as never),
    ).toMatchObject({ day_of_month: 12, claim_scope: 'billable' })
    expect(
      await repository.updateRecurring(created.id, terms({ claimScope: 'tracked' }) as never),
    ).toMatchObject({ claim_scope: 'tracked' })
  })

  it('[money] refuses the combinations that would read as something else', async () => {
    const repository = await fixture()
    const refused: readonly [string, Record<string, unknown>][] = [
      ['both', { claimMode: 'ceiling', claimCeilingSeconds: 1_440_000, claimCeilingCents: 9_368_500 }],
      ['neither', { claimMode: 'ceiling' }],
      ['orphan', { claimCeilingCents: 9_368_500 }],
      ['unclaimed', { claimMode: 'ceiling', claimCeilingCents: 9_368_500, claimsProjectIds: null }],
      ['zero', { claimMode: 'ceiling', claimCeilingCents: 0 }],
      ['fractional', { claimMode: 'ceiling', claimCeilingSeconds: 1.5 }],
      ['scope-unclaimed', { claimScope: 'tracked', claimsProjectIds: null }],
    ]
    for (const [name, extra] of refused) {
      await expect(
        repository.createRecurring(terms(extra) as never),
        name,
      ).rejects.toThrow(TypeError)
    }
  })
})
