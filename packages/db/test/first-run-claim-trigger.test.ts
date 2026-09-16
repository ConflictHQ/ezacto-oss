import BetterSqlite3 from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { migrateContainer } from '../src/migrate.js'
import { createContainerPasswordAuthService } from '../src/password-auth.js'

describe('the claim trigger enforces the predicate itself', () => {
  it('refuses a nonce change once any address is verified, whatever the caller does', async () => {
    const db = new BetterSqlite3(':memory:')
    migrateContainer(db)
    const svc = createContainerPasswordAuthService(db, { now: () => '2026-08-28T20:00:00.000Z' })
    const claim = await svc.signup({
      organizationName: 'Org', firstName: 'A', lastName: 'B',
      email: 'owner@example.test', password: 'correct horse battery staple', clientKey: '1.1.1.1',
    })
    await svc.verifyEmail(claim.token, '1.1.1.1')
    // Straight at the table, bypassing every guard in the service.
    expect(() =>
      db.prepare(`UPDATE auth_first_run SET claim_nonce = 'aaaaaaaaaaaaaaaa' WHERE id = 1`).run(),
    ).toThrow(/immutable/i)
  })
})
