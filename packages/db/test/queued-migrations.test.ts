import { Miniflare } from 'miniflare'
import { afterEach, expect, it } from 'vitest'
import { migrateD1 } from '../src/migrate.js'
import { createQueuedMigrationStore } from '../src/queued-migrations.js'
const now = '2026-10-22T09:00:00.000Z'
let mf: Miniflare | undefined
afterEach(async () => mf?.dispose())
const setup = async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    d1Databases: ['DB'],
  })
  const db = await mf.getD1Database('DB')
  await migrateD1(db)
  return { db, store: createQueuedMigrationStore(db) }
}
const catalog = (id = crypto.randomUUID()) => ({
  version: 1,
  jobId: id,
  snapshotSha256: '1'.repeat(64),
  manifestSha256: '2'.repeat(64),
  checksumsSha256: '3'.repeat(64),
  sourceFingerprint: '4'.repeat(64),
  sourceRows: 2,
  indexBytes: 0,
  files: [
    { path: 'manifest.json', bytes: 2, sha256: '2'.repeat(64), etag: 'manifest' },
    { path: 'checksums.json', bytes: 2, sha256: '3'.repeat(64), etag: 'checksums' },
  ],
})
const user = (db: D1Database, id = 1) =>
  db
    .prepare(
      `INSERT INTO users(id,first_name,last_name,manager_grants,created_at,updated_at) VALUES(?,'Safe','Fixture','[]',?,?)`,
    )
    .bind(id, now, now)
const lease = async (db: D1Database, id: string) => {
  const at = Date.parse(now)
  await db
    .prepare(
      `INSERT INTO _ezacto_load_lease(singleton,holder,fence,claimed_at,expires_at,snapshot_sha256,manifest_sha256,source_fingerprint)
    VALUES(1,'fixture-holder',1,?,?, ?,?,?)`,
    )
    .bind(at, at + 300000, '1'.repeat(64), '2'.repeat(64), '4'.repeat(64))
    .run()
  return { holder: 'fixture-holder', fence: 1, now: () => at, runId: id }
}
it('[concurrency #409] target reservation serializes competing imports and bootstrap', async () => {
  const { db, store } = await setup(),
    input = catalog()
  await store.create(input, {}, now)
  expect(await store.blocked()).toBe(true)
  await expect(store.create(catalog(), {}, now)).rejects.toThrow()
  await expect(user(db).run()).rejects.toThrow('migration_in_progress')
  await expect(
    db
      .prepare(
        `UPDATE migration_loads SET options_json='{"organizationCurrency":"EUR"}' WHERE id=?`,
      )
      .bind(input.jobId)
      .run(),
  ).rejects.toThrow('migration_input_immutable')
  await store.cancel(input.jobId, now)
  expect(await store.blocked()).toBe(false)
  await user(db).run()
  await expect(store.create(catalog(), {}, now)).rejects.toThrow('migration_destination_not_empty')
})
it('[crash #409] checkpoint retains the next intent before queue publication and ignores old deliveries', async () => {
  const { db, store } = await setup(),
    input = catalog()
  await store.create(input, {}, now)
  const message = await store.start(input.jobId, now)
  expect(await store.start(input.jobId, now)).toEqual(message)
  expect(await store.begin(message, now)).toBe(true)
  const authority = await lease(db, input.jobId)
  await store.guarded(input.jobId, authority, [user(db)])
  expect(await db.prepare('SELECT 1 FROM _ezacto_migration_write_context').first()).toBeNull()
  const next = await store.checkpoint(
    message,
    authority,
    { resource: 'users', rowsDone: 1, complete: false },
    now,
  )
  expect(next?.sequence).toBe(1)
  // A fresh process sees the committed intent even though send()/sent() never happened.
  const replacement = createQueuedMigrationStore(db)
  expect(await replacement.pending(input.jobId)).toEqual(next)
  expect(await replacement.begin(message, now)).toBe(false)
  expect(await replacement.status(input.jobId)).toMatchObject({
    status: 'queued',
    rowsDone: 1,
    sequence: 1,
    attempts: 1,
  })
  await replacement.cancel(input.jobId, now)
  expect(await replacement.blocked()).toBe(true)
  await expect(user(db, 2).run()).rejects.toThrow('migration_in_progress')
  await expect(replacement.guarded(input.jobId, authority, [user(db, 2)])).rejects.toThrow()
  expect(await db.prepare('SELECT count(*) AS total FROM users').first('total')).toBe(1)
})
it('[crash #409] stale leases and failed batches write neither rows nor persistent authority', async () => {
  const { db, store } = await setup(),
    input = catalog()
  await store.create(input, {}, now)
  await store.begin(await store.start(input.jobId, now), now)
  const authority = await lease(db, input.jobId)
  await expect(store.guarded(input.jobId, authority, [user(db), user(db)])).rejects.toThrow()
  expect(await db.prepare('SELECT count(*) AS total FROM users').first('total')).toBe(0)
  expect(await db.prepare('SELECT 1 FROM _ezacto_migration_write_context').first()).toBeNull()
  await db.prepare('UPDATE _ezacto_load_lease SET fence=2').run()
  await expect(store.guarded(input.jobId, authority, [user(db)])).rejects.toThrow()
  expect(await db.prepare('SELECT count(*) AS total FROM users').first('total')).toBe(0)
})
