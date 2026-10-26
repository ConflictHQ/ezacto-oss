import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { githubReaderMigration } from '../src/migrations/0171_github_reader.js'
import { NativeGithubReaderAdmin } from '../src/github-reader-admin.js'
import { NativeGithubReadStore } from '../src/github-read.js'
import { NativeGithubReaderWork } from '../src/github-reader-work.js'
import { atomicStatements } from '../src/atomic-statements.js'
import { createGithubAppSetup } from '../src/github-app-setup.js'
import { createGithubReaderService } from '../src/github-reader-service.js'
import type { InvoiceStateDatabase } from '../src/invoice-state.js'
const now = '2026-10-25T12:00:00.000Z'
const authority = { userId: 2, sessionId: 102 }
for (const runtime of ['SQLite', 'D1'] as const)
  describe(`GitHub native administrator ${runtime}`, () => {
    let database: InvoiceStateDatabase,
      run: (sql: string) => Promise<void>,
      close: () => Promise<void>,
      admin: NativeGithubReaderAdmin
    beforeAll(async () => {
      if (runtime === 'SQLite') {
        const sqlite = new BetterSqlite3(':memory:')
        migrateContainer(sqlite)
        database = createContainerDatabase(sqlite) as InvoiceStateDatabase
        run = async (sql) => {
          sqlite.exec(sql)
        }
        close = async () => {
          sqlite.close()
        }
      } else {
        const mf = new Miniflare({
          modules: true,
          script: 'export default {fetch(){return new Response("ok")}}',
          d1Databases: ['DB'],
        })
        const d1 = await mf.getD1Database('DB')
        await migrateD1(d1)
        database = createD1Database(d1) as InvoiceStateDatabase
        run = async (sql) => {
          await d1.prepare(sql).run()
        }
        close = () => mf.dispose()
      }
      for (const statement of githubReaderMigration) await run(statement)
      await run(
        `INSERT INTO organizations(name,modules,time_entry_mode,created_at,updated_at) VALUES('Owned native fixture','{}','duration','${now}','${now}')`,
      )
      await run(
        `INSERT INTO users(id,first_name,last_name,profile,manager_grants,timezone,created_at,updated_at) VALUES(1,'Owned','Owner','administrator','[]','UTC','${now}','${now}'),(2,'Other','Administrator','administrator','[]','UTC','${now}','${now}'),(3,'Scoped','Member','member','[]','UTC','${now}','${now}')`,
      )
      await run(
        `INSERT INTO organization_owner(id,user_id,updated_at) VALUES(1,1,'${now}') ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id`,
      )
      await run(
        `INSERT INTO sessions(id,user_id,selector,secret_hash,profile_snapshot,manager_grants_snapshot,created_at,last_seen_at,idle_expires_at,absolute_expires_at,updated_at) VALUES(102,2,'AAAAAAAAAAAAAAAB','${'a'.repeat(64)}','administrator','[]','${now}','${now}','2026-10-25T13:00:00.000Z','2026-10-26T12:00:00.000Z','${now}'),(103,3,'AAAAAAAAAAAAAAAC','${'b'.repeat(64)}','member','[]','${now}','${now}','2026-10-25T13:00:00.000Z','2026-10-26T12:00:00.000Z','${now}')`,
      )
      await run(
        `INSERT INTO clients(id,name,currency,created_at,updated_at) VALUES(1,'Owned client','EUR','${now}','${now}')`,
      )
      await run(
        `INSERT INTO projects(id,client_id,name,bill_by,created_at,updated_at) VALUES(1,1,'Existing project','tasks','${now}','${now}')`,
      )
      await run(
        `INSERT INTO tasks(id,name,created_at,updated_at) VALUES(1,'Existing task','${now}','${now}')`,
      )
      await run(
        `INSERT INTO task_assignments(project_id,task_id,billable,created_at,updated_at) VALUES(1,1,0,'${now}','${now}')`,
      )
      admin = new NativeGithubReaderAdmin(database)
    }, 60000)
    afterAll(async () => close?.())
    const verified = (installationId: string) => ({
      appId: '11',
      installationId,
      accountId: '33',
      repositoryId: '77',
      fullName: 'owned/disposable',
      projectId: 1,
      taskId: 1,
    })
    it('[native] permits an actual nonowner administrator, records mapping atomically, and safely replays exact commands', async () => {
      const command = {
        commandId: crypto.randomUUID(),
        expectedGeneration: 0,
        verified: verified('21'),
      }
      const result = await admin.map(authority, command, now)
      expect(result).toEqual({ connectionId: '11:21:33', generation: 1 })
      expect(await admin.map(authority, command, now)).toEqual(result)
      expect(await admin.binding(result.connectionId)).toMatchObject({
        installationId: '21',
        accountId: '33',
        generation: 1,
        repositories: [{ repositoryId: '77', fullName: 'owned/disposable' }],
      })
      await expect(
        admin.map(authority, { ...command, verified: { ...command.verified, taskId: 2 } }, now),
      ).rejects.toMatchObject({ code: 'command_reused' })
      await expect(
        admin.map(authority, { ...command, commandId: crypto.randomUUID() }, now),
      ).rejects.toMatchObject({ code: 'conflict' })
    })
    it('[native] member, wrong session and expired sessions cannot configure or inspect native mutation receipts', async () => {
      for (const actor of [
        { userId: 3, sessionId: 103 },
        { userId: 2, sessionId: 103 },
      ])
        await expect(
          admin.map(
            actor,
            { commandId: crypto.randomUUID(), expectedGeneration: 0, verified: verified('22') },
            now,
          ),
        ).rejects.toMatchObject({ code: 'forbidden' })
      await expect(
        admin.map(
          authority,
          { commandId: crypto.randomUUID(), expectedGeneration: 0, verified: verified('22') },
          '2026-10-26T12:00:00.000Z',
        ),
      ).rejects.toMatchObject({ code: 'forbidden' })
      expect(await admin.binding('11:22:33')).toBeNull()
    })
    it('[native] refuses nonexistent or unassigned local targets without creating a connection or consuming its command', async () => {
      const commandId = crypto.randomUUID()
      await expect(
        admin.map(
          authority,
          { commandId, expectedGeneration: 0, verified: { ...verified('23'), taskId: 999 } },
          now,
        ),
      ).rejects.toMatchObject({ code: 'conflict' })
      expect(await admin.binding('11:23:33')).toBeNull()
      expect(
        await admin.map(
          authority,
          { commandId, expectedGeneration: 0, verified: verified('23') },
          now,
        ),
      ).toMatchObject({ generation: 1 })
    })
    it('[native] disconnect is audited and fences old provider work; reconnect advances generation', async () => {
      const mapping = await admin.map(
        authority,
        { commandId: crypto.randomUUID(), expectedGeneration: 0, verified: verified('24') },
        now,
      )
      const old = new NativeGithubReadStore(database, {
        connectionId: mapping.connectionId,
        generation: 1,
      })
      const command = {
        commandId: crypto.randomUUID(),
        connectionId: mapping.connectionId,
        expectedGeneration: 1,
      }
      expect(await admin.disconnect(authority, command, now)).toEqual({ generation: 2 })
      expect(await admin.disconnect(authority, command, now)).toEqual({ generation: 2 })
      expect(await admin.binding(mapping.connectionId)).toBeNull()
      await expect(old.setCooldown(mapping.connectionId, 1234)).rejects.toThrow('fenced')
      const reconnected = await admin.map(
        authority,
        { commandId: crypto.randomUUID(), expectedGeneration: 2, verified: verified('24') },
        now,
      )
      expect(reconnected.generation).toBe(3)
      await expect(old.setCooldown(mapping.connectionId, 1234)).rejects.toThrow('fenced')
    })
    it('[native] exposes verified metadata only through the existing locally authorized link', async () => {
      const mapped = await admin.map(
        authority,
        { commandId: crypto.randomUUID(), expectedGeneration: 0, verified: verified('29') },
        now,
      )
      await run(
        `INSERT INTO user_assignments(project_id,user_id,created_at,updated_at) VALUES(1,3,'${now}','${now}')`,
      )
      await run(
        `INSERT INTO time_entries(id,user_id,project_id,task_id,user_assignment_id,task_assignment_id,spent_date,seconds,seconds_without_timer,rounded_seconds,billable,created_at,updated_at) VALUES(91,3,1,1,(SELECT id FROM user_assignments WHERE user_id=3 AND project_id=1),(SELECT id FROM task_assignments WHERE project_id=1 AND task_id=1),'2026-10-24',3600,3600,3600,0,'${now}','${now}')`,
      )
      await run(
        `INSERT INTO work_item_links(id,connection_id,time_entry_id,provider_item_id,url,created_by,created_at,updated_at) SELECT 81,id,91,'owned/disposable#5','https://github.com/owned/disposable/issues/5',3,'${now}','${now}' FROM work_item_connections WHERE provider='github'`,
      )
      const store = new NativeGithubReadStore(database, {
        connectionId: mapped.connectionId,
        generation: 1,
      })
      await store.applyItem({
        connectionId: mapped.connectionId,
        issueId: '501',
        repositoryId: '77',
        number: 5,
        canonicalUrl: 'https://github.com/owned/disposable/issues/5',
        title: 'Authorized metadata',
        state: 'open',
        remoteUpdatedAt: now,
        aliases: ['owned/disposable#5'],
        status: 'visible',
      })
      expect(await admin.linkedItem({ userId: 3, profile: 'member' }, 81)).toMatchObject({
        status: 'verified',
        item: { id: '501', title: 'Authorized metadata' },
      })
      expect(await admin.linkedItem({ userId: 1, profile: 'member' }, 81)).toBeNull()
      await run('UPDATE user_assignments SET is_active=0 WHERE user_id=3')
      expect(await admin.linkedItem({ userId: 3, profile: 'member' }, 81)).toBeNull()
      expect(await admin.linkedItem({ userId: 2, profile: 'administrator' }, 81)).toMatchObject({
        status: 'verified',
      })
      await run(
        `UPDATE work_item_connections SET status='disconnected',credential_ref=NULL,disconnected_at='${now}',updated_at='${now}' WHERE provider='github'`,
      )
      expect(await admin.binding(mapped.connectionId)).toBeNull()
      await expect(store.setCooldown(mapped.connectionId, 123)).rejects.toThrow('fenced')
      expect(await admin.linkedItem({ userId: 2, profile: 'administrator' }, 81)).toMatchObject({
        status: 'unavailable',
      })
    })
    it('[native] leases one bounded resource and preserves a deferred provider cooldown', async () => {
      const mapped = await admin.map(
        authority,
        { commandId: crypto.randomUUID(), expectedGeneration: 0, verified: verified('30') },
        now,
      )
      const timestamp = Date.parse(now)
      await run(`UPDATE github_read_resources SET next_due=${timestamp + 3600000}`)
      await run(
        `UPDATE github_read_resources SET next_due=0 WHERE connection_id='${mapped.connectionId}'`,
      )
      const work = new NativeGithubReaderWork(database)
      const [first, second] = await Promise.all([work.claim(timestamp), work.claim(timestamp)])
      expect([first, second].filter(Boolean)).toHaveLength(1)
      const lease = (first ?? second)!
      const store = new NativeGithubReadStore(database, {
        connectionId: mapped.connectionId,
        generation: 1,
      })
      await store.setCooldown(mapped.connectionId, timestamp + 600000)
      await work.finish(lease, timestamp + 1, 'deferred', 'rate_limited')
      expect(await work.claim(timestamp + 60000)).toBeNull()
      expect(
        (await admin.status(authority, now)).find((item) => item.id === mapped.connectionId),
      ).toMatchObject({
        failure_codes: ['rate_limited'],
        resources: [expect.objectContaining({ attempts: 1, failure_code: 'rate_limited' })],
      })
      expect(await work.claim(timestamp + 600001)).toMatchObject({
        connectionId: mapped.connectionId,
        attempt: 2,
      })
    })
    it('[native] service authenticates before provider work and projects only confirmed repository metadata', async () => {
      const keys = await crypto.subtle.generateKey(
        {
          name: 'RSASSA-PKCS1-v1_5',
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: 'SHA-256',
        },
        true,
        ['sign', 'verify'],
      )
      const privateKey = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----`
      const requests: Request[] = []
      let enabled = true
      const service = createGithubReaderService(database, {
        credentials: async () =>
          enabled ? { appId: '11', privateKey, webhookSecret: 'fixture-webhook-secret' } : null,
        now: () => new Date(now),
        fetch: async (request) => {
          requests.push(request)
          const path = new URL(request.url).pathname
          if (path === '/app/installations/31')
            return Response.json({
              id: 31,
              account: { id: 33 },
              suspended_at: null,
              permissions: { issues: 'read' },
              repository_selection: 'selected',
            })
          if (path.endsWith('/access_tokens'))
            return Response.json({
              token: 'installation-token-canary',
              expires_at: '2026-10-25T13:00:00Z',
              permissions: { issues: 'read', metadata: 'read' },
              repositories: [{ id: 77, full_name: 'owned/disposable' }],
            })
          if (path === '/repos/owned/disposable')
            return Response.json({ id: 77, full_name: 'owned/disposable', owner: { id: 33 } })
          if (path === '/repos/owned/disposable/issues') return Response.json([])
          throw new Error('unexpected provider request')
        },
      })
      const input = {
        command_id: crypto.randomUUID(),
        expected_generation: 0,
        installation_id: '31',
        repository_id: '77',
        project_id: 1,
        task_id: 1,
      }
      await expect(service.map({ userId: 3, sessionId: 103 }, input)).rejects.toMatchObject({
        kind: 'forbidden',
      })
      expect(requests).toHaveLength(0)
      expect(await service.map(authority, input)).toEqual({
        connection_id: '11:31:33',
        generation: 1,
      })
      expect(requests.map((request) => new URL(request.url).origin)).toEqual(
        Array(3).fill('https://api.github.com'),
      )
      await run(`UPDATE github_read_resources SET next_due=${Date.parse(now) + 3600000}`)
      await run("UPDATE github_read_resources SET next_due=0 WHERE connection_id='11:31:33'")
      await service.tick()
      expect(requests).toHaveLength(7)
      const status = await service.status(authority)
      expect(status).toMatchObject({
        configured: true,
        owned_acceptance_required: true,
        connections: expect.arrayContaining([
          expect.objectContaining({
            id: '11:31:33',
            resources: [
              expect.objectContaining({ repository_id: '77', checkpoint_status: 'complete' }),
            ],
          }),
        ]),
      })
      expect(JSON.stringify(status)).not.toMatch(
        /installation-token-canary|fixture-webhook-secret|PRIVATE KEY/,
      )
      enabled = false
      await service.tick()
      expect(requests).toHaveLength(7)
      expect(await service.status(authority)).toMatchObject({ configured: false, available: false })
      await expect(
        service.map(authority, { ...input, command_id: crypto.randomUUID() }),
      ).rejects.toMatchObject({ kind: 'unavailable' })
    })
    it('[security] binds manifest completion to the native session, consumes state once, and stores only encrypted App secrets', async () => {
      const keys = await crypto.subtle.generateKey(
        {
          name: 'RSASSA-PKCS1-v1_5',
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: 'SHA-256',
        },
        true,
        ['sign', 'verify'],
      )
      const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----`
      let calls = 0
      const setup = createGithubAppSetup(database, {
        key: Buffer.alloc(32, 7).toString('base64url'),
        origin: 'https://owned.example',
        now: () => new Date(now),
        fetch: async (request) => {
          calls++
          expect(request.url).toBe('https://api.github.com/app-manifests/owned-code/conversions')
          expect(request.redirect).toBe('manual')
          return Response.json({
            id: 11,
            slug: 'owned-issue-reader',
            pem,
            webhook_secret: 'private-webhook-canary',
          })
        },
      })
      expect(await setup.supported()).toBe(true)
      const manifest = await setup.begin(authority, 'Owned-Org')
      expect(JSON.parse(manifest.manifest)).toMatchObject({
        public: false,
        default_permissions: { issues: 'read', metadata: 'read' },
        hook_attributes: { url: 'https://owned.example/webhooks/github-work-items' },
      })
      const state = new URL(manifest.registration_url).searchParams.get('state')!
      await expect(
        setup.complete({ userId: 3, sessionId: 103 }, state, 'owned-code'),
      ).rejects.toMatchObject({ kind: 'forbidden' })
      expect(calls).toBe(0)
      await expect(setup.complete(authority, 'a'.repeat(43), 'owned-code')).rejects.toMatchObject({kind:'conflict'})
      await setup.complete(authority, state, 'owned-code')
      expect(calls).toBe(1)
      expect(await setup.credentials()).toEqual({
        appId: '11',
        privateKey: pem,
        webhookSecret: 'private-webhook-canary',
      })
      const persisted = await atomicStatements(database, [
        { text: 'SELECT * FROM github_app_credentials', params: [] },
      ])
      expect(JSON.stringify(persisted)).not.toMatch(/private-webhook-canary|BEGIN PRIVATE KEY/)
      await expect(setup.complete(authority, state, 'owned-code')).rejects.toMatchObject({
        kind: 'conflict',
      })
      expect(calls).toBe(1)
      const wrongOrigin=createGithubAppSetup(database,{key:Buffer.alloc(32,7).toString('base64url'),origin:'https://other.example',now:()=>new Date(now),fetch:async()=>{throw new Error('no provider I/O')}})
      await expect(wrongOrigin.credentials()).rejects.toMatchObject({kind:'unavailable'})
    })
    it('[native] does not disclose a recovered receipt after native authority was revoked', async () => {
      const command = {
        commandId: crypto.randomUUID(),
        expectedGeneration: 0,
        verified: verified('25'),
      }
      await admin.map(authority, command, now)
      await run(
        `UPDATE sessions SET revoked_at='${now}',revocation_reason='user_revoked',updated_at='${now}' WHERE id=102`,
      )
      await expect(admin.map(authority, command, now)).rejects.toMatchObject({ code: 'forbidden' })
    })
  })
