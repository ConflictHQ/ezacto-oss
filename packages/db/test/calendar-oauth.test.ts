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
import { createCalendarGrantVault } from '@ezacto/core'

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
  let tokenExpiry = 3600
  let tokenScope: string | undefined
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
          refresh_token:
            body.get('grant_type') === 'refresh_token' ? 'PRIVATE_ROTATED' : 'PRIVATE_REFRESH',
          expires_in: tokenExpiry,
          token_type: 'Bearer',
          scope:
            tokenScope ??
            (url.includes('microsoft')
              ? 'https://graph.microsoft.com/Calendars.Read offline_access'
              : 'https://www.googleapis.com/auth/calendar.readonly'),
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
    setTokenScope: (scope: string) => {
      tokenScope = scope
    },
    setTokenExpiry: (seconds: number) => {
      tokenExpiry = seconds
    },
  }
}
for (const kind of ['sqlite', 'd1'] as const)
  describe(kind + ' calendar OAuth custody', () => {
    it('blocks restored old-instance cleanup before a new token exchange', async () => {
      const f = await fixture(kind),
        start = await f.start('microsoft')
      await f.service.authorization.complete(f.authority, 'microsoft', {
        state: start.state,
        requester: start.requester,
        code: 'owned',
        denied: false,
        requestOrigin: 'https://owned.example',
      })
      await f.service.sync.disconnect(f.authority, 'microsoft', 1)
      await f.run('UPDATE calendar_sync_instance SET nonce=? WHERE singleton=1', 'f'.repeat(64))
      const before = f.calls.length
      const connection = await f.connections.read(1, 'microsoft')
      await expect(
        f.service.authorization.begin(
          f.authority,
          'microsoft',
          connection!.generation,
          'https://owned.example',
        ),
      ).rejects.toThrow()
      expect(f.calls).toHaveLength(before)
      expect(await f.service.authorization.manualCleanup(f.authority)).toEqual([])
      expect(await f.rows('SELECT * FROM calendar_manual_cleanup_receipts')).toHaveLength(0)
    })
    it('links a late issued grant to the account closure custody record', async () => {
      const f = await fixture(kind),
        start = await f.start()
      let closureFailure: unknown
      f.setBeforeToken(async () => {
        try {
          const stamp = new Date().toISOString()
          await f.run(
            "INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(3,'Owned','Administrator','administrator','[]',?,?)",
            stamp,
            stamp,
          )
          await f.run('UPDATE organization_owner SET user_id=3,updated_at=? WHERE id=1', stamp)
          await f.run(
            "INSERT INTO account_deletion_requests(id,user_id,requested_at,notification_updated_at,updated_at) VALUES('owned-closure',1,?,?,?)",
            stamp,
            stamp,
            stamp,
          )
          await f.run(
            'INSERT INTO account_retention_policies(version,policy_json,published_by_user_id,published_at) VALUES(1,?,3,?)',
            JSON.stringify({
              acknowledged: true,
              frameworks: [],
              retained_records: [],
              response_target_days: 14,
              operator_contact: 'privacy@example.test',
              user_notice: 'Fixture closure',
              backup_handling: 'Replay closure before access.',
            }),
            stamp,
          )
          await f.run(
            "INSERT INTO account_closures(request_id,user_id,actor_user_id,closed_at,policy_version,policy_snapshot,inventory_json,replay_keys,retained_identity,apple_cleanup) SELECT 'owned-closure',1,3,?,version,policy_json,'[]','[]',1,'not_linked' FROM account_retention_policies ORDER BY version DESC LIMIT 1",
            stamp,
          )
        } catch (error) {
          closureFailure = error
          throw error
        }
      })
      await expect(
        f.service.authorization.complete(f.authority, 'google', {
          state: start.state,
          requester: start.requester,
          code: 'owned',
          denied: false,
          requestOrigin: 'https://owned.example',
        }),
      ).rejects.toThrow()
      expect(closureFailure).toBeUndefined()
      expect(
        await f.rows(
          "SELECT request_id,reason,status FROM calendar_cleanup_obligations WHERE request_id='owned-closure'",
        ),
      ).toEqual([{ request_id: 'owned-closure', reason: 'closure', status: 'pending' }])
      expect(await f.connections.read(1, 'google')).toBeNull()
    })
    it('retains usable grants rejected by initial or refresh scope validation', async () => {
      for (const phase of ['initial', 'refresh']) {
        const f = await fixture(kind),
          start = await f.start()
        f.setTokenExpiry(1)
        const input = {
          state: start.state,
          requester: start.requester,
          code: 'owned',
          denied: false,
          requestOrigin: 'https://owned.example',
        }
        if (phase === 'refresh')
          await f.service.authorization.complete(f.authority, 'google', input)
        f.setTokenScope(
          'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar',
        )
        if (phase === 'initial')
          await expect(
            f.service.authorization.complete(f.authority, 'google', input),
          ).rejects.toThrow()
        else
          await expect(f.service.sync.refresh(f.authority, 'google')).resolves.toEqual({
            state: 'needs_reauth',
            applied: 0,
          })
        const rows = await f.rows('SELECT * FROM calendar_cleanup_obligations')
        expect(rows).toHaveLength(phase === 'initial' ? 1 : 2)
        expect(
          (await f.service.sync.connections(f.authority)).find((row) => row.provider === 'google')
            ?.cleanupPending,
        ).toBe(true)
        expect(JSON.stringify(rows)).not.toContain('PRIVATE_REFRESH')
        expect(JSON.stringify(rows)).not.toContain('PRIVATE_ROTATED')
        expect((await f.connections.read(1, 'google'))?.state ?? 'missing').toBe(
          phase === 'initial' ? 'missing' : 'needs_reauth',
        )
        await f.service.authorization.processDue()
        expect(f.calls.filter((call) => call.url.endsWith('/revoke'))).toHaveLength(rows.length)
      }
    })
    it('recognizes an initial connection committed before its response was lost', async () => {
      const f = await fixture(kind),
        start = await f.start()
      const connect = f.connections.connect.bind(f.connections)
      f.connections.connect = async (...args) => {
        await connect(...args)
        throw new Error('owned lost response')
      }
      await expect(
        f.service.authorization.complete(f.authority, 'google', {
          state: start.state,
          requester: start.requester,
          code: 'owned',
          denied: false,
          requestOrigin: 'https://owned.example',
        }),
      ).resolves.toBeUndefined()
      expect(await f.rows('SELECT * FROM calendar_cleanup_obligations')).toEqual([])
      expect((await f.connections.read(1, 'google'))?.state).toBe('connected')
      await f.service.authorization.processDue()
      expect(f.calls.filter((call) => call.url.endsWith('/revoke'))).toHaveLength(0)
    })
    it('does not revoke a rotated grant whose write committed before a lost response', async () => {
      const f = await fixture(kind),
        start = await f.start()
      f.setTokenExpiry(1)
      await f.service.authorization.complete(f.authority, 'google', {
        state: start.state,
        requester: start.requester,
        code: 'owned',
        denied: false,
        requestOrigin: 'https://owned.example',
      })
      const rotate = f.connections.rotate.bind(f.connections)
      f.connections.rotate = async (...args) => {
        await rotate(...args)
        throw new Error('owned lost response')
      }
      await expect(f.service.sync.refresh(f.authority, 'google')).rejects.toThrow()
      expect(await f.rows('SELECT * FROM calendar_cleanup_obligations')).toEqual([])
      const installed = await f.connections.read(1, 'google')
      expect(installed?.state).toBe('connected')
      expect(installed?.credentialRevision).toBe(2)
      await f.service.authorization.processDue()
      expect(f.calls.filter((call) => call.url.endsWith('/revoke'))).toHaveLength(0)
    })
    it('retains a rotated grant if disconnect wins its refresh race', async () => {
      const f = await fixture(kind),
        start = await f.start()
      f.setTokenExpiry(1)
      await f.service.authorization.complete(f.authority, 'google', {
        state: start.state,
        requester: start.requester,
        code: 'owned',
        denied: false,
        requestOrigin: 'https://owned.example',
      })
      f.setBeforeToken(async () => {
        await f.service.sync.disconnect(f.authority, 'google', 1)
      })
      await expect(f.service.sync.refresh(f.authority, 'google')).rejects.toThrow()
      expect((await f.connections.read(1, 'google'))?.state).toBe('disconnected')
      const records = await f.rows('SELECT * FROM calendar_cleanup_obligations')
      expect(records).toHaveLength(2)
      const vault = await createCalendarGrantVault(new Uint8Array(32).fill(7))
      const tokens = await Promise.all(
        records.map(async (raw) => {
          const r = raw as Record<string, unknown>
          return (
            await vault.openGrant(String(r.sealed_grant), {
              userId: Number(r.user_id),
              provider: 'google',
              instance: String(r.instance_nonce),
              generation: Number(r.generation),
              credentialRevision: Number(r.credential_revision),
            })
          ).refreshToken
        }),
      )
      expect(tokens.sort()).toEqual(['PRIVATE_REFRESH', 'PRIVATE_ROTATED'])
      await f.service.authorization.processDue()
      expect(f.calls.filter((call) => call.url.endsWith('/revoke'))).toHaveLength(2)
    })
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
      const adminConsent = await f.start('microsoft')
      await expect(
        f.service.authorization.complete(f.authority, 'microsoft', {
          state: adminConsent.state,
          requester: adminConsent.requester,
          denied: true,
          consentRequired: true,
          requestOrigin: 'https://owned.example',
        }),
      ).rejects.toMatchObject({ code: 'consent_required' })
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
      const pending = await f.service.authorization.manualCleanup(f.authority)
      expect(pending).toHaveLength(1)
      const item = pending[0]!
      const confirmation = {
        id: item.id,
        generation: item.generation,
        credentialRevision: item.credential_revision,
      }
      await expect(
        f.service.authorization.confirmManualCleanup(f.other, confirmation),
      ).rejects.toThrow()
      await expect(
        f.service.authorization.confirmManualCleanup(f.authority, {
          ...confirmation,
          generation: item.generation + 1,
        }),
      ).rejects.toThrow()
      await f.service.authorization.confirmManualCleanup(f.authority, confirmation)
      await f.service.authorization.confirmManualCleanup(f.authority, confirmation)
      expect(await f.rows('SELECT assertion FROM calendar_manual_cleanup_receipts')).toEqual([
        { assertion: 'owner_confirmed_provider_permission_removal' },
      ])
      await expect(
        f.run("UPDATE calendar_manual_cleanup_receipts SET assertion='changed'"),
      ).rejects.toThrow()
      const closed = await f.rows(
        'SELECT sealed_grant,sealed_receipt FROM calendar_cleanup_obligations',
      )
      expect((closed[0] as { sealed_grant: unknown }).sealed_grant).toBeNull()
      expect(JSON.stringify(closed)).toContain('user_attestation')
      expect(JSON.stringify(closed)).not.toContain('provider_token_revocation')
      const status = (await f.service.sync.connections(f.authority)).find(
        (row) => row.provider === 'microsoft',
      )!
      expect(status.cleanupPending).toBe(false)
      expect(
        (
          await f.service.authorization.begin(
            f.authority,
            'microsoft',
            status.generation,
            'https://owned.example',
          )
        ).authorizationUrl,
      ).toContain('login.microsoftonline.com')
    })
    it('never accepts manual confirmation for closure, restore or another incarnation', async () => {
      const f = await fixture(kind),
        ms = await f.start('microsoft')
      await f.service.authorization.complete(f.authority, 'microsoft', {
        state: ms.state,
        requester: ms.requester,
        code: 'owned',
        denied: false,
        requestOrigin: 'https://owned.example',
      })
      await f.service.sync.disconnect(f.authority, 'microsoft', 1)
      await f.service.authorization.processDue()
      const original = (await f.service.authorization.manualCleanup(f.authority))[0]!
      for (const [index, reason] of ['closure', 'restore', 'reauth'].entries()) {
        const id = String(index + 3).repeat(64),
          generation = original.generation + index + 10
        await f.run(
          `INSERT INTO calendar_cleanup_obligations(id,user_id,provider,instance_nonce,generation,credential_revision,key_id,sealed_grant,reason,status,created_at)
          SELECT ?,user_id,provider,?, ?,credential_revision,key_id,sealed_grant,?,'manual_required',created_at FROM calendar_cleanup_obligations WHERE id=?`,
          id,
          index === 2 ? '0'.repeat(64) : await f.connections.instance(),
          generation,
          reason,
          original.id,
        )
        await expect(
          f.service.authorization.confirmManualCleanup(f.authority, {
            id,
            generation,
            credentialRevision: original.credential_revision,
          }),
        ).rejects.toThrow()
      }
      expect(await f.service.authorization.manualCleanup(f.authority)).toHaveLength(1)
      expect(await f.rows('SELECT * FROM calendar_manual_cleanup_receipts')).toHaveLength(0)
    })
  })
