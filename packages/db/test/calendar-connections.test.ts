import { exportBundle } from '../src/backup.js'
import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { createContainerSessionStore, createD1SessionStore } from '../src/sessions.js'
import { createCalendarConnectionStore } from '../src/calendar-connections.js'
import { createCalendarSyncService } from '../../integrations/src/calendar-sync.js'
import {
  CalendarAuthorizationError,
  createCalendarGrantVault,
  type CalendarSourceEvent,
  type CalendarSourceFactory,
} from '@ezacto/core'
import type { TrackedResourceDatabase } from '../src/tracked-resource-repository.js'
const close: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(close.splice(0).map((fn) => fn()))
})
const SECRET = 'PRIVATE_CALENDAR_REFRESH_SENTINEL',
  CURSOR = 'PRIVATE_CURSOR_SENTINEL'
const grant = { refreshToken: SECRET, scopes: ['calendar.readonly'] }
const initial = new Date().toISOString()
const event = (over: Partial<CalendarSourceEvent> = {}): CalendarSourceEvent => ({
  calendarId: 'primary',
  eventId: 'event-1',
  occurrence: '',
  summary: 'Owned private meeting',
  startsAt: new Date(Date.parse(initial) - 7200000).toISOString(),
  endsAt: new Date(Date.parse(initial) - 3600000).toISOString(),
  allDay: false,
  cancelled: false,
  response: 'accepted',
  showAs: 'busy',
  version: 'v1',
  ...over,
})
const fixture = async (kind: 'sqlite' | 'd1') => {
  let orm: TrackedResourceDatabase,
    run: (sql: string, ...args: unknown[]) => Promise<void>,
    rows: <T>(sql: string, ...args: unknown[]) => Promise<T[]>,
    sessions: ReturnType<typeof createContainerSessionStore>
  if (kind === 'sqlite') {
    const raw = new BetterSqlite3(':memory:')
    migrateContainer(raw)
    close.push(() => raw.close())
    orm = createContainerDatabase(raw)
    run = async (sql, ...args) => {
      raw.prepare(sql).run(...args)
    }
    rows = async <T>(sql: string, ...args: unknown[]) => raw.prepare(sql).all(...args) as T[]
    sessions = createContainerSessionStore(raw)
  } else {
    const mf = new Miniflare({
      modules: true,
      script: 'export default {fetch(){return new Response("ok")}}',
      d1Databases: ['DB'],
    })
    close.push(() => mf.dispose())
    const raw = await mf.getD1Database('DB')
    await migrateD1(raw)
    orm = createD1Database(raw)
    run = async (sql, ...args) => {
      await raw
        .prepare(sql)
        .bind(...args)
        .run()
    }
    rows = async <T>(sql: string, ...args: unknown[]) =>
      (
        await raw
          .prepare(sql)
          .bind(...args)
          .all<T>()
      ).results
    sessions = createD1SessionStore(raw)
  }
  await run(
    "INSERT INTO organizations(id,name,modules,created_at,updated_at) VALUES(1,'Owned','{}',?,?)",
    initial,
    initial,
  )
  await run(
    "INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(1,'Owner','Admin','administrator','[]',?,?),(2,'Owned','Member','member','[]',?,?),(3,'Other','Member','member','[]',?,?)",
    initial,
    initial,
    initial,
    initial,
    initial,
    initial,
  )
  const a = { userId: 2, sessionId: (await sessions.issue(2)).session.id },
    store = createCalendarConnectionStore(orm)
  let clock = new Date(initial)
  let events = [event()],
    cursor: string | null = CURSOR,
    beforeRead: (() => Promise<void>) | undefined,
    refused = false,
    beforeFactory: ((context: Parameters<CalendarSourceFactory>[0]) => Promise<void>) | undefined
  const seen: Array<string | null> = []
  const service = await createCalendarSyncService({
    store,
    deploymentKey: new Uint8Array(32).fill(7),
    now: () => clock,
    sources: {
      google: async (context) => {
        await beforeFactory?.(context)
        return {
          provider: 'google',
          listEvents: async (request) => {
            seen.push(request.cursor)
            await beforeRead?.()
            if (refused) throw new CalendarAuthorizationError()
            return { events, nextCursor: cursor, nextPage: null }
          },
        }
      },
    },
  })
  await service.completeOAuth(a, 'google', 0, grant)
  return {
    a,
    store,
    service,
    orm,
    run,
    rows,
    sessions,
    seen,
    setNow: (v: Date) => {
      clock = v
    },
    setEvents: (v: CalendarSourceEvent[]) => {
      events = v
    },
    setCursor: (v: string | null) => {
      cursor = v
    },
    onRead: (v: () => Promise<void>) => {
      beforeRead = v
    },
    onFactory: (v: (context: Parameters<CalendarSourceFactory>[0]) => Promise<void>) => {
      beforeFactory = v
    },
    refuse: () => {
      refused = true
    },
  }
}
for (const kind of ['sqlite', 'd1'] as const)
  describe(kind + ' calendar connection persistence', () => {
    it('atomically syncs encrypted cursor and private proposals; replay keeps a discard closed', async () => {
      const f = await fixture(kind)
      await f.service.refresh(f.a, 'google')
      expect(await f.rows('SELECT count(*) AS n FROM calendar_proposals')).toEqual([{ n: 1 }])
      expect(await f.rows('SELECT count(*) AS n FROM time_entries')).toEqual([{ n: 0 }])
      const raw = JSON.stringify(await f.rows('SELECT * FROM calendar_connections'))
      expect(raw).not.toContain(SECRET)
      expect(raw).not.toContain(CURSOR)
      await f.run("UPDATE calendar_proposals SET status='discarded'")
      await f.service.refresh(f.a, 'google')
      expect(f.seen).toEqual([null, CURSOR])
      expect(await f.rows('SELECT status FROM calendar_proposals')).toEqual([
        { status: 'discarded' },
      ])
    })
    it('logout denies a new refresh but an admitted OAuth sync can finish', async () => {
      const f = await fixture(kind)
      f.onRead(async () => { await f.sessions.revoke(2, f.a.sessionId) })
      expect(await f.service.refresh(f.a, 'google')).toMatchObject({ state: 'connected', applied: 1 })
      expect(await f.rows('SELECT count(*) AS n FROM calendar_proposals')).toEqual([{ n: 1 }])
      expect((await f.store.read(2, 'google'))?.sealedCursor).not.toBeNull()
      await expect(f.service.refresh(f.a, 'google')).rejects.toMatchObject({ code: 'forbidden' })
      expect(f.seen).toEqual([null])
    })
    it('custom and rolling windows cannot reuse a cursor from different query bounds', async () => {
      const f = await fixture(kind)
      await f.service.refresh(f.a, 'google', undefined, { past: 7, future: 0 })
      await f.service.refresh(f.a, 'google')
      await f.service.refresh(f.a, 'google')
      f.setNow(new Date(Date.parse(initial) + 60_000))
      await f.service.refresh(f.a, 'google')
      expect(f.seen).toEqual([null, null, CURSOR, null])
      expect(await f.rows('SELECT count(*) AS n FROM calendar_proposals')).toEqual([{ n: 1 }])
    })
    it('calendar identity includes calendarId; accepted updates and cancellation only mark provider changes', async () => {
      const f = await fixture(kind)
      f.setEvents([event(), event({ calendarId: 'second' })])
      await f.service.refresh(f.a, 'google')
      expect(await f.rows('SELECT count(*) AS n FROM calendar_proposals')).toEqual([{ n: 2 }])
      await f.run(
        "INSERT INTO clients(id,name,currency,created_at,updated_at) VALUES(1,'Owned client','USD',?,?)",
        initial,
        initial,
      )
      await f.run(
        "INSERT INTO projects(id,client_id,name,created_at,updated_at) VALUES(1,1,'Owned project',?,?)",
        initial,
        initial,
      )
      await f.run(
        "INSERT INTO tasks(id,name,created_at,updated_at) VALUES(1,'Owned task',?,?)",
        initial,
        initial,
      )
      await f.run(
        'INSERT INTO user_assignments(id,project_id,user_id,created_at,updated_at) VALUES(1,1,2,?,?)',
        initial,
        initial,
      )
      await f.run(
        'INSERT INTO task_assignments(id,project_id,task_id,billable,created_at,updated_at) VALUES(1,1,1,1,?,?)',
        initial,
        initial,
      )
      await f.run(
        "INSERT INTO time_entries(id,user_id,project_id,task_id,user_assignment_id,task_assignment_id,spent_date,seconds,seconds_without_timer,rounded_seconds,billable,notes,created_at,updated_at) VALUES(1,2,1,1,1,1,?,3600,3600,3600,1,'Accepted original',?,?)",
        event().startsAt.slice(0, 10),
        initial,
        initial,
      )
      const before = await f.rows('SELECT * FROM time_entries')
      await f.run(
        "UPDATE calendar_proposals SET status='accepted',time_entry_id=1 WHERE calendar_id='primary'",
      )
      f.setEvents([event({ version: 'v2', summary: 'Changed title', cancelled: true })])
      await f.service.refresh(f.a, 'google')
      const changed = await f.rows<{
        status: string
        title: string
        source_changed_at: string | null
        source_cancelled_at: string | null
      }>(
        "SELECT status,title,source_changed_at,source_cancelled_at FROM calendar_proposals WHERE calendar_id='primary'",
      )
      expect(changed[0]).toMatchObject({
        status: 'accepted',
        title: 'Owned private meeting',
        source_changed_at: initial,
        source_cancelled_at: initial,
      })
      expect(await f.rows('SELECT * FROM time_entries')).toEqual(before)
    })
    it('disconnect during a provider response fences the entire late batch and cursor', async () => {
      const f = await fixture(kind)
      f.onRead(() => f.service.disconnect(f.a, 'google', 1))
      await expect(f.service.refresh(f.a, 'google')).rejects.toThrow('Calendar connection changed')
      expect(await f.rows('SELECT count(*) AS n FROM calendar_proposals')).toEqual([{ n: 0 }])
      expect(
        await f.rows('SELECT status,sealed_grant,sealed_cursor FROM calendar_connections'),
      ).toEqual([{ status: 'disconnected', sealed_grant: null, sealed_cursor: null }])
    })
    it('a revoked provider grant becomes needs_reauth without advancing cursor', async () => {
      const f = await fixture(kind)
      await f.service.refresh(f.a, 'google')
      f.refuse()
      expect(await f.service.refresh(f.a, 'google')).toEqual({ state: 'needs_reauth', applied: 0 })
      expect(await f.rows('SELECT status,sealed_grant FROM calendar_connections')).toEqual([
        { status: 'needs_reauth', sealed_grant: null },
      ])
    })
    it('rotates OAuth material under the live lease and commits the cursor under the new credential revision', async () => {
      const f = await fixture(kind)
      f.onFactory(async (context) =>
        context.rotateGrant({
          refreshToken: 'ROTATED_PRIVATE_SENTINEL',
          scopes: ['calendar.readonly'],
        }),
      )
      await f.service.refresh(f.a, 'google')
      const held = (await f.store.read(2, 'google'))!,
        vault = await createCalendarGrantVault(new Uint8Array(32).fill(7))
      expect(held.credentialRevision).toBe(2)
      expect(await vault.openGrant(held.sealedGrant!, held)).toMatchObject({
        refreshToken: 'ROTATED_PRIVATE_SENTINEL',
      })
      expect(await vault.openCursor(held.sealedCursor!, held)).toBe(CURSOR)
      expect(JSON.stringify(await f.rows('SELECT * FROM calendar_connections'))).not.toContain(
        'PRIVATE_SENTINEL',
      )
    })
    it('disconnect fences late sync and unresolved revocation prevents reconnect', async () => {
      const f = await fixture(kind)
      f.onRead(async () => {
        await f.service.disconnect(f.a, 'google', 1)
        await expect(
          f.service.completeOAuth(f.a, 'google', 2, {
            refreshToken: 'NEW_PRIVATE_SENTINEL',
            scopes: ['calendar.readonly'],
          }),
        ).rejects.toThrow('busy')
      })
      await expect(f.service.refresh(f.a, 'google')).rejects.toThrow('changed')
      expect(await f.rows('SELECT count(*) AS n FROM calendar_proposals')).toEqual([{ n: 0 }])
      expect((await f.store.read(2, 'google'))?.generation).toBe(2)
      expect(await f.rows('SELECT status FROM calendar_cleanup_obligations')).toEqual([
        { status: 'pending' },
      ])
    })
    it('a failed cursor write rolls back every proposal in the same native transaction', async () => {
      const f = await fixture(kind)
      await f.run(
        "CREATE TRIGGER reject_calendar_cursor BEFORE UPDATE OF sealed_cursor ON calendar_connections WHEN NEW.sealed_cursor IS NOT NULL BEGIN SELECT RAISE(ABORT,'owned failure'); END",
      )
      await expect(f.service.refresh(f.a, 'google')).rejects.toThrow('changed')
      expect(await f.rows('SELECT count(*) AS n FROM calendar_proposals')).toEqual([{ n: 0 }])
      expect((await f.store.read(2, 'google'))?.sealedCursor).toBeNull()
    })
    it('rejects a bounded source overflow without advancing a cursor', async () => {
      const f = await fixture(kind)
      f.setEvents(Array.from({ length: 91 }, (_, n) => event({ eventId: 'event-' + n })))
      await expect(f.service.refresh(f.a, 'google')).rejects.toThrow('invalid')
      expect(await f.rows('SELECT count(*) AS n FROM calendar_proposals')).toEqual([{ n: 0 }])
      expect((await f.store.read(2, 'google'))?.sealedCursor).toBeNull()
    })
    it('does not invoke a provider when the incoming request is already aborted', async () => {
      const f = await fixture(kind)
      let called = false
      f.onFactory(async () => {
        called = true
      })
      const signal = new AbortController()
      signal.abort()
      await expect(f.service.refresh(f.a, 'google', signal.signal)).rejects.toMatchObject({
        name: 'AbortError',
      })
      expect(called).toBe(false)
      expect((await f.store.read(2, 'google'))?.sealedCursor).toBeNull()
    })
    it('recovers a lost committed response from the durable cursor without duplicating proposals', async () => {
      const f = await fixture(kind),
        commit = f.store.commit
      let lose = true
      f.store.commit = async (...args) => {
        await commit(...args)
        if (lose) {
          lose = false
          throw new Error('owned lost acknowledgement')
        }
      }
      await expect(f.service.refresh(f.a, 'google')).rejects.toThrow('unavailable')
      await f.service.refresh(f.a, 'google')
      expect(f.seen).toEqual([null, CURSOR])
      expect(await f.rows('SELECT count(*) AS n FROM calendar_proposals')).toEqual([{ n: 1 }])
    })
    it('key rotation retains the original encrypted grant as manual cleanup instead of dropping custody', async () => {
      const f = await fixture(kind),
        held = (await f.store.read(2, 'google'))!
      const changed = await createCalendarSyncService({
        store: f.store,
        deploymentKey: new Uint8Array(32).fill(8),
        now: () => new Date(initial),
        sources: {
          google: async () => ({
            provider: 'google',
            listEvents: async () => ({ events: [], nextPage: null, nextCursor: null }),
          }),
        },
      })
      await expect(changed.refresh(f.a, 'google')).rejects.toThrow('unavailable')
      const cleanup = (
        await f.rows<{ status: string; sealed_grant: string }>(
          'SELECT status,sealed_grant FROM calendar_cleanup_obligations',
        )
      )[0]!
      expect(cleanup.status).toBe('manual_required')
      expect(
        await (
          await createCalendarGrantVault(new Uint8Array(32).fill(7))
        ).openGrant(cleanup.sealed_grant, held),
      ).toEqual(grant)
      expect((await f.store.read(2, 'google'))?.state).toBe('needs_reauth')
    })
    it('concurrent refresh-token rotation cannot attach a ciphertext to the wrong credential revision', async () => {
      const f = await fixture(kind)
      let outcomes: PromiseSettledResult<void>[] = []
      f.onFactory(async (context) => {
        outcomes = await Promise.allSettled([
          context.rotateGrant({ refreshToken: 'ROTATION_A', scopes: ['calendar.readonly'] }),
          context.rotateGrant({ refreshToken: 'ROTATION_B', scopes: ['calendar.readonly'] }),
        ])
      })
      await f.service.refresh(f.a, 'google')
      expect(outcomes.map((item) => item.status).sort()).toEqual(['fulfilled', 'rejected'])
      const held = (await f.store.read(2, 'google'))!,
        vault = await createCalendarGrantVault(new Uint8Array(32).fill(7))
      expect(held.credentialRevision).toBe(2)
      expect(['ROTATION_A', 'ROTATION_B']).toContain(
        (await vault.openGrant(held.sealedGrant!, held)).refreshToken,
      )
    })
    it('native session revocation and target rotation fence new grants and old leases', async () => {
      const f = await fixture(kind),
        held = (await f.store.read(2, 'google'))!,
        lease = (await f.store.claim(
          held,
          'owned-lease',
          initial,
          new Date(Date.parse(initial) + 60000).toISOString(),
        ))!
      await f.run('UPDATE calendar_sync_instance SET nonce=lower(hex(randomblob(32)))')
      await expect(
        f.store.commit(
          lease,
          { actions: [], sealedCursor: null, window: { from: event().startsAt, to: initial } },
          initial,
        ),
      ).rejects.toThrow('changed')
      await f.sessions.revoke(2, f.a.sessionId)
      await expect(f.service.completeOAuth(f.a, 'google', 1, grant)).rejects.toThrow('forbidden')
      const vault = await createCalendarGrantVault(new Uint8Array(32).fill(7))
      await expect(
        vault.openGrant(held.sealedGrant!, { ...held, instance: await f.store.instance() }),
      ).rejects.toThrow('invalid')
    })
  })

