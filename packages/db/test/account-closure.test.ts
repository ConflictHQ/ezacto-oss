import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { createAccountDeletionStatusRepository } from '../src/account-deletion-status.js'
import { createAccountClosureRepository } from '../src/account-closure.js'
import { createAccountDeletionRequestRepository } from '../src/account-deletion-requests.js'
import { createAccountRetentionRepository } from '../src/account-retention.js'
import { createContainerIdentityStore, createD1IdentityStore } from '../src/identity.js'
import {
  createContainerSessionStore,
  createD1SessionStore,
  type SessionStore,
} from '../src/sessions.js'
import {
  createContainerStaffMagicLinkStore,
  createD1StaffMagicLinkStore,
  type StaffMagicLinkStore,
} from '../src/staff-magic-links.js'
import {
  createContainerOidcAppCodeStore,
  createD1OidcAppCodeStore,
  type OidcAppCodeStore,
} from '../src/oidc-app-codes.js'
import { issueApiToken, authenticateApiToken } from '../src/api-tokens.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
const at = '2026-10-09T00:00:00.000Z'
const later = '2026-10-09T01:00:00.000Z'
const policy = {
  frameworks: [],
  retained_records: [
    {
      category: 'audit_and_security',
      reason: 'Keep the minimal request and security evidence for dispute handling.',
      period: 'One year after closure, then review deletion.',
      review_after_days: 30,
    },
  ],
  response_target_days: 14,
  operator_contact: 'privacy@example.test',
  user_notice: 'Operator-reviewed closure.',
  backup_handling: 'Replay closure evidence before restored access.',
  acknowledged: true,
}
for (const runtime of ['SQLite', 'D1'])
  describe(`account closure (${runtime})`, () => {
    let dispose: (() => Promise<void>) | undefined
    afterEach(async () => dispose?.())
    async function setup() {
      let db: Parameters<typeof createAccountClosureRepository>[0]
      let exec: (query: string) => Promise<unknown>
      let rows: (query: string) => Promise<Record<string, unknown>[]>
      let sessions: SessionStore
      let magic: StaffMagicLinkStore
      let codes: OidcAppCodeStore
      let identity: ReturnType<typeof createContainerIdentityStore>
      if (runtime === 'SQLite') {
        const sqlite = new BetterSqlite3(':memory:')
        migrateContainer(sqlite)
        db = createContainerDatabase(sqlite)
        exec = async (query) => sqlite.exec(query)
        rows = async (query) => sqlite.prepare(query).all() as Record<string, unknown>[]
        sessions = createContainerSessionStore(sqlite, { now: () => at })
        magic = createContainerStaffMagicLinkStore(sqlite)
        codes = createContainerOidcAppCodeStore(sqlite)
        identity = createContainerIdentityStore(sqlite, { now: () => later })
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
        await migrateD1(binding)
        db = createD1Database(binding)
        exec = async (query) => binding.prepare(query).run()
        rows = async (query) =>
          (await binding.prepare(query).all<Record<string, unknown>>()).results
        sessions = createD1SessionStore(binding, { now: () => at })
        magic = createD1StaffMagicLinkStore(binding)
        codes = createD1OidcAppCodeStore(binding)
        identity = createD1IdentityStore(binding, { now: () => later })
      }
      await exec(`INSERT INTO users(id,first_name,last_name,profile,is_active,manager_grants,telephone,employee_id,avatar_url,created_at,updated_at) VALUES
      (1,'Ada','Owner','administrator',1,'[]',NULL,NULL,NULL,'${at}','${at}'),
      (2,'Pat','Person','member',1,'[]','5551234','employee-2','https://example.test/pat.png','${at}','${at}'),
      (3,'Jo','Else','member',1,'[]',NULL,NULL,NULL,'${at}','${at}')`)
      await exec(
        `INSERT INTO user_emails(id,user_id,address,verified_at,is_primary,created_at,updated_at) VALUES(2,2,'pat@example.test','${at}',1,'${at}','${at}')`,
      )
      await exec(
        `INSERT INTO user_identities(user_id,provider,provider_subject,created_at,updated_at) VALUES(2,'apple','apple-pat','${at}','${at}')`,
      )
      await exec(
        `INSERT INTO sso_provisioning_domains(domain,challenge_token,verified_at,last_checked_at,created_at,updated_at) VALUES('example.test','${'A'.repeat(32)}','${at}','${at}','${at}','${at}')`,
      )
      const policies = createAccountRetentionRepository(db)
      await policies.publish({ actorUserId: 1, expectedVersion: 0, policy, now: at })
      const requests = createAccountDeletionRequestRepository(db)
      await requests.request({ userId: 2, id: 'close-pat', now: at, expectedPolicyVersion: 1 })
      return {
        db,
        exec,
        rows,
        identity,
        sessions,
        magic,
        codes,
        policies,
        requests,
        closure: createAccountClosureRepository(db),
        tracking: createAccountDeletionStatusRepository(db),
      }
    }
    it('[privacy #1200] inventories both Wise delivery ledgers as linked billing evidence', async () => {
      const { closure, exec } = await setup()
      await exec(`INSERT INTO user_payout_accounts(id,user_id,provider,external_id,linked_by_user_id,linked_at,verified_at,created_at,updated_at)
        VALUES(1,2,'wise','synthetic-recipient',1,'${at}','${at}','${at}','${at}')`)
      await exec(`INSERT INTO payout_transfers(id,user_id,period_start,period_end,payout_account_id,amount_cents,currency,state,external_transfer_id,created_at,updated_at)
        VALUES(1,2,'2026-09-01','2026-09-30',1,1000,'USD','planned','synthetic-transfer','${at}','${at}')`)
      for (const table of ['wise_webhook_deliveries', 'wise_signed_webhook_deliveries'])
        await exec(`INSERT INTO ${table}(delivery_id,subscription_id,event_type,transfer_id,current_state,received_at)
          VALUES('same-key','synthetic-subscription','transfers#state-change','synthetic-transfer','processing','${at}')`)
      const preview = await closure.preview(1, 'close-pat')
      expect(preview.inventory).toContainEqual({
        location: 'wise_all_webhook_deliveries.transfer_id', count: 2, category: 'billing_and_payments',
      })
      expect(preview.uncovered_categories).toContain('billing_and_payments')
    })

    it('[privacy #42] inventories suppressed recipient addresses and retains reviewed delivery evidence on closure', async () => {
      const { closure, exec, rows } = await setup()
      await exec(`INSERT INTO email_log(id,from_json,to_json,template,subject,status,created_at,updated_at)
    VALUES(1,'{"email":"billing@example.test"}','[{"email":"pat@example.test"}]','verify_email','Fixture','queued','${at}','${at}')`)
      await exec(`INSERT INTO email_feedback_events(event_id,signature_token,event_type,severity,recipient,provider_message_id,delivery_id,received_at)
    VALUES('privacy-feedback','privacy-token','failed','permanent','pat@example.test','privacy-message',1,'${at}')`)
      await exec(
        `UPDATE email_feedback_events SET processed_at='${at}',outcome='bounced' WHERE event_id='privacy-feedback'`,
      )
      await exec(`INSERT INTO email_suppression_lifts(address,through_event_id,actor_user_id,note,complaint_acknowledged,lifted_at)
    VALUES('pat@example.test',1,1,'Recipient verified address',0,'${at}')`)
      const preview = await closure.preview(1, 'close-pat')
      expect(preview.inventory).toEqual(
        expect.arrayContaining([
          { location: 'email_suppression_events.address', count: 1, category: 'audit_and_security' },
          { location: 'email_suppression_lifts.address', count: 1, category: 'audit_and_security' },
        ]),
      )
      await closure.close({
        actorUserId: 1,
        id: 'close-pat',
        reviewToken: preview.review_token,
        expectedVersion: 1,
        expectedPolicyVersion: 1,
        now: later,
        acknowledged: true,
      })
      expect(await rows('SELECT address FROM user_emails WHERE user_id=2')).toEqual([])
      expect(await rows('SELECT address FROM email_suppression_events')).toEqual([
        { address: 'pat@example.test' },
      ])
      expect(await rows('SELECT note FROM email_suppression_lifts')).toEqual([
        { note: 'Recipient verified address' },
      ])
    })

    it('erases optional profile and linked identities while preserving honest residual status and denying SSO replay', async () => {
      const { closure, rows, exec, identity, requests } = await setup()
      const preview = await closure.preview(1, 'close-pat')
      expect(preview).toMatchObject({
        request_version: 1,
        policy_version: 1,
        uncovered_categories: [],
        owner_transfer_required: false,
      })
      const input = {
        actorUserId: 1,
        id: 'close-pat',
        reviewToken: (await closure.preview(1, 'close-pat')).review_token,
        expectedVersion: 1,
        expectedPolicyVersion: 1,
        now: later,
        acknowledged: true as const,
      }
      const result = await closure.close(input)
      expect(result).toMatchObject({
        user_id: 2,
        retained_identity: false,
        apple_cleanup: 'pending',
        closed_at: later,
      })
      expect(
        await rows(
          'SELECT first_name,last_name,is_active,telephone,employee_id,avatar_url FROM users WHERE id=2',
        ),
      ).toEqual([
        {
          first_name: 'Closed',
          last_name: 'account',
          is_active: 0,
          telephone: null,
          employee_id: null,
          avatar_url: null,
        },
      ])
      expect(await rows('SELECT * FROM user_emails WHERE user_id=2')).toEqual([])
      expect(await rows('SELECT * FROM user_identities WHERE user_id=2')).toEqual([])
      expect(await rows('SELECT kind FROM closed_account_sign_in_guards ORDER BY kind')).toEqual([
        { kind: 'email' },
        { kind: 'provider' },
      ])
      expect(
        await identity.resolveProvider({
          provider: 'apple',
          subject: 'apple-pat',
          email: 'pat@example.test',
          emailVerified: true,
          firstName: 'Pat',
          lastName: 'Person',
        }),
      ).toEqual({ status: 'provisioning_not_permitted' })
      expect(
        await identity.resolveProvider({
          provider: 'google',
          subject: 'new-provider-pat',
          email: 'pat@example.test',
          emailVerified: true,
          firstName: 'Pat',
          lastName: 'Person',
        }),
      ).toEqual({ status: 'provisioning_not_permitted' })
      expect(
        await identity.resolveProvider({
          provider: 'apple',
          subject: 'apple-pat',
          email: 'changed@example.test',
          emailVerified: true,
          firstName: 'Pat',
          lastName: 'Person',
        }),
      ).toEqual({ status: 'provisioning_not_permitted' })
      expect(await rows('SELECT id FROM users ORDER BY id')).toHaveLength(3)
      expect(await identity.resolveEmail('pat@example.test')).toEqual({
        status: 'verification_required',
      })
      await expect(exec('UPDATE users SET is_active=1 WHERE id=2')).rejects.toThrow(
        'closed account',
      )
      await expect(
        exec(
          `INSERT INTO user_identities(user_id,provider,provider_subject,created_at,updated_at) VALUES(2,'google','late-callback','${later}','${later}')`,
        ),
      ).rejects.toThrow('closed account')
      expect(await closure.close(input)).toEqual(result)
      expect(await requests.readAdmin(1, 'close-pat')).toMatchObject({
        status: 'action_required',
        completed_at: null,
        version: 2,
      })
      expect(await rows('SELECT is_active,first_name FROM users WHERE id=3')).toEqual([
        { is_active: 1, first_name: 'Jo' },
      ])
    })
    it('erases the closed person’s calendar proposals (issue 428) and nobody else’s', async () => {
      const { closure, rows, exec } = await setup()
      // A meeting title is personal data and is not time worked, so unlike an
      // accepted time entry it is not retained for attribution.
      await exec(
        `INSERT INTO calendar_proposals(user_id,provider,calendar_id,event_id,title,starts_at,ends_at,created_at,updated_at) VALUES
        (2,'google','primary','e1','Pat’s 1:1','2026-10-08T14:00:00.000Z','2026-10-08T15:00:00.000Z','${at}','${at}'),
        (3,'google','primary','e1','Jo’s 1:1','2026-10-08T14:00:00.000Z','2026-10-08T15:00:00.000Z','${at}','${at}')`,
      )
      const preview = await closure.preview(1, 'close-pat')
      expect(JSON.stringify(preview)).not.toContain('calendar_proposals')
      await closure.close({
        actorUserId: 1,
        id: 'close-pat',
        reviewToken: preview.review_token,
        expectedVersion: 1,
        expectedPolicyVersion: 1,
        now: later,
        acknowledged: true as const,
      })
      expect(await rows('SELECT user_id,title FROM calendar_proposals ORDER BY id')).toEqual([
        { user_id: 3, title: 'Jo’s 1:1' },
      ])
    })
    it('erases the closed person’s planned allocations (issue 1007) and nobody else’s', async () => {
      const { closure, rows, exec } = await setup()
      // A plan for someone who has left is moot and is not time worked.
      for (const query of [
        `INSERT INTO clients(id,name,currency,created_at,updated_at) VALUES(1,'QA Client','USD','${at}','${at}')`,
        `INSERT INTO projects(id,client_id,name,created_at,updated_at) VALUES(1,1,'QA Project','${at}','${at}')`,
        `INSERT INTO allocations(user_id,project_id,start_date,end_date,planned_seconds_per_week,created_at,updated_at) VALUES
        (2,1,'2026-10-05','2026-10-25',57600,'${at}','${at}'),
        (3,1,'2026-10-05','2026-10-25',57600,'${at}','${at}')`,
      ])
        await exec(query)
      const preview = await closure.preview(1, 'close-pat')
      expect(JSON.stringify(preview)).not.toContain('allocations')
      await closure.close({
        actorUserId: 1,
        id: 'close-pat',
        reviewToken: preview.review_token,
        expectedVersion: 1,
        expectedPolicyVersion: 1,
        now: later,
        acknowledged: true as const,
      })
      expect(await rows('SELECT user_id FROM allocations ORDER BY id')).toEqual([{ user_id: 3 }])
    })
    it('erases the closed person’s time off (issue 1007) and nobody else’s', async () => {
      const { closure, rows, exec } = await setup()
      await exec(
        `INSERT INTO time_off(user_id,start_date,end_date,kind,created_at,updated_at) VALUES
        (2,'2026-10-12','2026-10-14','vacation','${at}','${at}'),
        (3,'2026-10-12','2026-10-14','vacation','${at}','${at}')`,
      )
      const preview = await closure.preview(1, 'close-pat')
      expect(JSON.stringify(preview)).not.toContain('time_off')
      await closure.close({
        actorUserId: 1,
        id: 'close-pat',
        reviewToken: preview.review_token,
        expectedVersion: 1,
        expectedPolicyVersion: 1,
        now: later,
        acknowledged: true as const,
      })
      expect(await rows('SELECT user_id FROM time_off ORDER BY id')).toEqual([{ user_id: 3 }])
    })
    it('removes every local secret and refuses already-issued session, API, email and app-handoff credentials', async () => {
      const { closure, db, rows, exec, sessions, magic, codes } = await setup()
      const session = await sessions.issue(2)
      const token = await issueApiToken(db, {
        userId: 2,
        name: 'Disposable QA token',
        scopes: ['time_entries:read'],
        createdAt: at,
      })
      const hash = 'a'.repeat(64)
      const expires = '2026-10-10T00:00:00.000Z'
      const link = {
        userId: 2,
        tokenHash: hash,
        codeHash: hash,
        flow: 'app' as const,
        createdAt: at,
        expiresAt: expires,
        cleanupBefore: '2026-10-08T00:00:00.000Z',
      }
      const code = {
        userId: 2,
        provider: 'apple',
        codeHash: hash,
        createdAt: at,
        expiresAt: expires,
        cleanupBefore: '2026-10-08T00:00:00.000Z',
      }
      await magic.create(link)
      await codes.create(code)
      await exec(
        `INSERT INTO user_passwords(user_id,credential_version,algorithm,iterations,salt,password_hash,created_at,updated_at) VALUES(2,1,'pbkdf2-sha256',600000,'${'B'.repeat(22)}','${'C'.repeat(43)}','${at}','${at}')`,
      )
      await exec(
        `INSERT INTO auth_tokens(selector,secret_hash,kind,user_email_id,expires_at,created_at,updated_at) VALUES('AAAAAAAAAAAAAAAA','${hash}','password_reset',2,'${expires}','${at}','${at}')`,
      )
      await exec(
        `INSERT INTO two_factor_challenges(user_id,token_hash,expires_at,created_at,updated_at) VALUES(2,'${hash}','${expires}','${at}','${at}')`,
      )
      await exec(
        `INSERT INTO user_totp_enrolments(user_id,secret,created_at,updated_at) VALUES(2,'${'A'.repeat(32)}','${at}','${at}')`,
      )
      await exec(
        `INSERT INTO user_recovery_codes(user_id,selector,algorithm,version,memory_kib,time_cost,parallelism,salt,code_hash,created_at,updated_at) VALUES(2,'AAAAAAAA','argon2id',19,19456,2,1,'${'B'.repeat(22)}','${'C'.repeat(43)}','${at}','${at}')`,
      )
      await exec(
        `INSERT INTO user_email_second_factors(user_id,enabled_at) VALUES(2,'${at}')`,
      )
      await exec(
        `INSERT INTO two_factor_email_code_sends(user_id,sent_at) VALUES(2,'${at}')`,
      )
      expect(await sessions.authenticate(session.token)).not.toBeNull()
      expect(await authenticateApiToken(db, token.token, at)).not.toBeNull()
      await closure.close({
        actorUserId: 1,
        id: 'close-pat',
        reviewToken: (await closure.preview(1, 'close-pat')).review_token,
        expectedVersion: 1,
        expectedPolicyVersion: 1,
        now: later,
        acknowledged: true,
      })
      for (const table of [
        'sessions',
        'api_tokens',
        'user_passwords',
        'auth_tokens',
        'staff_magic_links',
        'oidc_app_codes',
        'two_factor_challenges',
        'user_totp_enrolments',
        'user_recovery_codes',
        'user_email_second_factors',
        'two_factor_email_code_sends',
      ])
        expect(await rows(`SELECT * FROM ${table}`), table).toEqual([])
      // A closed account is not handed the emailed factor afterwards either.
      await expect(
        exec(`INSERT INTO user_email_second_factors(user_id,enabled_at) VALUES(2,'${later}')`),
      ).rejects.toThrow('closed account')
      expect(await sessions.authenticate(session.token)).toBeNull()
      expect(await authenticateApiToken(db, token.token, later)).toBeNull()
      expect(await magic.consumeByToken(hash, later)).toBeNull()
      expect(await magic.consumeByCode(2, hash, later, 5)).toBeNull()
      expect(await codes.consume(hash, later)).toBeNull()
      await expect(magic.create(link)).rejects.toThrow('closed account')
      await expect(codes.create(code)).rejects.toThrow('closed account')
      await expect(
        issueApiToken(db, {
          userId: 2,
          name: 'Late token',
          scopes: ['time_entries:read'],
          createdAt: later,
        }),
      ).rejects.toThrow()
    })
    it('requires explicit retention decisions and preserves identified work and payment history', async () => {
      const { closure, exec, rows, policies } = await setup()
      for (const query of [
        `INSERT INTO organizations(id,name,modules,created_at,updated_at) VALUES(1,'QA','{}','${at}','${at}')`,
        `INSERT INTO clients(id,name,currency,created_at,updated_at) VALUES(1,'QA Client','USD','${at}','${at}')`,
        `INSERT INTO projects(id,client_id,name,created_at,updated_at) VALUES(1,1,'QA Project','${at}','${at}')`,
        `INSERT INTO tasks(id,name,created_at,updated_at) VALUES(1,'QA Work','${at}','${at}')`,
        `INSERT INTO user_assignments(id,project_id,user_id,created_at,updated_at) VALUES(1,1,2,'${at}','${at}')`,
        `INSERT INTO task_assignments(id,project_id,task_id,billable,created_at,updated_at) VALUES(1,1,1,1,'${at}','${at}')`,
        `INSERT INTO time_entries(id,user_id,project_id,task_id,user_assignment_id,task_assignment_id,spent_date,seconds,seconds_without_timer,rounded_seconds,billable,created_at,updated_at) VALUES(1,2,1,1,1,1,'2026-10-08',3600,3600,3600,1,'${at}','${at}')`,
        `INSERT INTO staff_payment_events(id,user_id,month,version,kind,command_json,actor_id,recorded_at,request_id) VALUES('qa-payment',2,'2026-10',1,'opening','{"currency":"USD","amount_cents":5000}',1,'${at}','qa-record-payment')`,
      ])
        await exec(query)
      const input = {
        actorUserId: 1,
        id: 'close-pat',
        reviewToken: (await closure.preview(1, 'close-pat')).review_token,
        expectedVersion: 1,
        expectedPolicyVersion: 1,
        now: later,
        acknowledged: true as const,
      }
      expect((await closure.preview(1, 'close-pat')).uncovered_categories.sort()).toEqual([
        'billing_and_payments',
        'time_and_worker_attribution',
      ])
      await expect(closure.close(input)).rejects.toMatchObject({
        code: 'retention_review_required',
      })
      await policies.publish({
        actorUserId: 1,
        expectedVersion: 1,
        now: later,
        policy: {
          ...policy,
          retained_records: [
            ...policy.retained_records,
            {
              category: 'time_and_worker_attribution',
              reason: 'Identify the person who performed the invoiced work.',
              period: 'Until invoice disputes are settled, review annually.',
              review_after_days: 90,
            },
            {
              category: 'billing_and_payments',
              reason: 'Support settlement and reconciliation of this worker payment.',
              period: 'Until settlement evidence is released under the operator schedule.',
              review_after_days: 90,
            },
          ],
        },
      })
      const before = await rows('SELECT * FROM time_entries')
      const payment = await rows('SELECT * FROM staff_payment_events')
      await exec(`UPDATE time_entries SET timer_started_at='${at}' WHERE id=1`)
      await expect(closure.close({ ...input, expectedPolicyVersion: 2 })).rejects.toMatchObject({
        code: 'running_timer',
      })
      await exec('UPDATE time_entries SET timer_started_at=NULL WHERE id=1')
      const result = await closure.close({
        ...input,
        expectedPolicyVersion: 2,
        reviewToken: (await closure.preview(1, 'close-pat')).review_token,
      })
      expect(result.retained_identity).toBe(true)
      expect(await rows('SELECT first_name,last_name FROM users WHERE id=2')).toEqual([
        { first_name: 'Pat', last_name: 'Person' },
      ])
      expect(await rows('SELECT * FROM time_entries')).toEqual(before)
      expect(await rows('SELECT * FROM staff_payment_events')).toEqual(payment)
      await expect(
        exec(`UPDATE time_entries SET timer_started_at='${later}' WHERE id=1`),
      ).rejects.toThrow('closed account')
      await expect(
        exec("UPDATE users SET telephone='new personal data' WHERE id=2"),
      ).rejects.toThrow('closed account')
    })
    it('binds acknowledgement to the reviewed inventory, person and linked identities', async () => {
      const { closure, exec } = await setup()
      for (const change of [
        `UPDATE users SET first_name='Updated',version=version+1 WHERE id=2`,
        `UPDATE user_identities SET provider_subject='changed-subject' WHERE user_id=2`,
        `INSERT INTO staff_payment_events(id,user_id,month,version,kind,command_json,actor_id,recorded_at,request_id) VALUES('late-row',2,'2026-10',1,'opening','{}',1,'${at}','late-row')`,
      ]) {
        const preview = await closure.preview(1, 'close-pat')
        await exec(change)
        await expect(
          closure.close({
            actorUserId: 1,
            id: 'close-pat',
            expectedVersion: preview.request_version,
            expectedPolicyVersion: 1,
            reviewToken: preview.review_token,
            now: later,
            acknowledged: true,
          }),
        ).rejects.toMatchObject({ code: 'concurrent_change' })
      }
    })
    it('keeps minimal request tracking after access closure without retaining a workspace credential', async () => {
      const { closure, tracking, rows, exec, requests } = await setup()
      const access = await tracking.issue({ requestId: 'close-pat', userId: 2, now: at })
      expect(access.token).toMatch(/^ezacto_deletion_[0-9a-f]{64}$/)
      expect(
        JSON.stringify(await rows('SELECT * FROM account_deletion_status_access')),
      ).not.toContain(access.token)
      const preview = await closure.preview(1, 'close-pat')
      await closure.close({
        actorUserId: 1,
        id: 'close-pat',
        expectedVersion: 1,
        expectedPolicyVersion: 1,
        reviewToken: preview.review_token,
        now: later,
        acknowledged: true,
      })
      expect(await requests.readOwn(2)).toBeNull()
      const status = await tracking.read({
        requestId: 'close-pat',
        token: access.token,
        now: later,
      })
      expect(status).toMatchObject({
        request_id: 'close-pat',
        status: 'action_required',
        closed_at: later,
        completed_at: null,
        operator_contact: 'privacy@example.test',
      })
      expect(status).not.toHaveProperty('user_id')
      expect(status).not.toHaveProperty('inventory')
      expect(status).not.toHaveProperty('apple_cleanup')
      expect(
        await tracking.read({ requestId: 'different-request', token: access.token, now: later }),
      ).toBeNull()
      expect(
        await tracking.read({
          requestId: 'close-pat',
          token: access.token,
          now: '2027-01-08T00:00:00.000Z',
        }),
      ).toBeNull()
      await exec(
        `UPDATE account_deletion_requests SET status='completed',completed_at='${later}',completion_confirmation='Local closure and residual retention review confirmed.' WHERE id='close-pat'`,
      )
      expect(
        (await tracking.read({ requestId: 'close-pat', token: access.token, now: later }))
          ?.expires_at,
      ).toBe('2026-11-08T01:00:00.000Z')
      expect(
        await tracking.read({
          requestId: 'close-pat',
          token: access.token,
          now: '2026-11-09T00:00:00.000Z',
        }),
      ).toBeNull()
      expect(
        await rows("SELECT replay_keys FROM account_closures WHERE request_id='close-pat'"),
      ).toEqual([{ replay_keys: '[]' }])
    })
    it('bounds recovery capabilities and request tracking load without modifying the request disclosure', async () => {
      const { tracking, rows, exec, requests } = await setup()
      const initial = await requests.readOwn(2)
      const first = await tracking.issue({ requestId: 'close-pat', userId: 2, now: at })
      for (let index = 0; index < 5; index += 1)
        await tracking.issue({ requestId: 'close-pat', userId: 2, now: at })
      expect(await rows('SELECT id FROM account_deletion_status_access')).toHaveLength(5)
      expect(
        await tracking.read({ requestId: 'close-pat', token: first.token, now: later }),
      ).toBeNull()
      expect(await requests.readOwn(2)).toEqual(initial)
      expect(await tracking.allowRead(at)).toBe(true)
      await exec('UPDATE account_deletion_status_limits SET attempts=600')
      expect(await tracking.allowRead(at)).toBe(false)
      expect(await tracking.allowRead(later)).toBe(true)
      expect(await rows('SELECT * FROM account_deletion_status_limits')).toHaveLength(1)
    })
    it('refuses identity changes after inspection without accepting an unreviewed second snapshot', async () => {
      const { db, rows, closure } = await setup()
      const preview = await closure.preview(1, 'close-pat')
      const client = (db as unknown as { $client: BetterSqlite3.Database | D1Database }).$client
      let changed = false
      const mutate =
        "UPDATE user_identities SET provider_subject='changed-after-inspection' WHERE user_id=2"
      const proxy = new Proxy(client, {
        get(target, key) {
          if (key === 'prepare')
            return (query: string) => {
              const statement = target.prepare(query)
              if (!query.startsWith("SELECT json_object('identities'")) return statement
              if ('batch' in target)
                return {
                  bind(...values: unknown[]) {
                    const bound = (statement as D1PreparedStatement).bind(...values)
                    return {
                      async all() {
                        const result = await bound.all()
                        if (!changed) {
                          changed = true
                          await target.prepare(mutate).run()
                        }
                        return result
                      },
                    }
                  },
                }
              return new Proxy(statement, {
                get(original, field) {
                  if (field === 'all')
                    return (...values: unknown[]) => {
                      const result = (original as BetterSqlite3.Statement).all(...values)
                      if (!changed) {
                        changed = true
                        target.exec(mutate)
                      }
                      return result
                    }
                  const value = Reflect.get(original, field)
                  return typeof value === 'function' ? value.bind(original) : value
                },
              })
            }
          const value = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      const racing = createAccountClosureRepository({ $client: proxy } as unknown as typeof db)
      await expect(
        racing.close({
          actorUserId: 1,
          id: 'close-pat',
          expectedVersion: 1,
          expectedPolicyVersion: 1,
          reviewToken: preview.review_token,
          now: later,
          acknowledged: true,
        }),
      ).rejects.toMatchObject({ code: 'concurrent_change' })
      expect(changed).toBe(true)
      expect(await rows('SELECT request_id FROM account_closures')).toEqual([])
      expect(await rows('SELECT is_active FROM users WHERE id=2')).toEqual([{ is_active: 1 }])
      expect(await rows('SELECT provider_subject FROM user_identities WHERE user_id=2')).toEqual([
        { provider_subject: 'changed-after-inspection' },
      ])
    })
    it.runIf(runtime === 'SQLite')(
      'returns a conflict and preserves access if ownership transfers after review but before the closure write',
      async () => {
        const { db, rows, closure } = await setup()
        const preview = await closure.preview(1, 'close-pat')
        const client = (db as unknown as { $client: BetterSqlite3.Database }).$client
        const proxy = new Proxy(client, {
          get(target, key) {
            if (key === 'prepare')
              return (query: string) => {
                if (query.startsWith('INSERT INTO account_closures'))
                  target.exec('UPDATE organization_owner SET user_id=2')
                return target.prepare(query)
              }
            const value = Reflect.get(target, key)
            return typeof value === 'function' ? value.bind(target) : value
          },
        })
        const racing = createAccountClosureRepository({ $client: proxy } as unknown as typeof db)
        await expect(
          racing.close({
            actorUserId: 1,
            id: 'close-pat',
            expectedVersion: 1,
            expectedPolicyVersion: 1,
            reviewToken: preview.review_token,
            now: later,
            acknowledged: true,
          }),
        ).rejects.toMatchObject({ code: 'concurrent_change' })
        expect(await rows('SELECT request_id FROM account_closures')).toEqual([])
        expect(await rows('SELECT is_active,is_owner FROM users WHERE id=2')).toEqual([
          { is_active: 1, is_owner: 1 },
        ])
        expect(await rows('SELECT id FROM user_emails WHERE user_id=2')).toHaveLength(1)
      },
    )
    it('requires active administrator, current request and policy, and owner succession before mutation', async () => {
      const { closure, requests, rows } = await setup()
      const input = {
        actorUserId: 1,
        id: 'close-pat',
        reviewToken: (await closure.preview(1, 'close-pat')).review_token,
        expectedVersion: 1,
        expectedPolicyVersion: 1,
        now: later,
        acknowledged: true as const,
      }
      await expect(closure.close({ ...input, actorUserId: 3 })).rejects.toMatchObject({
        code: 'administrator_required',
      })
      await expect(closure.close({ ...input, expectedVersion: 2 })).rejects.toMatchObject({
        code: 'stale_request',
      })
      await expect(closure.close({ ...input, expectedPolicyVersion: 2 })).rejects.toMatchObject({
        code: 'stale_policy',
      })
      await requests.request({ userId: 1, id: 'close-owner', now: at, expectedPolicyVersion: 1 })
      await expect(closure.close({ ...input, id: 'close-owner' })).rejects.toMatchObject({
        code: 'owner_transfer_required',
      })
      expect(await rows('SELECT id FROM users WHERE is_active=1 ORDER BY id')).toHaveLength(3)
    })
  })
