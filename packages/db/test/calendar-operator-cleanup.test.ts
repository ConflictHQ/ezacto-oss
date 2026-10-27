import { createAccountClosureRepository } from '../src/account-closure.js'
import { afterEach, describe, expect, it } from 'vitest'
import type { CalendarOperatorCleanupReview } from '@ezacto/core'
import { calendarOperatorFixture } from './support/calendar-operator-fixture.js'
const closing: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(closing.splice(0).map((close) => close()))
})
const confirmation = (row: CalendarOperatorCleanupReview) => {
  const { status, created_at: _, provider_cleanup_in_progress: __, ...identity } = row
  void _
  void __
  return {
    ...identity,
    expected_status: status,
    evidence_reference: 'Protected cleanup ticket CAL-1316: permission removal verified.',
    confirm_provider_removed: true as const,
  }
}
for (const kind of ['sqlite', 'd1'] as const)
  describe(`operator calendar cleanup ${kind}`, () => {
    const fixture = async () => {
      const f = await calendarOperatorFixture(kind)
      closing.push(f.close)
      return f
    }
    it('requires current administrator authority and exposes only retained custody metadata', async () => {
      const f = await fixture()
      await f.seed()
      const rows = await f.store.list(f.actor)
      expect(JSON.stringify(rows)).not.toContain('PRIVATE_SEALED_GRANT')
      expect(rows.data).toHaveLength(1)
      await expect(
        f.store.list({ userId: 2, sessionId: f.member.session.id }),
      ).rejects.toMatchObject({ code: 'forbidden' })
      await f.run(
        "UPDATE sessions SET revoked_at=?,revocation_reason='user_revoked' WHERE id=?",
        f.now,
        f.actor.sessionId,
      )
      await expect(f.store.list(f.actor)).rejects.toMatchObject({ code: 'forbidden' })
    })
    it('confirms exact restored custody, preserves new grants and records immutable operator evidence', async () => {
      const f = await fixture(),
        row = await f.seed(),
        input = confirmation(row)
      await f.run(
        "INSERT INTO calendar_connections(user_id,provider,instance_nonce,generation,credential_revision,status,key_id,sealed_grant,updated_at) VALUES(3,'google',?,2,1,'connected','new-key','NEW_PRIVATE_GRANT',?)",
        f.instance,
        f.now,
      )
      const result = await f.store.confirm(f.actor, input)
      expect(result).toMatchObject({
        kind: 'operator_attestation',
        provider_verified: false,
        obligation_id: row.id,
      })
      expect(JSON.stringify(result)).not.toContain(input.evidence_reference)
      expect(await f.rows('SELECT status,sealed_grant FROM calendar_cleanup_obligations')).toEqual([
        { status: 'revoked', sealed_grant: null },
      ])
      expect(await f.rows('SELECT sealed_grant FROM calendar_connections')).toEqual([
        { sealed_grant: 'NEW_PRIVATE_GRANT' },
      ])
      expect(await f.store.confirm(f.actor, input)).toEqual(result)
      await expect(
        f.store.confirm(f.actor, {
          ...input,
          evidence_reference: 'A different protected evidence reference.',
        }),
      ).rejects.toMatchObject({ code: 'changed' })
      await expect(
        f.run("UPDATE calendar_operator_cleanup_receipts SET evidence_reference='rewritten'"),
      ).rejects.toThrow(/immutable/)
      await expect(f.run('DELETE FROM calendar_operator_cleanup_receipts')).rejects.toThrow(
        /immutable/,
      )
    })
    it('rejects every stale custody dimension, current owner custody and active provider lease', async () => {
      const f = await fixture(),
        row = await f.seed(),
        input = confirmation(row)
      for (const change of [
        { user_id: 2 },
        { instance_nonce: f.instance },
        { generation: 9 },
        { credential_revision: 9 },
        { key_id: 'another-key' },
        { request_id: 'different-request' },
        { reason: 'closure' as const },
        { review_instance: 'c'.repeat(64) },
        { expected_status: 'pending' as const },
      ])
        await expect(f.store.confirm(f.actor, { ...input, ...change })).rejects.toMatchObject({
          code: 'changed',
        })
      await f.run(
        "UPDATE calendar_cleanup_obligations SET lease_holder='worker',lease_expires_at=? WHERE id=?",
        new Date(Date.now() + 60000).toISOString(),
        row.id,
      )
      await expect(f.store.confirm(f.actor, input)).rejects.toMatchObject({ code: 'changed' })
      await f.run(
        "INSERT INTO calendar_cleanup_obligations(id,user_id,provider,instance_nonce,generation,credential_revision,key_id,sealed_grant,reason,status,created_at) VALUES('current-owner',3,'microsoft',?,1,1,'key','PRIVATE','disconnect','manual_required',?)",
        f.instance,
        f.now,
      )
      expect((await f.store.list(f.actor)).data.map((row) => row.id)).not.toContain('current-owner')
      expect(await f.rows('SELECT count(*) AS n FROM calendar_operator_cleanup_receipts')).toEqual([
        { n: 0 },
      ])
    })
    it('fences role changes, quarantine and concurrent confirmation without double receipts', async () => {
      const f = await fixture(),
        row = await f.seed(),
        input = confirmation(row)
      const results = await Promise.allSettled([
        f.store.confirm(f.actor, input),
        f.store.confirm(f.actor, input),
      ])
      expect(results.some((result) => result.status === 'fulfilled')).toBe(true)
      expect(await f.rows('SELECT count(*) AS n FROM calendar_operator_cleanup_receipts')).toEqual([
        { n: 1 },
      ])
      await f.run(
        "INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(4,'Backup','Administrator','administrator','[]',?,?)",
        f.now,
        f.now,
      )
      await f.run('UPDATE organization_owner SET user_id=4,updated_at=? WHERE id=1', f.now)
      await f.run("UPDATE users SET profile='member' WHERE id=1")
      await expect(f.store.confirm(f.actor, input)).rejects.toMatchObject({ code: 'forbidden' })
      await f.run("UPDATE users SET profile='administrator' WHERE id=1")
      const fresh = await f.sessions.issue(1)
      await f.run(
        'INSERT INTO account_restore_quarantine(id,quarantined,updated_at) VALUES(1,1,?)',
        f.now,
      )
      await expect(f.store.list({ userId: 1, sessionId: fresh.session.id })).rejects.toMatchObject({
        code: 'forbidden',
      })
    })
    it('unblocks fresh consent only after the matching restored obligation is resolved', async () => {
      const f = await fixture(),
        row = await f.seed()
      await f.run(
        "INSERT INTO calendar_connections(user_id,provider,instance_nonce,generation,credential_revision,status,updated_at) VALUES(3,'google',?,2,1,'needs_reauth',?)",
        f.old,
        f.now,
      )
      const user = { userId: 3, sessionId: (await f.sessions.issue(3)).session.id }
      const grant = { instance: f.instance, keyId: 'new-key', sealedGrant: 'NEW_PRIVATE_GRANT' }
      await expect(f.connections.connect(user, 'google', 2, grant, f.now)).rejects.toMatchObject({
        code: 'busy',
      })
      await f.store.confirm(f.actor, confirmation(row))
      await f.connections.connect(user, 'google', 2, grant, f.now)
      expect(await f.rows('SELECT status,instance_nonce FROM calendar_connections')).toEqual([
        { status: 'connected', instance_nonce: f.instance },
      ])
      expect(await f.connections.cleanupStatus(f.actor, f.now)).toMatchObject({
        revoked: 0,
        operator_confirmed: 1,
      })
    })
    it('does not attribute an old incarnation receipt to a reused subject or administrator identity', async () => {
      const f = await fixture(),
        row = await f.seed()
      await f.store.confirm(f.actor, confirmation(row))
      const policy = JSON.stringify({
        acknowledged: true,
        frameworks: [],
        retained_records: [],
        response_target_days: 14,
        operator_contact: 'privacy@example.test',
        user_notice: 'Owned fixture',
        backup_handling: 'Replay current evidence.',
      })
      await f.run(
        'INSERT INTO account_retention_policies(version,policy_json,published_by_user_id,published_at) VALUES(1,?,1,?)',
        policy,
        f.now,
      )
      for (const user of [1, 3])
        await f.run(
          'INSERT INTO account_deletion_requests(id,user_id,requested_at,notification_updated_at,updated_at) VALUES(?,?,?,?,?)',
          `inventory-${user}`,
          user,
          f.now,
          f.now,
          f.now,
        )
      const closure = createAccountClosureRepository(f.db)
      const subject = await closure.preview(1, 'inventory-3')
      expect(
        subject.inventory.some((item) => item.location === 'calendar_operator_cleanup_receipts'),
      ).toBe(false)
      const actor = await closure.preview(1, 'inventory-1')
      expect(
        actor.inventory.find((item) => item.location === 'calendar_operator_cleanup_receipts')
          ?.count,
      ).toBe(1)
      await f.run('UPDATE calendar_sync_instance SET nonce=? WHERE singleton=1', 'c'.repeat(64))
      const restoredActor = await closure.preview(1, 'inventory-1')
      expect(
        restoredActor.inventory.some(
          (item) => item.location === 'calendar_operator_cleanup_receipts',
        ),
      ).toBe(false)
    })
    it('binds closed-account and late-grant obligations to their exact closure request', async () => {
      const f = await fixture()
      await f.run(
        "INSERT INTO account_deletion_requests(id,user_id,requested_at,notification_updated_at,updated_at) VALUES('owned-close',3,?,?,?)",
        f.now,
        f.now,
        f.now,
      )
      const policy = JSON.stringify({
        acknowledged: true,
        frameworks: [],
        retained_records: [],
        response_target_days: 14,
        operator_contact: 'privacy@example.test',
        user_notice: 'Owned fixture',
        backup_handling: 'Replay current evidence.',
      })
      await f.run(
        'INSERT INTO account_retention_policies(version,policy_json,published_by_user_id,published_at) VALUES(1,?,1,?)',
        policy,
        f.now,
      )
      await f.run(
        "INSERT INTO calendar_connections(user_id,provider,instance_nonce,generation,credential_revision,status,key_id,sealed_grant,updated_at) VALUES(3,'microsoft',?,1,1,'connected','key','PRIVATE',?)",
        f.instance,
        f.now,
      )
      await f.run(
        "INSERT INTO account_closures(request_id,user_id,actor_user_id,closed_at,policy_version,policy_snapshot,inventory_json,replay_keys,retained_identity,apple_cleanup) VALUES('owned-close',3,1,?,1,?,'[]','[]',1,'not_linked')",
        f.now,
        policy,
      )
      await f.oauth.orphan(
        'late-owned-grant',
        {
          userId: 3,
          provider: 'google',
          instance: f.instance,
          generation: 2,
          credentialRevision: 1,
          keyId: 'key',
          sealedGrant: 'LATE_PRIVATE',
        },
        f.now,
      )
      const listed = (await f.store.list(f.actor)).data
      expect(listed).toHaveLength(2)
      for (const row of listed) {
        expect(row.request_id).toBe('owned-close')
        expect(row.reason).toBe('closure')
        await f.store.confirm(f.actor, confirmation(row))
      }
      expect(
        await f.rows(
          "SELECT count(*) AS n FROM calendar_operator_cleanup_receipts WHERE request_id='owned-close'",
        ),
      ).toEqual([{ n: 2 }])
    })
  })
