import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { aggregateAppleCleanup, type AppleWebCustodyStore } from '@ezacto/core'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { createAppleLifecycleRepository } from '../src/apple-lifecycle.js'
import { createContainerAppleWebCustodyStore, createD1AppleWebCustodyStore } from '../src/apple-web-custody.js'
import { createAccountClosureRepository } from '../src/account-closure.js'
import { createAccountDeletionRequestRepository } from '../src/account-deletion-requests.js'
import { createAccountRetentionRepository } from '../src/account-retention.js'

const now = '2026-10-09T00:00:00.000Z'
for (const runtime of ['SQLite', 'D1']) describe(`combined Apple cleanup (${runtime})`, () => {
  let dispose: (() => Promise<void>) | undefined
  afterEach(async () => dispose?.())
  it.each(['web-only', 'native-first', 'web-first'])('keeps every known channel unresolved through local erasure: %s', async order => {
    const nativeLinked = order !== 'web-only'
    let database: Parameters<typeof createAppleLifecycleRepository>[0]
    let web: AppleWebCustodyStore
    let execute: (sql: string) => Promise<unknown>
    if (runtime === 'SQLite') {
      const sqlite = new BetterSqlite3(':memory:')
      dispose = async () => { sqlite.close() }
      migrateContainer(sqlite)
      database = createContainerDatabase(sqlite)
      web = createContainerAppleWebCustodyStore(sqlite)
      execute = async sql => sqlite.exec(sql)
    } else {
      const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'] })
      dispose = () => mf.dispose()
      const db = await mf.getD1Database('DB')
      await migrateD1(db)
      database = createD1Database(db)
      web = createD1AppleWebCustodyStore(db)
      execute = sql => db.prepare(sql).run()
    }
    await execute(`INSERT INTO users(id,first_name,last_name,profile,is_active,manager_grants,created_at,updated_at) VALUES(1,'Ada','Owner','administrator',1,'[]','${now}','${now}'),(2,'Pat','Person','member',1,'[]','${now}','${now}')`)
    await execute(`INSERT INTO user_identities(user_id,provider,provider_subject,created_at,updated_at) VALUES(2,'apple','apple-pat','${now}','${now}')`)
    await createAccountRetentionRepository(database).publish({ actorUserId: 1, expectedVersion: 0, now, policy: {
      frameworks: [], retained_records: [{ category: 'audit_and_security', reason: 'Minimal request evidence.', period: 'Review within one year.', review_after_days: 30 }],
      response_target_days: 14, operator_contact: 'privacy@example.test', user_notice: 'Close local access.', backup_handling: 'Replay closure evidence before restoring access.', acknowledged: true,
    } })
    const native = createAppleLifecycleRepository(database)
    const binding = { subject: 'apple-pat', origin: 'https://app.example.com', grantId: 'native_grant', generation: 1, eventId: 'native_binding' }
    if (order === 'native-first') expect(await native.recordSignIn({ ...binding, userId: 2, now, knownFromFirstLink: true })).toBe(true)
    const connection = { id: 'c'.repeat(43), subjectDigest: 'a'.repeat(64), browserHash: 'b'.repeat(64), userId: 2,
      serviceIssuer: 'https://apple-auth.ezacto.com', instanceOrigin: 'https://app.example.com', clientId: 'com.ezacto.web', grantId: 'web_grant', generation: 2,
      sealedCapability: '{"ciphertext":"encrypted"}', sealedReceipt: null, cleanupRequestId: null, status: 'active' as const, createdAt: now, updatedAt: now }
    expect(await web.save(connection, { subject: 'apple-pat', knownFromFirstLink: order !== 'native-first' })).not.toBeNull()
    if (order === 'web-first') expect(await native.recordSignIn({ ...binding, userId: 2, now, knownFromFirstLink: false })).toBe(true)
    await createAccountDeletionRequestRepository(database).request({ userId: 2, id: 'request-one', expectedPolicyVersion: 1, now })
    await native.begin(2, 'request-one'); await web.begin(2, 'request-one', now)
    const closure = createAccountClosureRepository(database)
    const preview = await closure.preview(1, 'request-one')
    await closure.close({ actorUserId: 1, id: 'request-one', expectedVersion: preview.request_version, expectedPolicyVersion: 1, reviewToken: preview.review_token, now, acknowledged: true })
    expect(await native.status('request-one')).toBe(nativeLinked ? 'pending' : 'not_linked')
    expect(await web.status('request-one')).toBe('pending')
    if (nativeLinked) expect(await native.acceptRevocation({ ...binding, type: 'apple_revocation', eventId: 'native_revoked', requestId: 'request-one', revokedAt: now, now })).toBe(true)
    expect(aggregateAppleCleanup([await native.status('request-one'), await web.status('request-one')])).toBe('pending')
    expect(await web.complete({ id: connection.id, requestId: 'request-one', grantId: connection.grantId, generation: connection.generation, sealedReceipt: '{"ciphertext":"verified-web-proof"}', now })).toBe(true)
    expect(aggregateAppleCleanup([await native.status('request-one'), await web.status('request-one')])).toBe('revoked')
  })
})
