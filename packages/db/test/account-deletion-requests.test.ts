import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { createAccountDeletionRequestRepository } from '../src/account-deletion-requests.js'
import { createAccountRetentionRepository } from '../src/account-retention.js'
import { requestAccountDeletion } from '../src/account-deletion.js'
import {
  migrateContainer,
  migrateD1,
  migrateContainerThrough,
  migrateD1Through,
} from '../src/migrate.js'

const at = '2026-10-09T00:00:00.000Z'
const later = '2026-10-10T00:00:00.000Z'
const policy = {
  frameworks: ['gdpr'],
  retained_records: [],
  response_target_days: 14,
  operator_contact: 'privacy@example.test',
  user_notice: 'Contact this operator for closure.',
  backup_handling: 'Replay closures before restoring access.',
  acknowledged: true,
}
const seed = `INSERT INTO users (id, first_name, last_name, profile, is_active, manager_grants, created_at, updated_at)
  VALUES (1,'Ada','Admin','administrator',1,'[]','${at}','${at}'),
  (2,'Pat','Person','member',1,'[]','${at}','${at}'),
  (3,'Jo','Else','member',1,'[]','${at}','${at}')`

for (const runtime of ['SQLite', 'D1'])
  describe(`durable deletion requests (${runtime})`, () => {
    let dispose: (() => Promise<void>) | undefined
    afterEach(async () => dispose?.())
    async function setup(legacy = false) {
      let upgrade: () => Promise<void>
      let db: Parameters<typeof createAccountDeletionRequestRepository>[0]
      let exec: (text: string) => Promise<unknown>
      let rows: (text: string) => Promise<unknown[]>
      if (runtime === 'SQLite') {
        const sqlite = new BetterSqlite3(':memory:')
        if (legacy) migrateContainerThrough(sqlite, '0101_account_retention_policy')
        else migrateContainer(sqlite)
        upgrade = async () => migrateContainer(sqlite)
        db = createContainerDatabase(sqlite)
        exec = async (text) => sqlite.exec(text)
        rows = async (text) => sqlite.prepare(text).all()
        dispose = async () => {
          sqlite.close()
        }
      } else {
        const mf = new Miniflare({
          modules: true,
          script: 'export default { fetch() { return new Response("ok") } }',
          d1Databases: ['DB'],
        })
        dispose = async () => mf.dispose()
        const binding = await mf.getD1Database('DB')
        if (legacy) await migrateD1Through(binding, '0101_account_retention_policy')
        else await migrateD1(binding)
        upgrade = async () => migrateD1(binding)
        db = createD1Database(binding)
        exec = async (text) => binding.prepare(text).run()
        rows = async (text) => (await binding.prepare(text).all()).results
      }
      await exec(seed)
      return {
        upgrade,
        db,
        repository: createAccountDeletionRequestRepository(db),
        policies: createAccountRetentionRepository(db),
        exec,
        rows,
      }
    }
    it('upgrades old activity requests without inventing a historical policy or delivery result', async () => {
      const { repository, db, upgrade } = await setup(true)
      await requestAccountDeletion(db, { userId: 2, occurredAt: at, captureId: 'legacy-first' })
      await requestAccountDeletion(db, { userId: 2, occurredAt: later, captureId: 'legacy-later' })
      await upgrade()
      expect(await repository.readOwn(2)).toMatchObject({
        id: 'legacy-2',
        requested_at: at,
        policy_version: null,
        policy_snapshot: null,
        policy_reviewed: false,
        notification: 'unavailable',
        status: 'pending',
      })
    })
    it('captures exactly the reviewed policy and preserves it across edits and competing requests', async () => {
      const { repository, policies, exec } = await setup()
      await policies.publish({ expectedVersion: 0, actorUserId: 1, now: at, policy })
      const results = await Promise.all(
        ['request-a', 'request-b'].map((id) =>
          repository.request({ userId: 2, id, now: at, expectedPolicyVersion: 1 }),
        ),
      )
      expect(results.filter((item) => item.created)).toHaveLength(1)
      expect(new Set(results.map((item) => item.record.id)).size).toBe(1)
      expect(results[0]!.record).toMatchObject({
        policy_snapshot: policy,
        policy_reviewed: true,
        policy_version: 1,
        status: 'pending',
        response_target_at: '2026-10-23T00:00:00.000Z',
        expected_completion_at: null,
        completed_at: null,
      })
      await policies.publish({
        expectedVersion: 1,
        actorUserId: 1,
        now: later,
        policy: { ...policy, user_notice: 'New disclosure.' },
      })
      expect(
        (await repository.request({ userId: 2, id: 'retry', now: later, expectedPolicyVersion: 2 }))
          .record,
      ).toEqual(results[0]!.record)
      await expect(
        repository.request({ userId: 3, id: 'stale', now: later, expectedPolicyVersion: 1 }),
      ).rejects.toMatchObject({ code: 'stale_policy' })
      await expect(exec('UPDATE account_deletion_requests SET policy_reviewed=0')).rejects.toThrow(
        'immutable',
      )
    })
    it('accepts unconfigured and legacy clients without inventing reviewed terms or a deadline', async () => {
      const { repository, policies } = await setup()
      const first = await repository.request({
        userId: 2,
        id: 'no-policy',
        now: at,
        expectedPolicyVersion: null,
      })
      expect(first.record).toMatchObject({
        policy_snapshot: null,
        policy_version: null,
        response_target_at: null,
        expected_completion_at: null,
      })
      await policies.publish({ expectedVersion: 0, actorUserId: 1, now: at, policy })
      const legacy = await repository.request({ userId: 3, id: 'legacy-client', now: later })
      expect(legacy.record).toMatchObject({ policy_snapshot: policy, policy_reviewed: false })
      expect(await repository.readOwn(1)).toBeNull()
    })
    it('guards operator actions at the write and records one concurrent update, never false completion', async () => {
      const { repository, exec, rows } = await setup()
      await repository.request({ userId: 2, id: 'request', now: at })
      const input = {
        id: 'request',
        actorUserId: 1,
        expectedVersion: 1,
        status: 'in_progress' as const,
        message: 'Reviewing retained time records.',
        expectedCompletionAt: null,
        now: later,
      }
      const writes = await Promise.allSettled([
        repository.update(input),
        repository.update({
          ...input,
          status: 'action_required',
          message: 'Please transfer ownership.',
        }),
      ])
      expect(writes.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
      expect(writes.find((item) => item.status === 'rejected')).toMatchObject({
        reason: { code: 'stale_request' },
      })
      expect(await rows('SELECT version FROM account_deletion_request_updates')).toEqual([
        { version: 2 },
      ])
      await expect(
        repository.update({ ...input, expectedVersion: 2, status: 'completed' as never }),
      ).rejects.toThrow('Invalid')
      await expect(repository.readAdmin(3, 'request')).rejects.toMatchObject({
        code: 'administrator_required',
      })
      await expect(repository.list(3, null)).rejects.toMatchObject({
        code: 'administrator_required',
      })
      await exec("UPDATE users SET profile='administrator' WHERE id=3")
      await exec('UPDATE users SET is_active=0 WHERE id=3')
      await expect(
        repository.update({ ...input, actorUserId: 3, expectedVersion: 2 }),
      ).rejects.toMatchObject({ code: 'administrator_required' })
    })
    it('makes notification attempts exclusive, retryable and independent from request state', async () => {
      const { repository, exec } = await setup()
      await repository.request({ userId: 2, id: 'request', now: at })
      expect(await repository.claimNotification('request', 3, at)).toBe(false)
      const claims = await Promise.all([
        repository.claimNotification('request', 2, at),
        repository.claimNotification('request', 1, at),
      ])
      expect(claims.filter(Boolean)).toHaveLength(1)
      await repository.finishNotification('request', at, 'failed', null)
      expect(await repository.readOwn(2)).toMatchObject({
        status: 'pending',
        notification: 'failed',
        version: 1,
      })
      expect(await repository.claimNotification('request', 1, later)).toBe(true)
      await repository.finishNotification('request', at, 'queued', null)
      expect(await repository.readOwn(2)).toMatchObject({ notification: 'sending' })
      await repository.finishNotification('request', later, 'unavailable', null)
      expect(await repository.readAdmin(1, 'request')).toMatchObject({
        notification: 'unavailable',
      })
      expect(await repository.list(1, null)).toHaveLength(1)
      await exec(
        `INSERT INTO email_log (id, from_json, to_json, template, subject, status, created_at, updated_at) VALUES (8, '{"email":"sender@example.test"}', '[{"email":"privacy@example.test"}]', 'account_deletion_request:v1', 'Request', 'queued', '${at}', '${at}')`,
      )
      expect(await repository.claimNotification('request', 1, later)).toBe(true)
      await repository.finishNotification('request', later, 'queued', 8)
      expect(await repository.readOwn(2)).toMatchObject({
        notification: 'queued',
        notification_delivery_id: 8,
      })
      await exec(
        "UPDATE email_log SET status='failed', failure_code='provider_rejected' WHERE id=8",
      )
      expect(await repository.readOwn(2)).toMatchObject({ notification: 'failed' })
      expect(await repository.claimNotification('request', 1, later)).toBe(true)
    })
    it('refuses inactive requests and hides status from inactive principals', async () => {
      const { repository, exec } = await setup()
      await repository.request({ userId: 2, id: 'request', now: at })
      await exec('UPDATE users SET is_active=0 WHERE id=2')
      expect(await repository.readOwn(2)).toBeNull()
      await expect(
        repository.request({ userId: 2, id: 'retry', now: later }),
      ).rejects.toMatchObject({ code: 'account_unavailable' })
    })
  })
