import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { calendarOAuthMigration } from '../src/migrations/0177_calendar_oauth.js'
import { createContainerSessionStore, createD1SessionStore } from '../src/sessions.js'
import { createCalendarConnectionStore } from '../src/calendar-connections.js'
import { createCalendarOAuthStore } from '../src/calendar-oauth.js'
import { createConfiguredCalendarServices } from '../../integrations/src/calendar/runtime.js'

const closers: Array<() => unknown> = []
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()))
})
const fixture = async (kind: 'sqlite' | 'd1') => {
  const raw = kind === 'sqlite' ? new BetterSqlite3(':memory:') : null
  const mf = raw
    ? null
    : new Miniflare({
        modules: true,
        script: 'export default {fetch(){return new Response("ok")}}',
        d1Databases: ['DB'],
      })
  const d1 = mf ? await mf.getD1Database('DB') : null
  if (raw) migrateContainer(raw)
  else await migrateD1(d1!)
  closers.push(() => raw?.close() ?? mf?.dispose())
  const run = async (query: string, ...values: unknown[]) => {
    if (raw) raw.prepare(query).run(...values)
    else
      await d1!
        .prepare(query)
        .bind(...values)
        .run()
  }
  const rows = async (query: string) =>
    raw ? raw.prepare(query).all() : (await d1!.prepare(query).all()).results
  // The reserved migration is also exercised while its preceding branch integrates.
  if (!(await rows("SELECT name FROM sqlite_master WHERE name='calendar_oauth_attempts'")).length)
    for (const statement of calendarOAuthMigration) await run(statement)
  const now = new Date().toISOString()
  await run(
    "INSERT INTO organizations(id,name,modules,created_at,updated_at) VALUES(1,'Owned','{}',?,?)",
    now,
    now,
  )
  await run(
    "INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(1,'Owned','One','member','[]',?,?),(2,'Owned','Two','member','[]',?,?)",
    now,
    now,
    now,
    now,
  )
  const db = raw ? createContainerDatabase(raw) : createD1Database(d1!)
  const sessions = raw ? createContainerSessionStore(raw) : createD1SessionStore(d1!)
  const authority = { userId: 1, sessionId: (await sessions.issue(1)).session.id }
  const other = { userId: 2, sessionId: (await sessions.issue(2)).session.id }
  const calls: Array<{ url: string; method: string; body: URLSearchParams }> = []
  let beforeToken: undefined | (() => Promise<void>)
  const connections = createCalendarConnectionStore(db)
  const service = await createConfiguredCalendarServices({
    store: connections,
    oauthStore: createCalendarOAuthStore(db),
    deploymentKey: new Uint8Array(32).fill(7),
    appOrigin: 'https://owned.example',
    environment: {
      GOOGLE_CALENDAR_CLIENT_ID: 'owned-google',
      GOOGLE_CALENDAR_CLIENT_SECRET: 'private-google',
      MICROSOFT_CALENDAR_CLIENT_ID: 'owned-microsoft',
      MICROSOFT_CALENDAR_CLIENT_SECRET: 'private-microsoft',
    },
    fetch: async (input, init) => {
      const url = String(input),
        body = new URLSearchParams(String(init?.body ?? ''))
      calls.push({ url, method: init?.method ?? 'GET', body })
      if (url.includes('/token')) {
        await beforeToken?.()
        return Response.json({
          access_token: 'PRIVATE_ACCESS',
          refresh_token: 'PRIVATE_REFRESH',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: url.includes('microsoft')
            ? 'https://graph.microsoft.com/Calendars.Read offline_access'
            : 'https://www.googleapis.com/auth/calendar.readonly',
        })
      }
      if (url === 'https://oauth2.googleapis.com/revoke') return new Response('')
      if (url.startsWith('https://www.googleapis.com/calendar/'))
        return Response.json({ items: [], nextSyncToken: 'cursor' })
      if (url.startsWith('https://graph.microsoft.com/'))
        return Response.json({
          value: [],
          '@odata.deltaLink':
            'https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=owned',
        })
      throw new Error('unexpected fixture endpoint')
    },
  })
  const start = async (provider: 'google' | 'microsoft' = 'google') => {
    const result = await service.authorization.begin(
      authority,
      provider,
      0,
      'https://owned.example',
    )
    return { ...result, state: new URL(result.authorizationUrl).searchParams.get('state')! }
  }
  return {
    service,
    connections,
    authority,
    other,
    sessions,
    calls,
    run,
    rows,
    start,
    setBeforeToken: (callback: () => Promise<void>) => {
      beforeToken = callback
    },
  }
}
for (const kind of ['sqlite', 'd1'] as const)
  describe(kind + ' calendar OAuth custody', () => {
    it('binds native session, requester, state and generation; stores only encrypted grants; revokes Google on disconnect', async () => {
      const f = await fixture(kind),
        start = await f.start()
      const input = {
        state: start.state,
        requester: start.requester,
        code: 'owned-code',
        denied: false,
        requestOrigin: 'https://owned.example',
      }
      await expect(f.service.authorization.complete(f.other, 'google', input)).rejects.toThrow()
      await expect(
        f.service.authorization.complete(f.authority, 'google', {
          ...input,
          requester: 'A'.repeat(43),
        }),
      ).rejects.toThrow()
      expect(f.calls).toHaveLength(0)
      await f.service.authorization.complete(f.authority, 'google', input)
      expect(f.calls[0]!.body.get('code_verifier')).toBe(start.requester)
      await expect(f.service.authorization.complete(f.authority, 'google', input)).rejects.toThrow()
      expect(f.calls).toHaveLength(1)
      const stored = JSON.stringify(await f.rows('SELECT * FROM calendar_connections'))
      expect(stored).not.toContain('PRIVATE_REFRESH')
      expect(stored).not.toContain('PRIVATE_ACCESS')
      const connected = (await f.service.sync.connections(f.authority)).find(
        (row) => row.provider === 'google',
      )!
      expect(connected.state).toBe('connected')
      await f.service.sync.disconnect(f.authority, 'google', connected.generation)
      expect((await f.connections.read(1, 'google'))?.sealedGrant).toBeNull()
      await f.service.authorization.processDue()
      expect(f.calls.filter((call) => call.url.endsWith('/revoke'))).toHaveLength(1)
      expect(await f.rows('SELECT status,sealed_grant FROM calendar_cleanup_obligations')).toEqual([
        { status: 'revoked', sealed_grant: null },
      ])
    })
    it('keeps an exchanged grant in encrypted cleanup custody if logout wins the callback race', async () => {
      const f = await fixture(kind),
        start = await f.start()
      f.setBeforeToken(async () => {
        await f.sessions.revoke(1, f.authority.sessionId)
      })
      await expect(
        f.service.authorization.complete(f.authority, 'google', {
          state: start.state,
          requester: start.requester,
          code: 'owned-code',
          denied: false,
          requestOrigin: 'https://owned.example',
        }),
      ).rejects.toThrow()
      expect(await f.connections.read(1, 'google')).toBeNull()
      const rows = await f.rows('SELECT status,sealed_grant FROM calendar_cleanup_obligations')
      expect(rows).toHaveLength(1)
      expect(JSON.stringify(rows)).not.toContain('PRIVATE_REFRESH')
      await f.service.authorization.processDue()
      expect(await f.rows('SELECT status FROM calendar_cleanup_obligations')).toEqual([
        { status: 'revoked' },
      ])
    })
    it('expires/denies requests without exchange and marks Microsoft cleanup honestly manual', async () => {
      const f = await fixture(kind),
        expired = await f.start()
      await f.run("UPDATE calendar_oauth_attempts SET expires_at='2000-01-01T00:00:00.000Z'")
      await expect(
        f.service.authorization.complete(f.authority, 'google', {
          state: expired.state,
          requester: expired.requester,
          code: 'owned',
          denied: false,
          requestOrigin: 'https://owned.example',
        }),
      ).rejects.toThrow()
      const denied = await f.start()
      await expect(
        f.service.authorization.complete(f.authority, 'google', {
          state: denied.state,
          requester: denied.requester,
          denied: true,
          requestOrigin: 'https://owned.example',
        }),
      ).rejects.toThrow()
      expect(f.calls).toHaveLength(0)
      const ms = await f.start('microsoft')
      await f.service.authorization.complete(f.authority, 'microsoft', {
        state: ms.state,
        requester: ms.requester,
        code: 'owned',
        denied: false,
        requestOrigin: 'https://owned.example',
      })
      await f.service.sync.disconnect(f.authority, 'microsoft', 1)
      await f.service.authorization.processDue()
      expect(f.calls).toHaveLength(1)
      expect(await f.rows('SELECT status FROM calendar_cleanup_obligations')).toEqual([
        { status: 'manual_required' },
      ])
    })
  })
