import { createDeelPaymentStatusStore } from '../src/deel-payment-status.js'
import { createDeelPaymentStatusRuntime } from '@ezacto/integrations'
import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDeelStagingRuntime, type DeelStageStore } from '@ezacto/integrations'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { createDeelStageStore } from '../src/deel-staging.js'
import { createDeelSyncStore } from '../src/deel-time-sync.js'
import { createStaffPaymentStore } from '../src/staff-payments.js'
import type { InvoiceStateDatabase } from '../src/invoice-state.js'
const now = '2026-10-26T12:00:00.000Z'
for (const target of ['SQLite', 'D1'] as const)
  describe(`selected Deel staging ${target}`, () => {
    let db: InvoiceStateDatabase,
      run: (s: string, ...p: unknown[]) => Promise<void>,
      rows: <T>(s: string, ...p: unknown[]) => Promise<T[]>,
      close: () => Promise<void>,
      serial = 0
    beforeAll(async () => {
      if (target === 'SQLite') {
        const raw = new BetterSqlite3(':memory:')
        migrateContainer(raw)
        db = createContainerDatabase(raw) as InvoiceStateDatabase
        run = async (s, ...p) => {
          raw.prepare(s).run(...p)
        }
        rows = async <T>(s: string, ...p: unknown[]) => raw.prepare(s).all(...p) as T[]
        close = async () => {
          raw.close()
        }
      } else {
        const mf = new Miniflare({
          modules: true,
          script: 'export default {fetch(){return new Response("ok")}}',
          d1Databases: ['DB'],
        })
        const raw = await mf.getD1Database('DB')
        await migrateD1(raw)
        db = createD1Database(raw) as InvoiceStateDatabase
        run = async (s, ...p) => {
          await raw
            .prepare(s)
            .bind(...p)
            .run()
        }
        rows = async <T>(s: string, ...p: unknown[]) =>
          (
            await raw
              .prepare(s)
              .bind(...p)
              .all<T>()
          ).results
        close = () => mf.dispose()
      }
      await run(
        "INSERT INTO organizations(name,modules,created_at,updated_at) VALUES('Owned staging fixture',?, ?,?)",
        JSON.stringify({ approval: true }),
        now,
        now,
      )
      await run(
        "INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(1,'Owned','Owner','administrator','[]',?,?)",
        now,
        now,
      )
      await run(
        "INSERT INTO clients(id,name,currency,created_at,updated_at) VALUES(1,'Fixture client','EUR',?,?)",
        now,
        now,
      )
      await run(
        "INSERT INTO projects(id,client_id,name,created_at,updated_at) VALUES(1,1,'Fixture work',?,?)",
        now,
        now,
      )
      await run(
        "INSERT INTO tasks(id,name,created_at,updated_at) VALUES(1,'Fixture task',?,?)",
        now,
        now,
      )
      await run(
        'INSERT INTO task_assignments(id,project_id,task_id,billable,created_at,updated_at) VALUES(1,1,1,0,?,?)',
        now,
        now,
      )
    }, 60000)
    afterAll(async () => close?.())
    const fixture = async () => {
      await run("UPDATE deel_status_refresh_lock SET lease_id=NULL,lease_until=NULL,cooldown_until='1970-01-01T00:00:00.000Z' WHERE id=1")
      const n = ++serial,
        a = 1000 + n,
        u = 10 + n * 10,
        v = u + 1
      for (const [id, profile] of [
        [a, 'administrator'],
        [u, 'member'],
        [v, 'member'],
      ] as const)
        await run(
          "INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(?,'Owned',?,?, '[]',?,?)",
          id,
          String(id),
          profile,
          now,
          now,
        )
      await run(
        "INSERT INTO sessions(id,user_id,selector,secret_hash,profile_snapshot,manager_grants_snapshot,created_at,last_seen_at,idle_expires_at,absolute_expires_at,updated_at) VALUES(?,?,?,?,'administrator','[]',?,?,'2026-10-27T12:00:00.000Z','2026-10-28T12:00:00.000Z',?)",
        a,
        a,
        String(a).padStart(16, 'A'),
        'a'.repeat(64),
        now,
        now,
        now,
      )
      for (const id of [u, v]) {
        await run(
          "INSERT INTO user_emails(user_id,address,kind,verified_at,created_at,updated_at) VALUES(?,?,'payroll',?,?,?)",
          id,
          `person${id}@example.test`,
          now,
          now,
          now,
        )
        await run(
          'INSERT INTO user_assignments(id,user_id,project_id,created_at,updated_at) VALUES(?,?,1,?,?)',
          id,
          id,
          now,
          now,
        )
        await run(
          "INSERT INTO staff_payment_provider_events(id,user_id,scope,version,provider,command_json,actor_id,recorded_at,request_id) VALUES(?,?,?,1,'deel','{}',1,?,?)",
          `choice${id}`,
          id,
          `user:${id}`,
          now,
          `request${id}`,
        )
      }
      const add = async (id: number, entryId: number, date = '2026-10-13', seconds = 3600) => {
        await run(
          'INSERT INTO time_entries(id,user_id,project_id,task_id,user_assignment_id,task_assignment_id,spent_date,seconds,seconds_without_timer,rounded_seconds,billable,created_at,updated_at) VALUES(?,?,1,1,?,1,?,?,?,?,0,?,?)',
          entryId,
          id,
          id,
          date,
          seconds,
          seconds,
          seconds,
          now,
          now,
        )
        const day = new Date(`${date}T00:00:00Z`)
        day.setUTCDate(day.getUTCDate() - day.getUTCDay())
        const from = day.toISOString().slice(0, 10)
        day.setUTCDate(day.getUTCDate() + 6)
        const to = day.toISOString().slice(0, 10)
        const sub = entryId + 100000
        await run(
          "INSERT INTO timesheet_submissions(id,user_id,period_start,period_end,status,submitted_by_user_id,submitted_at,version,created_at,updated_at) VALUES(?,?,?,?,'submitted',?,?,0,?,?)",
          sub,
          id,
          from,
          to,
          id,
          now,
          now,
          now,
        )
        await run(
          "UPDATE time_entries SET approval_status='submitted',timesheet_submission_id=? WHERE id=?",
          sub,
          entryId,
        )
        await run(
          "UPDATE timesheet_submissions SET status='approved',version=1,reviewed_by_user_id=1,reviewed_at=? WHERE id=?",
          now,
          sub,
        )
        await run("UPDATE time_entries SET approval_status='approved' WHERE id=?", entryId)
      }
      await add(u, u * 10)
      await add(v, v * 10, '2026-10-13', 7200)
      const posted: { contract_id: string; quantity: number }[] = []
      let loseReply = false
      let changeBeforePost = false,
        reads = 0
      const native = createDeelStageStore(db)
      const runtime = (store: DeelStageStore = native) =>
        createDeelStagingRuntime({
          token: 'owned-fixture-token',
          startDate: '2026-10-01',
          store,
          now: () => new Date(now),
          fetch: async (request) => {
            expect(new URL(request.url).origin).toBe('https://api.letsdeel.com')
            if (request.method === 'GET') {
              reads++
              return Response.json({
                data: [u, v, 999].map((id) => ({
                  id: `p${id}`,
                  full_name: `Owned ${id}`,
                  emails: [{ value: `person${id}@example.test` }],
                  employments: [
                    {
                      id: changeBeforePost && reads >= 3 ? `changed${id}` : `c${id}`,
                      contract_status: 'in_progress',
                    },
                  ],
                })),
              })
            }
            const body = (await request.json()) as {
              data: { contract_id: string; quantity: number }
            }
            posted.push(body.data)
            if (loseReply) throw new Error('owned unknown network result')
            return Response.json({ data: { id: `t${n}-${posted.length}` } })
          },
        })
      const authority = { userId: a, sessionId: a },
        selection = { from: '2026-10-01', to: '2026-10-25', userIds: [u] }
      return {
        a,
        u,
        v,
        authority,
        selection,
        posted,
        native,
        runtime,
        add,
        changeBeforePost: () => {
          changeBeforePost = true
        },
        lose: () => {
          loseReply = true
        },
      }
    }
    const addUnsubmitted = async (userId: number, entryId: number) => {
      await run(
        "INSERT INTO time_entries(id,user_id,project_id,task_id,user_assignment_id,task_assignment_id,spent_date,seconds,seconds_without_timer,rounded_seconds,billable,created_at,updated_at) VALUES(?,?,1,1,?,1,'2026-10-20',1800,1800,1800,0,?,?)",
        entryId, userId, userId, now, now,
      )
    }
    const reportingStore = async (...userIds: number[]) => {
      const store = createStaffPaymentStore(db as Parameters<typeof createStaffPaymentStore>[0])
      for (const userId of userIds) await store.configureProvider({
        id: `report-deel-${userId}`, user_id: userId, expected_version: 1,
        provider: 'deel', note: 'Fixture report preference',
      }, 1, `report-deel-${userId}`, now)
      return store
    }
    it('serializes status refreshers globally, retains cooldown and bounds the claim batch', async () => {
      const f = await fixture(), store = createDeelPaymentStatusStore(db as Parameters<typeof createDeelPaymentStatusStore>[0])
      const attempts = await Promise.all([store.acquireRefresh(now, f.authority), store.acquireRefresh(now, f.authority)])
      const held = attempts.find((result) => result.leaseId !== null)!
      expect(attempts.filter((result) => result.leaseId !== null)).toHaveLength(1)
      expect(attempts.find((result) => result.leaseId === null)?.retryAfterMs).toBe(60000)
      await store.releaseRefresh(held.leaseId!, 90000, now)
      expect((await store.acquireRefresh(new Date(Date.parse(now)+30000).toISOString(), f.authority)).retryAfterMs).toBe(60000)
      const later = new Date(Date.parse(now)+91000).toISOString(), next = await store.acquireRefresh(later, f.authority)
      expect(next.leaseId).not.toBeNull()
      expect(await store.touchRefresh(held.leaseId!, later, f.authority)).toBe(false)
      expect(await store.touchRefresh(next.leaseId!, later, f.authority)).toBe(true)
      await store.releaseRefresh(held.leaseId!, 3600000, later)
      expect(await store.touchRefresh(next.leaseId!, later, f.authority)).toBe(false)
      expect((await store.acquireRefresh(later, f.authority)).retryAfterMs).toBe(3600000)
      for (let index=0; index<12; index++) await run('INSERT INTO deel_transfer_log(entry_id,fingerprint,timesheet_id,transferred_at) VALUES(?,?,?,?)', 900000+f.u*100+index, `c${f.u}:2026-10-13:3600`, `batch-${f.u}-${index}`, now)
      const claims = await store.claim(null, later, f.authority)
      expect(claims).toHaveLength(5)
      await store.releaseClaims(claims)
      expect(await store.claim(null, later, f.authority)).toHaveLength(5)
    })
    it('refreshes authoritative paid status once, retains it on failures, and never fabricates ledger payments', async () => {
      const f = await fixture()
      await reportingStore(f.u)
      const staging = f.runtime(), preview = await staging.preview(f.authority, f.selection)
      await staging.stage(f.authority, { ...f.selection, id: crypto.randomUUID(), fingerprint: preview.fingerprint })
      let clock = new Date(now), calls = 0, fail = false, wrongContract = false
      let remoteStatus: 'paid' | 'pending' | 'declined' = 'paid'
      const status = createDeelPaymentStatusRuntime({
        token: 'owned-token', store: createDeelPaymentStatusStore(db as Parameters<typeof createDeelPaymentStatusStore>[0]),
        now: () => clock, sleep: async () => undefined, fetch: async () => { throw new Error('fake client owns reads') },
        client: { getTimesheet: async (timesheetId) => {
          calls++
          if (fail) throw new Error('unavailable')
          return { timesheetId, contractId: wrongContract ? 'wrong-contract' : `c${f.u}`, status: remoteStatus,
            providerStatus: remoteStatus, quantity: 1, totalAmount: '10.00', currency: 'EUR', spentDate: '2026-10-13' }
        } },
      })
      const report = async () => (await createStaffPaymentStore(db as Parameters<typeof createStaffPaymentStore>[0]).report('2026-10', '2026-10-26')).rows.find((row) => row.user_id === f.u)!
      expect((await report()).deel_staging).toMatchObject({ status: 'staged', unchecked_entries: 1 })
      await Promise.all([status.refresh('2026-10', f.authority), status.refresh('2026-10', f.authority)])
      expect(calls).toBe(1)
      expect(await report()).toMatchObject({ paid_cents: 0, deel_staging: {
        status: 'paid', paid_entries: 1, paid_seconds: 3600, unchecked_entries: 0, status_check_failed: false,
      } })
      clock = new Date(clock.getTime() + 61000)
      expect(await status.refresh('2026-10', f.authority)).toMatchObject({ checked: 0 })
      expect(calls).toBe(1)
      clock = new Date(clock.getTime() + 240000); fail = true
      expect(await status.refresh('2026-10', f.authority)).toMatchObject({ checked: 0, failed: 1 })
      expect((await report()).deel_staging).toMatchObject({ status: 'paid', paid_entries: 1, status_check_failed: true })
      clock = new Date(clock.getTime() + 61000); fail = false; remoteStatus = 'pending'
      await status.refresh('2026-10', f.authority)
      expect((await report()).deel_staging).toMatchObject({ status: 'staged', paid_entries: 0, status_check_failed: false })
      clock = new Date(clock.getTime() + 301000); wrongContract = true; remoteStatus = 'paid'
      expect(await status.refresh('2026-10', f.authority)).toMatchObject({ checked: 0, failed: 1 })
      expect((await report()).deel_staging).toMatchObject({ status: 'staged', paid_entries: 0, status_check_failed: true })
      clock = new Date(clock.getTime() + 61000); wrongContract = false; remoteStatus = 'declined'
      await status.refresh('2026-10', f.authority)
      expect((await report()).deel_staging).toMatchObject({ status: 'attention', rejected_entries: 1, paid_entries: 0 })
      const cache = createDeelPaymentStatusStore(db as Parameters<typeof createDeelPaymentStatusStore>[0])
      clock = new Date(clock.getTime() + 301000)
      const [oldLease] = await cache.claim('2026-10', clock.toISOString(), f.authority)
      clock = new Date(clock.getTime() + 61000)
      const [newLease] = await cache.claim('2026-10', clock.toISOString(), f.authority)
      expect(newLease!.leaseId).not.toBe(oldLease!.leaseId)
      await cache.complete(newLease!, { status: 'approved' }, clock.toISOString(), f.authority)
      await cache.complete(oldLease!, { status: 'paid' }, clock.toISOString(), f.authority)
      expect((await report()).deel_staging).toMatchObject({ status: 'staged', paid_entries: 0, approved_entries: 1 })
      await run("UPDATE sessions SET revoked_at=?,revocation_reason='user_revoked',updated_at=? WHERE id=?", clock.toISOString(), clock.toISOString(), f.a)
      await expect(status.refresh('2026-10', f.authority)).rejects.toMatchObject({ code: 'forbidden' })
      expect(await rows('SELECT * FROM staff_payment_effective_events')).toEqual([])
    })
    it('projects grouped timesheet receipts as partially paid until every staged day is paid', async () => {
      const f = await fixture(), sameDay = f.u * 10 + 1, otherDay = sameDay + 1
      await reportingStore(f.u)
      await addUnsubmitted(f.u, sameDay)
      await addUnsubmitted(f.u, otherDay)
      const staging = f.runtime(), preview = await staging.preview(f.authority, f.selection)
      await staging.stage(f.authority, { ...f.selection, id: crypto.randomUUID(), fingerprint: preview.fingerprint })
      let clock = new Date(now), allPaid = false, calls = 0
      const status = createDeelPaymentStatusRuntime({
        token: 'owned-token', store: createDeelPaymentStatusStore(db as Parameters<typeof createDeelPaymentStatusStore>[0]),
        now: () => clock, sleep: async () => undefined, fetch: async () => { throw new Error('fake client owns reads') },
        client: { getTimesheet: async (timesheetId) => {
          calls++
          const firstDay = timesheetId.endsWith('-1'), remoteStatus = firstDay || allPaid ? 'paid' : 'approved'
          return { timesheetId, contractId: `c${f.u}`, status: remoteStatus,
            providerStatus: remoteStatus, quantity: 1, totalAmount: '10.00', currency: 'EUR', spentDate: firstDay ? '2026-10-13' : '2026-10-20' }
        } },
      })
      const report = async () => (await createStaffPaymentStore(db as Parameters<typeof createStaffPaymentStore>[0]).report('2026-10', '2026-10-26')).rows.find((row) => row.user_id === f.u)!
      expect(await status.refresh('2026-10', f.authority)).toMatchObject({ checked: 2, failed: 0 })
      expect(calls).toBe(2)
      expect((await report()).deel_staging).toMatchObject({
        status: 'partially_paid', staged_entries: 3, paid_entries: 1, paid_seconds: 3600, approved_entries: 2,
      })
      clock = new Date(clock.getTime() + 301000); allPaid = true
      await status.refresh('2026-10', f.authority)
      expect(await report()).toMatchObject({ paid_cents: 0, deel_staging: { status: 'paid', paid_entries: 3, paid_seconds: 7200 } })
    })
    it('persists monthly per-person staging progress across batches and exposes changed or uncertain receipts', async () => {
      const f = await fixture(),
        extra = f.u * 10 + 1
      await addUnsubmitted(f.u, extra)
      await reportingStore(f.u, f.v)
      const report = async (userId = f.u, month = '2026-10') =>
        (
          await createStaffPaymentStore(db as Parameters<typeof createStaffPaymentStore>[0]).report(
            month,
            '2026-10-26',
          )
        ).rows.find((row) => row.user_id === userId)!
      expect((await report()).deel_staging).toMatchObject({
        status: 'not_staged',
        staged_entries: 0,
        unstaged_entries: 2,
        unstaged_seconds: 5400,
      })
      const stage = async (selection: typeof f.selection) => {
        const runtime = f.runtime(),
          preview = await runtime.preview(f.authority, selection)
        return runtime.stage(f.authority, {
          ...selection,
          id: crypto.randomUUID(),
          fingerprint: preview.fingerprint,
        })
      }
      await stage({ ...f.selection, to: '2026-10-13' })
      expect((await report()).deel_staging).toMatchObject({
        status: 'partially_staged',
        staged_entries: 1,
        staged_seconds: 3600,
        unstaged_entries: 1,
        unstaged_seconds: 1800,
        last_staged_at: now,
      })
      expect((await report(f.v)).deel_staging).toMatchObject({
        status: 'not_staged',
        staged_entries: 0,
      })
      expect((await report(f.u, '2026-09')).deel_staging).toMatchObject({
        status: 'no_hours',
        staged_entries: 0,
      })
      await stage(f.selection)
      expect(await report()).toMatchObject({
        paid_cents: 0,
        deel_staging: {
          status: 'staged',
          staged_entries: 2,
          staged_seconds: 5400,
          unstaged_entries: 0,
        },
      })
      await run(
        'UPDATE time_entries SET seconds=2000,seconds_without_timer=2000,rounded_seconds=2000 WHERE id=?',
        extra,
      )
      expect((await report()).deel_staging).toMatchObject({
        status: 'attention',
        changed_entries: 1,
        staged_seconds: 5400,
      })
      await run(
        'INSERT INTO deel_transfer_intents(entry_id,contract_id,fingerprint,started_at) VALUES(?,?,?,?)',
        f.u * 10,
        `c${f.u}`,
        `c${f.u}:2026-10-13:3600`,
        now,
      )
      expect((await report()).deel_staging).toMatchObject({
        status: 'attention',
        staged_entries: 2,
        unresolved_entries: 1,
      })
      await run('UPDATE users SET is_active=0 WHERE id=?', f.u)
      expect(await report()).toMatchObject({
        active: false,
        deel_staging: { status: 'attention', staged_entries: 2, unresolved_entries: 1 },
      })
      expect(await rows('SELECT * FROM staff_payment_effective_events')).toEqual([])
    })
    it('excludes running placeholders and counts zero or negative stopped entries without calling them staged', async () => {
      const f = await fixture(),
        zero = f.u * 10 + 1,
        negative = zero + 1,
        running = zero + 2
      await addUnsubmitted(f.u, zero)
      await addUnsubmitted(f.u, negative)
      await addUnsubmitted(f.u, running)
      // Imported negative corrections may round to zero; completed positive
      // zero entries are separately prohibited by the write gate.
      await run(
        'UPDATE time_entries SET seconds=-1,seconds_without_timer=-1,rounded_seconds=0 WHERE id=?',
        zero,
      )
      await run(
        'UPDATE time_entries SET seconds=-1800,seconds_without_timer=-1800,rounded_seconds=-1800 WHERE id=?',
        negative,
      )
      await run('UPDATE time_entries SET timer_started_at=? WHERE id=?', now, running)
      await reportingStore(f.u)
      const row = (
        await createStaffPaymentStore(db as Parameters<typeof createStaffPaymentStore>[0]).report(
          '2026-10',
          '2026-10-26',
        )
      ).rows.find((person) => person.user_id === f.u)!
      expect(row.deel_staging).toMatchObject({
        status: 'attention',
        staged_entries: 0,
        unstaged_entries: 1,
        unstaged_seconds: 3600,
        zero_duration_entries: 1,
        unsyncable_entries: 1,
      })
    })
    const submitEntry = async (userId: number, entryId: number) => {
      const submissionId = entryId + 300000
      await run(
        "INSERT INTO timesheet_submissions(id,user_id,period_start,period_end,status,submitted_by_user_id,submitted_at,version,created_at,updated_at) VALUES(?,?,'2026-10-18','2026-10-24','submitted',?,?,0,?,?)",
        submissionId, userId, userId, now, now, now,
      )
      await run("UPDATE time_entries SET approval_status='submitted',timesheet_submission_id=? WHERE id=?", submissionId, entryId)
    }
    it('manually stages stopped unsubmitted and submitted hours only after an exact administrator preview without changing approval', async () => {
      const f = await fixture(), first = f.u * 10 + 1, second = f.v * 10 + 1
      await addUnsubmitted(f.u, first)
      await addUnsubmitted(f.v, second)
      await submitEntry(f.v, second)
      const selection = { from: '2026-10-20', to: '2026-10-25', userIds: [f.u, f.v] }
      const states = () => rows('SELECT id,approval_status,timesheet_submission_id FROM time_entries WHERE id IN(?,?) ORDER BY id', first, second)
      const before = await states()
      expect(before).toEqual([
        { id: first, approval_status: 'unsubmitted', timesheet_submission_id: null },
        { id: second, approval_status: 'submitted', timesheet_submission_id: second + 300000 },
      ])
      expect(await createDeelSyncStore(db).entries(selection)).toEqual([])
      const r = f.runtime(), preview = await r.preview(f.authority, selection)
      expect(preview.entryIds).toEqual([first, second])
      expect(preview.seconds).toBe(3600)
      expect(f.posted).toEqual([])
      const facts = JSON.parse((await f.native.snapshot(f.authority, selection, now)).sourceFacts)
      expect(facts.entries.map((entry: { approvalStatus: string }) => entry.approvalStatus)).toEqual(['unsubmitted', 'submitted'])
      await expect(r.stage(f.authority, { ...selection, id: crypto.randomUUID(), fingerprint: '0'.repeat(64) })).rejects.toMatchObject({ code: 'stale' })
      expect(f.posted).toEqual([])
      const command = { ...selection, id: crypto.randomUUID(), fingerprint: preview.fingerprint }
      expect(await r.stage(f.authority, command)).toMatchObject({ status: 'staged', entriesStaged: 2 })
      await r.stage(f.authority, command)
      expect(f.posted.map((post) => [post.contract_id, post.quantity])).toEqual([[`c${f.u}`, 0.5], [`c${f.v}`, 0.5]])
      expect(await states()).toEqual(before)
      expect(await rows('SELECT status,version FROM timesheet_submissions WHERE id=?', second + 300000)).toEqual([{ status: 'submitted', version: 0 }])
      expect(await createDeelSyncStore(db).entries(selection)).toEqual([])
      expect(await rows('SELECT * FROM staff_payment_effective_events')).toEqual([])
    })
    it('excludes a running unsubmitted timer from manual review until it is stopped', async () => {
      const f = await fixture(), entryId = f.u * 10 + 1
      await addUnsubmitted(f.u, entryId)
      await run('UPDATE time_entries SET timer_started_at=? WHERE id=?', now, entryId)
      const selection = { ...f.selection, from: '2026-10-20' }
      expect((await f.runtime().preview(f.authority, selection)).entryIds).toEqual([])
      await run('UPDATE time_entries SET timer_started_at=NULL WHERE id=?', entryId)
      expect((await f.runtime().preview(f.authority, selection)).entryIds).toEqual([entryId])
      expect(f.posted).toEqual([])
    })
    it.each(['before_stage', 'before_claim'] as const)('fences approval changes %s for administrator-reviewed hours', async (phase) => {
      const f = await fixture(), entryId = f.u * 10 + 1
      await addUnsubmitted(f.u, entryId)
      const selection = { ...f.selection, from: '2026-10-20' }
      const store: DeelStageStore = phase === 'before_claim' ? { ...f.native, claim: async (...args) => {
        await submitEntry(f.u, entryId)
        return f.native.claim(...args)
      } } : f.native
      const runtime = f.runtime(store), preview = await runtime.preview(f.authority, selection)
      expect(preview.entryIds).toEqual([entryId])
      if (phase === 'before_stage') await submitEntry(f.u, entryId)
      const command = { ...selection, id: crypto.randomUUID(), fingerprint: preview.fingerprint }
      if (phase === 'before_stage') await expect(runtime.stage(f.authority, command)).rejects.toMatchObject({ code: 'stale' })
      else expect(await runtime.stage(f.authority, command)).toMatchObject({ status: 'stale', code: 'source_changed' })
      expect(f.posted).toEqual([])
    })
    const linkDeel = async (userId: number, address = `person${userId}@example.test`, provider = 'deel') => {
      await run(
        "INSERT INTO user_payout_accounts(user_id,provider,external_id,kind,linked_by_user_id,linked_at,created_at,updated_at) VALUES(?,?,?,'account',1,?,?,?)",
        userId, provider, address, now, now, now,
      )
    }
    it('uses only explicit Deel links to same-user verified emails when payroll kind is absent, including grouped staging', async () => {
      const f = await fixture()
      for (const id of [f.u, f.v]) {
        await run('UPDATE user_emails SET kind=NULL WHERE user_id=?', id)
        await linkDeel(id)
      }
      const r = f.runtime(), group = { ...f.selection, userIds: [f.u, f.v] }
      const preview = await r.preview(f.authority, group)
      expect(preview.unmatched).toEqual([])
      expect(preview.people.map((p) => [p.userId, p.contractId])).toEqual([[f.u, `c${f.u}`], [f.v, `c${f.v}`]])
      expect(f.posted).toEqual([])
      expect(await r.stage(f.authority, { ...group, id: crypto.randomUUID(), fingerprint: preview.fingerprint })).toMatchObject({ status: 'staged', entriesStaged: 2 })
      expect(f.posted.map((p) => p.contract_id)).toEqual([`c${f.u}`, `c${f.v}`])
      expect(await rows('SELECT * FROM staff_payment_effective_events')).toEqual([])
    })
    it.each(['no_link', 'wise_link', 'detached_link', 'unverified_email', 'invalidated_email', 'other_user_email'] as const)(
      'does not infer payroll from %s', async (change) => {
        const f = await fixture()
        await run('UPDATE user_emails SET kind=NULL WHERE user_id=?', f.u)
        if (change !== 'no_link') await linkDeel(f.u, `person${change === 'other_user_email' ? f.v : f.u}@example.test`, change === 'wise_link' ? 'wise' : 'deel')
        if (change === 'detached_link') await run('UPDATE user_payout_accounts SET detached_at=? WHERE user_id=?', now, f.u)
        if (change === 'unverified_email') await run('UPDATE user_emails SET verified_at=NULL WHERE user_id=?', f.u)
        if (change === 'invalidated_email') await run("UPDATE user_emails SET invalidated_at=? WHERE user_id=?", now, f.u)
        const preview = await f.runtime().preview(f.authority, f.selection)
        expect(preview.unmatched).toEqual([{ userId: f.u, reason: 'no_payroll_address' }])
        expect(preview.people[0]!.contractId).toBeNull()
        expect(f.posted).toEqual([])
      },
    )
    it('keeps explicit payroll kind authoritative over a different verified Deel link', async () => {
      const f = await fixture()
      await run('INSERT INTO user_emails(user_id,address,verified_at,created_at,updated_at) VALUES(?,?,?,?,?)', f.u, `alternate${f.u}@example.test`, now, now, now)
      await linkDeel(f.u, `alternate${f.u}@example.test`)
      expect((await f.runtime().preview(f.authority, f.selection)).people[0]!.contractId).toBe(`c${f.u}`)
      await run("UPDATE user_emails SET verified_at=NULL WHERE user_id=? AND kind='payroll'", f.u)
      expect((await f.runtime().preview(f.authority, f.selection)).unmatched).toEqual([{ userId: f.u, reason: 'no_payroll_address' }])
      expect(f.posted).toEqual([])
    })
    it('rejects atomic admission after detaching and relinking the same verified address', async () => {
      const f = await fixture()
      await run('UPDATE user_emails SET kind=NULL WHERE user_id=?', f.u)
      await linkDeel(f.u)
      const preview = await f.runtime().preview(f.authority, f.selection)
      const before = await f.native.snapshot(f.authority, f.selection, now)
      await run('UPDATE user_payout_accounts SET detached_at=? WHERE user_id=? AND detached_at IS NULL', now, f.u)
      await linkDeel(f.u)
      const after = await f.native.snapshot(f.authority, f.selection, now)
      expect(after.directory).toEqual(before.directory)
      expect(after.sourceFacts).not.toBe(before.sourceFacts)
      const command = { ...f.selection, id: crypto.randomUUID(), fingerprint: preview.fingerprint }
      await expect(f.native.begin(f.authority, command, before, now)).rejects.toMatchObject({ code: 'stale' })
      expect(await rows("SELECT id FROM deel_sync_runs WHERE json_extract(detail,'$.staging_command.id')=?", command.id)).toEqual([])
      expect(f.posted).toEqual([])
    })
    it.each(['detach', 'relink_same_address'] as const)('fences %s after review and before claim even if the address is unchanged', async (change) => {
      const f = await fixture()
      await run('UPDATE user_emails SET kind=NULL WHERE user_id=?', f.u)
      await linkDeel(f.u)
      const r = f.runtime({ ...f.native, claim: async (...args) => {
        await run('UPDATE user_payout_accounts SET detached_at=? WHERE user_id=? AND detached_at IS NULL', now, f.u)
        if (change === 'relink_same_address') await linkDeel(f.u)
        return f.native.claim(...args)
      } })
      const preview = await r.preview(f.authority, f.selection)
      expect(preview.people[0]!.contractId).toBe(`c${f.u}`)
      expect(await r.stage(f.authority, { ...f.selection, id: crypto.randomUUID(), fingerprint: preview.fingerprint })).toMatchObject({ status: 'stale', code: 'source_changed' })
      expect(f.posted).toEqual([])
    })
    it('stages one selected person, then an overlapping explicit group exactly once without recording payment', async () => {
      const f = await fixture(),
        r = f.runtime(),
        p = await r.preview(f.authority, f.selection),
        c = { ...f.selection, id: crypto.randomUUID(), fingerprint: p.fingerprint }
      expect(p.seconds).toBe(3600)
      expect(p.entryIds).toEqual([f.u * 10])
      expect(await r.stage(f.authority, c)).toMatchObject({ status: 'staged', entriesStaged: 1 })
      expect(await r.stage(f.authority, c)).toMatchObject({ status: 'staged', entriesStaged: 1 })
      const group = { ...f.selection, userIds: [f.u, f.v] },
        p2 = await r.preview(f.authority, group)
      expect(p2.alreadyStaged).toBe(1)
      expect(
        await r.stage(f.authority, {
          ...group,
          id: crypto.randomUUID(),
          fingerprint: p2.fingerprint,
        }),
      ).toMatchObject({ status: 'staged', entriesStaged: 1 })
      expect(f.posted.map((x) => [x.contract_id, x.quantity])).toEqual([
        [`c${f.u}`, 1],
        [`c${f.v}`, 2],
      ])
      expect(await rows('SELECT * FROM staff_payment_effective_events')).toEqual([])
    })
    it('refuses changed reviewed source, including a newly approved matching entry before claim', async () => {
      const f = await fixture()
      let mutated = false
      const r = f.runtime({
        ...f.native,
        claim: async (...args) => {
          if (!mutated) {
            mutated = true
            await f.add(f.u, f.u * 10 + 1, '2026-10-20')
          }
          return f.native.claim(...args)
        },
      })
      const p = await r.preview(f.authority, f.selection)
      expect(
        await r.stage(f.authority, {
          ...f.selection,
          id: crypto.randomUUID(),
          fingerprint: p.fingerprint,
        }),
      ).toMatchObject({ status: 'stale' })
      expect(f.posted).toEqual([])
    })
    it('retains unknown provider acceptance and prevents replay or a new preview from posting it again', async () => {
      const f = await fixture(),
        r = f.runtime(),
        p = await r.preview(f.authority, f.selection),
        c = { ...f.selection, id: crypto.randomUUID(), fingerprint: p.fingerprint }
      f.lose()
      expect(await r.stage(f.authority, c)).toMatchObject({
        status: 'attention',
        code: 'provider_outcome_unknown',
      })
      expect(await r.stage(f.authority, c)).toMatchObject({ status: 'attention' })
      const next = await r.preview(f.authority, f.selection)
      expect(next.unresolved).toEqual([f.u * 10])
      await expect(
        r.stage(f.authority, { ...c, id: crypto.randomUUID(), fingerprint: next.fingerprint }),
      ).rejects.toMatchObject({ code: 'stale' })
      expect(f.posted).toHaveLength(1)
    })
    it('serializes concurrent individual and group staging without extra people or duplicate transfers', async () => {
      const f = await fixture(),
        single = f.runtime(),
        group = f.runtime()
      const groupSelection = { ...f.selection, userIds: [f.u, f.v] }
      const p = await single.preview(f.authority, f.selection),
        q = await group.preview(f.authority, groupSelection)
      const outcomes = await Promise.allSettled([
        single.stage(f.authority, {
          ...f.selection,
          id: crypto.randomUUID(),
          fingerprint: p.fingerprint,
        }),
        group.stage(f.authority, {
          ...groupSelection,
          id: crypto.randomUUID(),
          fingerprint: q.fingerprint,
        }),
      ])
      expect(outcomes.some((x) => x.status === 'fulfilled')).toBe(true)
      const next = await group.preview(f.authority, groupSelection)
      await group.stage(f.authority, {
        ...groupSelection,
        id: crypto.randomUUID(),
        fingerprint: next.fingerprint,
      })
      expect(f.posted.filter((x) => x.contract_id === `c${f.u}`)).toHaveLength(1)
      expect(f.posted.filter((x) => x.contract_id === `c${f.v}`)).toHaveLength(1)
      expect(f.posted).toHaveLength(2)
    })
    it.each(['provider', 'approval', 'role'] as const)(
      'fences changed %s before the provider POST',
      async (change) => {
        const f = await fixture()
        const store: DeelStageStore = {
          ...f.native,
          claim: async (...args) => {
            if (change === 'provider')
              await run(
                "INSERT INTO staff_payment_provider_events(id,user_id,scope,version,provider,command_json,actor_id,recorded_at,request_id) VALUES(?,?,?,2,'wise','{}',1,?,?)",
                `changed${f.u}`,
                f.u,
                `user:${f.u}`,
                now,
                `changed${f.u}`,
              )
            if (change === 'approval')
              await run(
                "UPDATE timesheet_submissions SET status='unsubmitted',version=version+1,reviewed_by_user_id=1,rejection_reason='Owned withdrawal',reviewed_at=?,updated_at=? WHERE id=(SELECT timesheet_submission_id FROM time_entries WHERE id=?)",
                now,
                now,
                f.u * 10,
              )
            if (change === 'role') await run("UPDATE users SET profile='member' WHERE id=?", f.a)
            return f.native.claim(...args)
          },
        }
        const r = f.runtime(store),
          p = await r.preview(f.authority, f.selection)
        const outcome = await Promise.allSettled([
          r.stage(f.authority, {
            ...f.selection,
            id: crypto.randomUUID(),
            fingerprint: p.fingerprint,
          }),
        ])
        if (change === 'role')
          expect(outcome[0]).toMatchObject({ status: 'rejected', reason: { code: 'forbidden' } })
        else expect(outcome[0]).toMatchObject({ status: 'fulfilled', value: { status: 'stale' } })
        expect(f.posted).toHaveLength(0)
      },
    )
    it('does not clean up a stale run after the confirming session is revoked', async () => {
      const f = await fixture(),
        runtime = f.runtime(),
        preview = await runtime.preview(f.authority, f.selection)
      await run(
        "INSERT INTO deel_sync_runs(started_at,outcome,detail) VALUES('2026-10-25T00:00:00.000Z','running','{}')",
      )
      const command = { ...f.selection, id: crypto.randomUUID(), fingerprint: preview.fingerprint }
      const snapshot = await f.native.snapshot(f.authority, f.selection, now)
      await run(
        "UPDATE sessions SET revoked_at=?,revocation_reason='user_revoked',updated_at=? WHERE id=?",
        now,
        now,
        f.a,
      )
      await expect(f.native.begin(f.authority, command, snapshot, now)).rejects.toMatchObject({
        code: 'forbidden',
      })
      expect(
        (
          await rows<{ outcome: string }>(
            "SELECT outcome FROM deel_sync_runs WHERE started_at='2026-10-25T00:00:00.000Z' ORDER BY id DESC LIMIT 1",
          )
        )[0]?.outcome,
      ).toBe('running')
      await run(
        "UPDATE deel_sync_runs SET outcome='failed',finished_at=? WHERE outcome='running'",
        now,
      )
      expect(f.posted).toHaveLength(0)
    })
    it('keeps canonical verified payroll identity singular and reads the complete identity', async () => {
      const f = await fixture()
      await expect(
        run(
          "INSERT INTO user_emails(user_id,address,kind,verified_at,created_at,updated_at) VALUES(?,?,'payroll',?,?,?)",
          f.u,
          'extra@example.test',
          now,
          now,
          now,
        ),
      ).rejects.toThrow(/UNIQUE/)
      const snapshot = await f.native.snapshot(f.authority, f.selection, now)
      expect(snapshot.directory[0]?.emails).toEqual([
        { address: `person${f.u}@example.test`, kind: 'payroll' },
      ])
      expect((await f.runtime().preview(f.authority, f.selection)).people[0]?.contractId).toBe(
        `c${f.u}`,
      )
      expect(f.posted).toHaveLength(0)
    })
    it('revalidates the matched remote contract immediately before native claim', async () => {
      const f = await fixture(),
        r = f.runtime(),
        p = await r.preview(f.authority, f.selection)
      f.changeBeforePost()
      expect(
        await r.stage(f.authority, {
          ...f.selection,
          id: crypto.randomUUID(),
          fingerprint: p.fingerprint,
        }),
      ).toMatchObject({ status: 'stale', code: 'contract_changed' })
      expect(f.posted).toHaveLength(0)
    })
    it('preserves accepted native receipts after a lost storage reply without another provider POST', async () => {
      const f = await fixture(),
        store: DeelStageStore = {
          ...f.native,
          record: async (...args) => {
            await f.native.record(...args)
            throw new Error('owned lost storage reply')
          },
        }
      const r = f.runtime(store),
        p = await r.preview(f.authority, f.selection),
        command = { ...f.selection, id: crypto.randomUUID(), fingerprint: p.fingerprint }
      expect(await r.stage(f.authority, command)).toMatchObject({
        status: 'attention',
        code: 'accepted_receipt_unrecorded',
      })
      await r.stage(f.authority, command)
      expect((await r.preview(f.authority, f.selection)).alreadyStaged).toBe(1)
      expect(f.posted).toHaveLength(1)
    })
    it('refuses malformed persisted command result instead of returning it as a receipt', async () => {
      const f = await fixture(),
        r = f.runtime(),
        p = await r.preview(f.authority, f.selection),
        command = { ...f.selection, id: crypto.randomUUID(), fingerprint: p.fingerprint }
      await r.stage(f.authority, command)
      await run(
        "UPDATE deel_sync_runs SET detail=json_set(detail,'$.staging_result.status','paid') WHERE json_extract(detail,'$.staging_command.id')=?",
        command.id,
      )
      await expect(r.lookup(f.authority, command)).rejects.toMatchObject({ code: 'stale' })
      expect(f.posted).toHaveLength(1)
    })
    it('reports an interrupted accepted command as attention after its lease without mutating or reposting', async () => {
      const f = await fixture(),
        store: DeelStageStore = {
          ...f.native,
          begin: async (...args) => {
            await f.native.begin(...args)
            throw new Error('owned crash after accepted command')
          },
        }
      const runtime = f.runtime(store),
        p = await runtime.preview(f.authority, f.selection),
        command = { ...f.selection, id: crypto.randomUUID(), fingerprint: p.fingerprint }
      await expect(runtime.stage(f.authority, command)).rejects.toThrow('owned crash')
      expect(await f.native.lookup(f.authority, command, '2026-10-26T13:00:01.000Z')).toMatchObject(
        { status: 'attention', code: 'interrupted_run' },
      )
      expect(
        (
          await rows<{ outcome: string }>(
            "SELECT outcome FROM deel_sync_runs WHERE json_extract(detail,'$.staging_command.id')=?",
            command.id,
          )
        )[0]?.outcome,
      ).toBe('running')
      expect(f.posted).toHaveLength(0)
      await run(
        "UPDATE deel_sync_runs SET outcome='failed',finished_at=? WHERE json_extract(detail,'$.staging_command.id')=?",
        now,
        command.id,
      )
    })
    it('honors an active legacy automatic run without interpreting its detail as a staging receipt', async () => {
      const f = await fixture(),
        runtime = f.runtime(),
        p = await runtime.preview(f.authority, f.selection)
      await run(
        "INSERT INTO deel_sync_runs(started_at,outcome,detail) VALUES(?,'running','{\"error\":null}')",
        now,
      )
      expect(
        await runtime.stage(f.authority, {
          ...f.selection,
          id: crypto.randomUUID(),
          fingerprint: p.fingerprint,
        }),
      ).toMatchObject({ status: 'busy', runId: null })
      expect(f.posted).toHaveLength(0)
      await run(
        "UPDATE deel_sync_runs SET outcome='failed',finished_at=? WHERE outcome='running'",
        now,
      )
    })
    it('rejects a replaced approval revision even when the same hours are approved again', async () => {
      const f = await fixture(),
        store: DeelStageStore = {
          ...f.native,
          claim: async (...args) => {
            const id = f.u * 10 + 100000
            await run(
              "UPDATE timesheet_submissions SET status='unsubmitted',version=2,reviewed_by_user_id=1,rejection_reason='Owned re-review',reviewed_at=?,updated_at=? WHERE id=?",
              now,
              now,
              id,
            )
            await run(
              "UPDATE timesheet_submissions SET status='submitted',version=3,reviewed_by_user_id=NULL,rejection_reason=NULL,reviewed_at=NULL,updated_at=? WHERE id=?",
              now,
              id,
            )
            await run(
              "UPDATE timesheet_submissions SET status='approved',version=4,reviewed_by_user_id=1,reviewed_at=?,updated_at=? WHERE id=?",
              now,
              now,
              id,
            )
            return f.native.claim(...args)
          },
        }
      const runtime = f.runtime(store),
        preview = await runtime.preview(f.authority, f.selection)
      expect(
        await runtime.stage(f.authority, {
          ...f.selection,
          id: crypto.randomUUID(),
          fingerprint: preview.fingerprint,
        }),
      ).toMatchObject({ status: 'stale', code: 'source_changed' })
      expect(f.posted).toHaveLength(0)
    })
    it('withholds preview data when the session is revoked during provider discovery', async () => {
      const f = await fixture()
      let snapshots = 0
      const store: DeelStageStore = {
        ...f.native,
        snapshot: async (...args) => {
          const snapshot = await f.native.snapshot(...args)
          if (++snapshots === 1)
            await run(
              "UPDATE sessions SET revoked_at=?,revocation_reason='user_revoked',updated_at=? WHERE id=?",
              now,
              now,
              f.a,
            )
          return snapshot
        },
      }
      await expect(f.runtime(store).preview(f.authority, f.selection)).rejects.toMatchObject({
        code: 'forbidden',
      })
      expect(f.posted).toHaveLength(0)
    })
    it('rechecks the native administrator session before provider work and preserves exact command identity', async () => {
      const f = await fixture(),
        r = f.runtime(),
        p = await r.preview(f.authority, f.selection),
        c = { ...f.selection, id: crypto.randomUUID(), fingerprint: p.fingerprint }
      await r.stage(f.authority, c)
      await expect(r.stage(f.authority, { ...c, userIds: [f.v] })).rejects.toMatchObject({
        code: 'command_reused',
      })
      await run(
        "UPDATE sessions SET revoked_at=?,revocation_reason='user_revoked',updated_at=? WHERE id=?",
        now,
        now,
        f.a,
      )
      await expect(r.stage(f.authority, c)).rejects.toMatchObject({ code: 'forbidden' })
      expect(f.posted).toHaveLength(1)
    })
  })
