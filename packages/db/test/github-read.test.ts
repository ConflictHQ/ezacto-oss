import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { describeGithubReadStore } from '../../integrations/test/fixtures/github-read-store-suite.js'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import {
  receiveGithubWebhook,
  signGithubBody,
  GithubReadClient,
  reconcileGithubPage,
} from '@ezacto/integrations'
import { NativeGithubReadStore } from '../src/github-read.js'
import type { InvoiceStateDatabase } from '../src/invoice-state.js'

for (const runtime of ['SQLite', 'D1'] as const) {
  describe(`native GitHub reader ${runtime}`, () => {
    let database: InvoiceStateDatabase
    let run: (sql: string) => Promise<void>
    let dispose: () => Promise<void>
    beforeAll(async () => {
      if (runtime === 'SQLite') {
        const sqlite = new BetterSqlite3(':memory:')
        migrateContainer(sqlite)
        database = createContainerDatabase(sqlite) as InvoiceStateDatabase
        run = async (sql) => {
          sqlite.exec(sql)
        }
        dispose = async () => {
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
        dispose = () => mf.dispose()
      }
    }, 60_000)
    afterAll(async () => {
      await dispose?.()
    })
    class FaultableStore extends NativeGithubReadStore {
      fault: Promise<void> | undefined
      override async applyBatch(input: Parameters<NativeGithubReadStore['applyBatch']>[0]) {
        await this.fault
        return super.applyBatch(input)
      }
    }
    const make = async () => {
      await run('DROP TRIGGER IF EXISTS github_read_test_crash')
      for (const table of [
        'aliases',
        'items',
        'resources',
        'checkpoints',
        'deliveries',
        'guards',
        'connections',
      ])
        await run(`DELETE FROM github_read_${table}`)
      await run(
        "INSERT INTO github_read_connections(id,installation_id,account_id) VALUES('c1','22','33'),('c2','44','55')",
      )
      return new FaultableStore(database)
    }
    describeGithubReadStore(runtime, make, (store) => {
      ;(store as FaultableStore).fault = run(
        `CREATE TRIGGER github_read_test_crash BEFORE INSERT ON github_read_items WHEN NEW.issue_id='2' BEGIN SELECT RAISE(ABORT,'owned injected item failure'); END`,
      )
    })
    it('[native] recovers verified pending delivery after a real atomic failure and refuses foreign/reused deliveries', async () => {
      const store = await make()
      await run(
        "INSERT INTO github_read_resources(connection_id,repository_id,full_name) VALUES('c1','77','acme/app')",
      )
      const binding = {
        connectionId: 'c1',
        generation: 1,
        installationId: '22',
        appId: '11',
        accountId: '33',
        repositories: [{ repositoryId: '77', fullName: 'acme/app' }],
      }
      const payload = {
        installation: { id: 22 },
        repository: { id: 77 },
        action: 'opened',
        issue: {
          id: 2,
          number: 5,
          html_url: 'https://github.com/acme/app/issues/5',
          title: 'Owned fixture',
          state: 'open',
          updated_at: '2026-10-01T00:00:00Z',
          body: 'private-body-never-store',
        },
      }
      const body = new TextEncoder().encode(JSON.stringify(payload))
      const signature = await signGithubBody('owned-fixture-secret', body)
      const packet = {
        binding,
        store,
        body,
        signature,
        secret: 'owned-fixture-secret',
        event: 'issues',
        deliveryId: 'owned-delivery',
      }
      await run(
        `CREATE TRIGGER github_read_test_crash BEFORE INSERT ON github_read_items WHEN NEW.issue_id='2' BEGIN SELECT RAISE(ABORT,'owned injected item failure'); END`,
      )
      await expect(receiveGithubWebhook(packet)).rejects.toThrow()
      const nativeClient = database.$client
      const pendingRows =
        'batch' in nativeClient
          ? (
              await nativeClient
                .prepare(
                  "SELECT effect,state FROM github_read_deliveries WHERE delivery_id='owned-delivery'",
                )
                .all()
            ).results
          : nativeClient
              .prepare(
                "SELECT effect,state FROM github_read_deliveries WHERE delivery_id='owned-delivery'",
              )
              .all()
      expect(JSON.stringify(pendingRows)).toContain('pending')
      expect(JSON.stringify(pendingRows)).not.toContain('private-body-never-store')
      expect(await store.getItem('c1', '2')).toBeNull()
      await run('DROP TRIGGER github_read_test_crash')
      const restored = new NativeGithubReadStore(database, { connectionId: 'c1', generation: 1 })
      expect(await receiveGithubWebhook({ ...packet, store: restored })).toBe('applied')
      expect(await receiveGithubWebhook({ ...packet, store: restored })).toBe('duplicate')
      expect((await restored.getItem('c1', '2'))?.title).toBe('Owned fixture')
      expect(JSON.stringify(await restored.getItem('c1', '2'))).not.toContain(
        'private-body-never-store',
      )
      const foreign = new TextEncoder().encode(
        JSON.stringify({ ...payload, installation: { id: 44 } }),
      )
      expect(
        await receiveGithubWebhook({
          ...packet,
          body: foreign,
          signature: await signGithubBody('owned-fixture-secret', foreign),
        }),
      ).toBe('foreign_installation')
      const changed = new TextEncoder().encode(JSON.stringify({ ...payload, action: 'closed' }))
      await expect(
        receiveGithubWebhook({
          ...packet,
          body: changed,
          signature: await signGithubBody('owned-fixture-secret', changed),
        }),
      ).rejects.toThrow('identity was reused')
    })
    it('[native] verifies before parsing and prevents unsigned event-header relabelling from revoking an installation', async () => {
      const store = await make()
      const binding = {
        connectionId: 'c1',
        generation: 1,
        installationId: '22',
        appId: '11',
        accountId: '33',
        repositories: [{ repositoryId: '77', fullName: 'acme/app' }],
      }
      const body = new TextEncoder().encode(
        JSON.stringify({
          installation: { id: 22 },
          repository: { id: 77 },
          issue: { id: 1 },
          action: 'deleted',
        }),
      )
      const packet = {
        binding,
        store,
        body,
        signature: await signGithubBody('owned-secret', body),
        secret: 'owned-secret',
        event: 'installation',
        deliveryId: 'header-relabelling',
      }
      expect(
        await receiveGithubWebhook({
          ...packet,
          signature: 'sha256=' + '0'.repeat(64),
          body: new TextEncoder().encode('not JSON'),
        }),
      ).toBe('invalid_signature')
      expect(await receiveGithubWebhook(packet)).toBe('ignored')
      await store.applyItem({
        connectionId: 'c1',
        issueId: '123',
        repositoryId: '77',
        number: 7,
        canonicalUrl: 'https://github.com/acme/app/issues/7',
        title: 'Preserved other issue',
        state: 'open',
        remoteUpdatedAt: '2026-10-01T00:00:00Z',
        aliases: ['acme/app#7'],
        status: 'visible',
      })
      expect(
        await receiveGithubWebhook({
          ...packet,
          event: 'repository',
          deliveryId: 'repository-header-relabelling',
        }),
      ).toBe('ignored')
      expect((await store.getItem('c1', '123'))?.status).toBe('visible')
      expect((await store.reconciliation('c1')).resources[0]?.state).toBe('active')
      expect((await store.reconciliation('c1')).connectionState).toBe('active')
      const actual = new TextEncoder().encode(
        JSON.stringify({ installation: { id: 22, app_id: 11 }, action: 'deleted' }),
      )
      expect(
        await receiveGithubWebhook({
          ...packet,
          body: actual,
          signature: await signGithubBody('owned-secret', actual),
          deliveryId: 'real-installation-deletion',
        }),
      ).toBe('applied')
      expect((await store.reconciliation('c1')).connectionState).toBe('revoked')
      expect(
        await receiveGithubWebhook({
          ...packet,
          body: actual,
          signature: await signGithubBody('owned-secret', actual),
          deliveryId: 'real-installation-deletion',
        }),
      ).toBe('duplicate')
    })
    it.each(['edit', 'delete'] as const)(
      '[native] rescans issues skipped when an earlier page item changes by %s',
      async (change) => {
        const store = await make()
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
        const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----` // gitleaks:allow -- freshly generated in-memory fixture, no committed key material
        const now = Date.parse('2026-10-25T00:00:00Z')
        let rows = Array.from({ length: 101 }, (_, index) => ({
          id: index + 1,
          number: index + 1,
          html_url: `https://github.com/acme/app/issues/${index + 1}`,
          title: `Owned issue ${index + 1}`,
          state: 'open',
          updated_at: new Date(Date.parse('2026-10-01T00:00:00Z') + index * 1000).toISOString(),
        }))
        const queries: URL[] = []
        const client = new GithubReadClient({
          appId: '11',
          privateKey: pem,
          now: () => now,
          fetch: async (request) => {
            const url = new URL(request.url)
            if (request.method === 'POST')
              return Response.json({
                token: 'owned-short-token',
                expires_at: new Date(now + 3600000).toISOString(),
                permissions: { issues: 'read', metadata: 'read' },
                repositories: [{ id: 77, full_name: 'acme/app' }],
              })
            if (url.pathname === '/repos/acme/app')
              return Response.json({ id: 77, full_name: 'acme/app', owner: { id: 33 } })
            queries.push(url)
            const page = Number(url.searchParams.get('page')),
              limit = Number(url.searchParams.get('per_page')),
              since = url.searchParams.get('since')
            const filtered = rows
              .filter((row) => since === null || row.updated_at > since)
              .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
            const next = page * limit < filtered.length
            return Response.json(filtered.slice((page - 1) * limit, page * limit), {
              headers: next
                ? {
                    link: `<https://api.github.com/repos/acme/app/issues?page=${page + 1}>; rel="next"`,
                  }
                : {},
            })
          },
        })
        const binding = {
          connectionId: 'c1',
          generation: 1,
          installationId: '22',
          appId: '11',
          accountId: '33',
          repositories: [{ repositoryId: '77', fullName: 'acme/app' }],
        }
        const input = {
          binding,
          repository: binding.repositories[0]!,
          store,
          client,
          now,
          attempt: 1,
        }
        expect(await reconcileGithubPage(input)).toBe('applied')
        expect((await store.getCheckpoint('c1', '77'))?.status).toBe('running')
        if (change === 'delete') rows = rows.filter((row) => row.id !== 1)
        else rows[0]!.updated_at = new Date(now + 3600000).toISOString()
        const restored = new NativeGithubReadStore(database, { connectionId: 'c1', generation: 1 })
        expect(await reconcileGithubPage({ ...input, store: restored, now: now + 1000 })).toBe(
          'applied',
        )
        expect((await restored.getCheckpoint('c1', '77'))?.status).toBe('complete')
        expect(await restored.getItem('c1', '101')).toBeNull()
        // A completed mutable offset scan cannot certify an incremental high-water mark.
        const nextProcess = new NativeGithubReadStore(database, {
          connectionId: 'c1',
          generation: 1,
        })
        expect(
          await reconcileGithubPage({ ...input, store: nextProcess, now: now + 3600000 }),
        ).toBe('applied')
        expect(await nextProcess.getItem('c1', '101')).toMatchObject({
          issueId: '101',
          title: 'Owned issue 101',
        })
        expect((await nextProcess.getCheckpoint('c1', '77'))?.watermark).toBeNull()
        expect(queries.every((query) => !query.searchParams.has('since'))).toBe(true)
        const checkpoint = (await nextProcess.getCheckpoint('c1', '77'))!
        await nextProcess.applyBatch({
          connectionId: 'c1',
          repositoryId: '77',
          expectedVersion: checkpoint.version,
          items: [],
          next: {
            cursor: JSON.stringify({ page: 2, passStart: new Date(now).toISOString() }),
            watermark: new Date(now).toISOString(),
            status: 'running',
          },
        })
        expect(
          await reconcileGithubPage({ ...input, store: nextProcess, now: now + 3600001 }),
        ).toBe('applied')
        expect(queries.at(-1)?.searchParams.get('page')).toBe('1')
        expect(queries.at(-1)?.searchParams.has('since')).toBe(false)
        expect((await nextProcess.getCheckpoint('c1', '77'))?.watermark).toBeNull()
      },
    )
    it('[native] retains page/checkpoint across reconstruction, filters PRs, and fences provider results after reconnect', async () => {
      const store = await make()
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
      const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----` // gitleaks:allow -- freshly generated in-memory fixture, no committed key material
      const now = Date.parse('2026-10-25T00:00:00Z')
      const requested: string[] = []
      let invalidPage = false
      const client = new GithubReadClient({
        appId: '11',
        privateKey: pem,
        now: () => now,
        fetch: async (request) => {
          requested.push(new URL(request.url).pathname)
          if (request.method === 'POST')
            return Response.json({
              token: 'owned-short-token',
              expires_at: new Date(now + 3600000).toISOString(),
              permissions: { issues: 'read', metadata: 'read' },
              repositories: [{ id: 77, full_name: 'acme/app' }],
            })
          if (new URL(request.url).pathname === '/repos/acme/app')
            return Response.json({ id: 77, full_name: 'acme/app', owner: { id: 33 } })
          if (invalidPage) return Response.json([{ id: 'malformed-private-response' }])
          const page = new URL(request.url).searchParams.get('page')
          const issue = {
            id: page === '1' ? 1001 : 1002,
            number: page === '1' ? 5 : 6,
            html_url: `https://github.com/acme/app/issues/${page === '1' ? 5 : 6}`,
            title: 'Owned fixture',
            state: 'open',
            updated_at: '2026-10-01T00:00:00Z',
          }
          return Response.json([issue, { ...issue, id: 2000, pull_request: { url: 'ignored' } }], {
            headers: page === '1' ? { link: '<https://evil.test/not-followed>; rel="next"' } : {},
          })
        },
      })
      const binding = {
        connectionId: 'c1',
        generation: 1,
        installationId: '22',
        appId: '11',
        accountId: '33',
        repositories: [{ repositoryId: '77', fullName: 'acme/app' }],
      }
      const first = {
        binding,
        repository: binding.repositories[0]!,
        store,
        client,
        now,
        attempt: 1,
      }
      expect(await reconcileGithubPage(first)).toBe('applied')
      expect((await store.getCheckpoint('c1', '77'))?.status).toBe('running')
      expect((await store.reconciliation('c1')).itemsVisible).toBe(1)
      const restored = new NativeGithubReadStore(database, { connectionId: 'c1', generation: 1 })
      expect(await reconcileGithubPage({ ...first, store: restored, now: now + 1000 })).toBe(
        'applied',
      )
      expect(await restored.getCheckpoint('c1', '77')).toMatchObject({
        version: 2,
        status: 'complete',
        watermark: null,
      })
      expect((await restored.reconciliation('c1')).itemsVisible).toBe(2)
      invalidPage = true
      await expect(
        reconcileGithubPage({ ...first, store: restored, now: now + 2000 }),
      ).rejects.toMatchObject({ code: 'invalid_response' })
      expect((await restored.getCheckpoint('c1', '77'))?.version).toBe(2)
      const original = (await restored.getItem('c1', '1001'))!
      await restored.applyItem({
        ...original,
        repositoryId: '88',
        canonicalUrl: 'https://github.com/acme/next/issues/5',
        aliases: ['acme/next#5'],
        remoteUpdatedAt: '2026-10-26T00:00:00Z',
      })
      await restored.setResourceState('c1', '77', 'access_lost')
      expect((await restored.getItem('c1', '1001'))?.status).toBe('visible')
      expect((await restored.getItem('c1', '1001'))?.repositoryId).toBe('88')
      // A provider response begun in an earlier generation cannot cross reconnect.
      await run("UPDATE github_read_connections SET generation=2 WHERE id='c1'")
      await expect(restored.setCooldown('c1', now + 1000)).rejects.toThrow('fenced')
      expect(
        requested.every(
          (path) => path.startsWith('/app/installations/22/') || path.startsWith('/repos/acme/app'),
        ),
      ).toBe(true)
    })
    it('[native] preserves an unrelated original failure whose envelope contains the fence sentinel', async () => {
      const store = await make()
      await run(
        `CREATE TRIGGER github_read_test_crash BEFORE INSERT ON github_read_items BEGIN SELECT RAISE(ABORT,'unrelated envelope containing github_read_fenced'); END`,
      )
      const error = await store
        .applyItem({
          connectionId: 'c1',
          issueId: '999',
          repositoryId: '77',
          number: 1,
          canonicalUrl: 'https://github.com/acme/app/issues/1',
          title: 'github_read_fenced is ordinary issue text',
          state: 'open',
          remoteUpdatedAt: '2026-10-01T00:00:00Z',
          aliases: ['acme/app#1'],
          status: 'visible',
        })
        .catch((error: unknown) => error)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).name).not.toBe('GithubStoreFencedError')
      expect(String(error)).toContain('unrelated envelope')
      expect(await store.getItem('c1', '999')).toBeNull()
    })
    it('[native] leaves no transaction guard rows and retains connection fencing across reconstruction', async () => {
      const store = await make()
      await store.setCooldown('c1', 1234)
      await store.fence('c1', 'revoked')
      const restored = new NativeGithubReadStore(database)
      expect((await restored.reconciliation('c1')).connectionState).toBe('revoked')
      expect((await restored.reconciliation('c1')).deferredUntil).toBe(1234)
      const client = database.$client
      const result =
        'batch' in client
          ? (await client.prepare('SELECT count(*) count FROM github_read_guards').all()).results[0]
          : client.prepare('SELECT count(*) count FROM github_read_guards').get()
      expect(result).toEqual({ count: 0 })
    })
  })
}