it('logical D1 backup records only encrypted calendar custody and marks live connections non-restorable', async () => {
  const f = await fixture('d1')
  await f.service.refresh(f.a, 'google')
  const objects = new Map<string, string>()
  const manifest = await exportBundle(
    (f.orm as unknown as { $client: D1Database }).$client,
    {
      put: async (key, body) => {
        objects.set(key, body)
      },
    },
    'owned/',
  )
  expect(manifest.restore_skips).toContain('calendar_connections')
  const custody = objects.get('owned/tables/calendar_connections.csv')!
  expect(custody).toContain('sealed_grant')
  expect(custody).not.toContain(SECRET)
  expect(custody).not.toContain(CURSOR)
})

it('a timed-out provider cannot rotate credentials when it eventually resumes', async () => {
  const f = await fixture('sqlite')
  let entered!: () => void, release!: () => void
  const waiting = new Promise<void>((resolve) => {
      entered = resolve
    }),
    late = new Promise<void>((resolve) => {
      release = resolve
    })
  f.onFactory(async (context) => {
    entered()
    await late
    await context.rotateGrant({ refreshToken: 'TOO_LATE', scopes: ['calendar.readonly'] })
  })
  vi.useFakeTimers()
  const request = f.service.refresh(f.a, 'google')
  const rejected = expect(request).rejects.toThrow('unavailable')
  await waiting
  await vi.advanceTimersByTimeAsync(30001)
  await rejected
  release()
  await Promise.resolve()
  await Promise.resolve()
  expect((await f.store.read(2, 'google'))?.credentialRevision).toBe(1)
  expect(await f.rows('SELECT count(*) AS n FROM calendar_proposals')).toEqual([{ n: 0 }])
})

it('an explicit shorter date window restarts the cursor without duplicating a proposal', async () => {
  const f = await fixture('sqlite')
  await f.service.refresh(f.a, 'google')
  await f.service.refresh(f.a, 'google', undefined, { past: 7, future: 0 })
  expect(f.seen).toEqual([null, null])
  expect(await f.rows('SELECT count(*) AS n FROM calendar_proposals')).toEqual([{ n: 1 }])
})
