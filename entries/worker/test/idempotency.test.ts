import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  deriveIdempotencySecret,
  IDEMPOTENCY_KEY_LIFETIME_HEADER,
  withIdempotency,
  type IdempotencyStore,
  type IdempotencyOptions,
} from '@ezacto/api'
import { createD1IdempotencyStore, createIdempotentD1, migrateD1 } from '@ezacto/db/d1'
import { createContainerIdempotencyStore, createIdempotentSqlite, migrateContainer } from '@ezacto/db'
import { createContainerDatabase, createD1Database, DrizzleAllocationRepository } from '@ezacto/db'

/**
 * The HTTP half of idempotency keys (#952) over both real stores: D1 through
 * Miniflare and the container's SQLite, each fully migrated. The app under the
 * wrapper is a stand-in route that writes through the riding handle exactly
 * the way every repository does.
 */

interface Runtime {
  planning: DrizzleAllocationRepository
  run(sql: string, ...params: unknown[]): Promise<void>
  insert(note: string): Promise<number>
  rows<T>(sql: string, ...params: unknown[]): Promise<T[]>
  store: IdempotencyStore
  close(): Promise<void>
}

const scratch = `CREATE TABLE idempotency_test_notes (
  id INTEGER PRIMARY KEY, note TEXT NOT NULL
) STRICT`

const d1Runtime = async (): Promise<Runtime> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const binding = await miniflare.getD1Database('DB')
  await migrateD1(binding)
  await binding.prepare(scratch).run()
  const riding = createIdempotentD1(binding)
  return {
    planning: new DrizzleAllocationRepository(createD1Database(riding)),
    run: async (sql, ...params) => { await binding.prepare(sql).bind(...params).run() },
    insert: async (note) =>
      (await riding
        .prepare('INSERT INTO idempotency_test_notes (note) VALUES (?) RETURNING id')
        .bind(note)
        .first<{ id: number }>())!.id,
    rows: async <T>(sql: string, ...params: unknown[]) =>
      (
        await binding
          .prepare(sql)
          .bind(...params)
          .all<T>()
      ).results,
    store: createD1IdempotencyStore(binding),
    close: () => miniflare.dispose(),
  }
}

const containerRuntime = async (): Promise<Runtime> => {
  const handle = new BetterSqlite3(':memory:')
  migrateContainer(handle)
  handle.exec(scratch)
  const riding = createIdempotentSqlite(handle)
  return {
    planning: new DrizzleAllocationRepository(createContainerDatabase(riding)),
    run: async (sql, ...params) => { handle.prepare(sql).run(...params) },
    insert: async (note) =>
      (
        riding.prepare('INSERT INTO idempotency_test_notes (note) VALUES (?) RETURNING id').get(note) as {
          id: number
        }
      ).id,
    rows: async <T>(sql: string, ...params: unknown[]) => handle.prepare(sql).all(...params) as T[],
    store: createContainerIdempotencyStore(handle),
    close: async () => {
      handle.close()
    },
  }
}

const runtimes = [
  ['D1', d1Runtime],
  ['container', containerRuntime],
] as const

const startedAt = new Date('2026-10-07T12:00:00.000Z')

const gate = () => {
  let open: () => void = () => undefined
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { opened, open }
}

for (const [name, create] of runtimes) {
  describe(`withIdempotency over the ${name} store`, () => {
    let runtime: Runtime
    let secret: Uint8Array
    let clock: Date
    let calls: number
    let reported: unknown[]

    beforeAll(async () => {
      runtime = await create()
      secret = await deriveIdempotencySecret(new Uint8Array(32).fill(0x41))
    })
    afterAll(async () => runtime.close())
    beforeEach(() => {
      clock = startedAt
      calls = 0
      reported = []
    })

    const notesCalled = async (note: string): Promise<number> =>
      (
        await runtime.rows<{ n: number }>(
          'SELECT count(*) AS n FROM idempotency_test_notes WHERE note = ?',
          note,
        )
      )[0]!.n

    interface Route {
      beforeWrite?: () => Promise<void>
      afterWrite?: () => Promise<void>
      answer?: (id: number) => Response
      write?: boolean
      crash?: boolean
    }

    /** A stand-in for any OSS route: reads its body, writes once, answers. */
    const route =
      (behaviour: Route = {}) =>
      async (request: Request): Promise<Response> => {
        calls += 1
        const { note } = (await request.json()) as { note: string }
        await behaviour.beforeWrite?.()
        const id = behaviour.write === false ? 0 : await runtime.insert(note)
        await behaviour.afterWrite?.()
        if (behaviour.crash === true) throw new Error('the instance went away mid-request')
        if (behaviour.answer !== undefined) return behaviour.answer(id)
        return Response.json(
          { data: { id, note } },
          {
            status: 201,
            headers: {
              'x-request-id': crypto.randomUUID(),
              'set-cookie': `ezacto_session=secret-${id}; Path=/; HttpOnly`,
            },
          },
        )
      }

    const send = (
      key: string | null,
      note: string,
      run: (request: Request) => Promise<Response>,
      init: { method?: string; path?: string; contentType?: string; credentials?: HeadersInit } = {},
      extra: {
        authorize?: IdempotencyOptions['authorize']
        waitUntil?: (promise: Promise<unknown>) => void
        secret?: Uint8Array
        waitForClaimMs?: number
      } = {},
    ): Promise<Response> => {
      const headers = new Headers(init.credentials ?? { authorization: 'Bearer ezat_first' })
      headers.set('content-type', init.contentType ?? 'application/json')
      if (key !== null) headers.set('idempotency-key', key)
      return withIdempotency(
        new Request(`https://ezacto.test${init.path ?? '/api/v1/time-entries'}`, {
          method: init.method ?? 'POST',
          headers,
          body: JSON.stringify({ note }),
        }),
        run,
        {
          store: runtime.store,
          authorize: extra.authorize ?? (async () => 'fixture-authorized'),
          secret: extra.secret ?? secret,
          now: () => clock,
          report: (error) => reported.push(error),
          // Short, so a duplicate held off by a stalled first attempt is told
          // to come back within the test rather than after the default wait.
          waitForClaimMs: extra.waitForClaimMs ?? 200,
          ...(extra.waitUntil === undefined ? {} : { waitUntil: extra.waitUntil }),
        },
      )
    }

    const snapshot = async (response: Response) => ({
      status: response.status,
      body: await response.text(),
      requestId: response.headers.get('x-request-id'),
      cookies: response.headers.getSetCookie(),
      lifetime: response.headers.get(IDEMPOTENCY_KEY_LIFETIME_HEADER),
    })

    it('[#1193] replays one exact allocation date command, reauthorizes it, and leaves actual/financial data unchanged', async () => {
      const at = startedAt.toISOString()
      await runtime.run("INSERT INTO organizations(id,name,modules,created_at,updated_at) VALUES(1,'Owned planning','{}',?,?)", at, at)
      await runtime.run("INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(1,'Owned','Admin','administrator','[]',?,?)", at, at)
      await runtime.run("INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(2,'Retained','Admin','administrator','[]',?,?)", at, at)
      await runtime.run("INSERT INTO clients(id,name,currency,created_at,updated_at) VALUES(1,'Owned client','USD',?,?)", at, at)
      await runtime.run("INSERT INTO projects(id,client_id,name,created_at,updated_at) VALUES(1,1,'Owned project',?,?)", at, at)
      const actor = { userId: 2, profile: 'administrator', managerGrants: [] } as const
      const source = await runtime.planning.create(actor, { userId: 2, projectId: 1, startDate: '2026-10-06', endDate: '2026-10-07', plannedSecondsPerWeek: 4442 }, at)
      const fingerprint = async () => {
        const result = []
        for (const table of ['time_entries', 'time_approvals', 'invoices', 'invoice_items', 'payments', 'projects', 'user_assignments', 'task_assignments']) {
          const exists = await runtime.rows("SELECT name FROM sqlite_schema WHERE type='table' AND name=?", table)
          if (exists.length) result.push([table, await runtime.rows(`SELECT * FROM ${table} ORDER BY id`)])
        }
        return JSON.stringify(result)
      }
      const before = await fingerprint(), dates = { start_date: '2026-10-12', end_date: '2026-10-14', version: 0 }, key = crypto.randomUUID()
      let writes = 0
      const answer = async (request: Request) => {
        const patch = await request.json() as typeof dates
        writes++
        const result = await runtime.planning.update(actor, source.id, { version: patch.version, startDate: patch.start_date, endDate: patch.end_date }, at)
        return Response.json({ data: result })
      }
      const sendDate = () => withIdempotency(new Request(`https://ezacto.test/api/v1/allocations/${source.id}`, { method: 'PATCH', headers: { authorization: 'Bearer owned-planning', 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(dates) }), answer, {
        store: runtime.store, secret, now: () => clock,
        authorize: async () => (await runtime.rows<{ profile: string }>('SELECT profile FROM users WHERE id=2'))[0]?.profile === 'administrator' ? 'owned-current-admin' : Response.json({ error: { code: 'forbidden' } }, { status: 403 }),
      })
      const first = await sendDate(); expect(first.status).toBe(200); const response = await first.text()
      const audit = await runtime.rows("SELECT * FROM event_outbox WHERE aggregate_type='allocation' ORDER BY id")
      const retry = await sendDate(); expect(retry.status).toBe(200); expect(retry.headers.get('idempotent-replayed')).toBe('true'); expect(await retry.text()).toBe(response)
      expect(writes).toBe(1); expect(await runtime.rows("SELECT * FROM event_outbox WHERE aggregate_type='allocation' ORDER BY id")).toEqual(audit)
      expect(await runtime.planning.get(actor, source.id)).toMatchObject({ startDate: dates.start_date, endDate: dates.end_date, version: 1, plannedSecondsPerWeek: 4442 })
      await runtime.run("UPDATE users SET profile='member' WHERE id=2")
      expect((await sendDate()).status).toBe(403); expect(writes).toBe(1)
      await expect(runtime.planning.update(actor, source.id, { version: 1, startDate: '2026-10-13' }, at)).rejects.toThrow()
      expect(await fingerprint()).toBe(before)
      expect(await runtime.rows("SELECT * FROM event_outbox WHERE aggregate_type='allocation' ORDER BY id")).toEqual(audit)
    })

    it('[api] a response lost after the commit is replayed byte for byte, and nothing runs again', async () => {
      const first = await snapshot(await send(`${name}-lost`, `${name} lost`, route()))
      expect(first).toMatchObject({ status: 201, lifetime: '86400' })

      const retry = await send(`${name}-lost`, `${name} lost`, route())
      expect(retry.headers.get('idempotent-replayed')).toBe('true')
      expect(await snapshot(retry)).toEqual(first)
      expect(calls).toBe(1)
      expect(await notesCalled(`${name} lost`)).toBe(1)
    })

    it('[security] binds replays to a durable authorization revision, including revoke-and-restore', async () => {
      await runtime.rows(`INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
        VALUES (11, 'Scope', 'Owner', 'administrator', '[]', ?, ?) RETURNING id`, startedAt.toISOString(), startedAt.toISOString())
      await runtime.rows(`INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
        VALUES (10, 'Scope', 'Member', 'member', '[]', ?, ?) RETURNING id`, startedAt.toISOString(), startedAt.toISOString())
      const authorize = () => runtime.store.authorizationRevision()
      const sendScoped = () => send(`${name}-durable-scope`, `${name} durable scope`, route(), {}, { authorize })
      const initialRevision = await authorize()
      expect((await sendScoped()).status).toBe(201)
      await runtime.rows("UPDATE users SET first_name = 'Renamed' WHERE id = 10 RETURNING id")
      await runtime.insert(`${name} ordinary unrelated write`)
      expect(await authorize()).toBe(initialRevision)
      expect((await sendScoped()).headers.get('idempotent-replayed')).toBe('true')
      await runtime.rows("UPDATE users SET profile = 'project_manager' WHERE id = 10 RETURNING id")
      expect(await authorize()).not.toBe(initialRevision)
      expect((await sendScoped()).status).toBe(409)
      await runtime.rows("UPDATE users SET profile = 'member' WHERE id = 10 RETURNING id")
      expect(await authorize()).not.toBe(initialRevision)
      expect((await sendScoped()).status).toBe(409)
      expect(await notesCalled(`${name} durable scope`)).toBe(1)
    })

    it('[security] a changed authorization scope cannot disclose an earlier response', async () => {
      let scope = 'administrator'
      const authorize = async () => scope
      const sendScoped = () => send(`${name}-scope`, `${name} scope`, route(), {}, { authorize })
      expect((await sendScoped()).status).toBe(201)
      scope = 'member'
      const replay = await sendScoped()
      expect(replay.status).toBe(409)
      expect(replay.headers.get('idempotent-replayed')).toBeNull()
      expect(calls).toBe(1)
      expect(await notesCalled(`${name} scope`)).toBe(1)
    })

    it('[security] an unauthorizable surface keeps its claim but never caches credential responses', async () => {
      const authorize = async () => null
      const sendPrivate = () => send(`${name}-private`, `${name} private`, route(), {}, { authorize })
      expect((await sendPrivate()).status).toBe(201)
      const replay = await sendPrivate()
      expect(replay.status).toBe(409)
      expect(replay.headers.getSetCookie()).toEqual([])
      expect(calls).toBe(1)
      expect(await notesCalled(`${name} private`)).toBe(1)
    })

    it('[security] rechecks authorization after waiting for the first attempt', async () => {
      const written = gate()
      const held = gate()
      let permitted = true
      const authorize = async () => permitted ? 'allowed' : new Response(null, { status: 401 })
      const first = send(`${name}-expire`, `${name} expire`, route({ afterWrite: async () => {
        written.open()
        await held.opened
      } }), {}, { authorize })
      await written.opened
      const checked = gate()
      const retry = send(`${name}-expire`, `${name} expire`, route(), {}, {
        authorize: async () => {
          const result = await authorize()
          checked.open()
          return result
        },
      })
      await checked.opened
      permitted = false
      held.open()
      expect((await first).status).toBe(201)
      const refused = await retry
      expect(refused.status).toBe(401)
      expect(refused.headers.get('idempotent-replayed')).toBeNull()
      expect(calls).toBe(1)
      expect(await notesCalled(`${name} expire`)).toBe(1)
    })

    it('[api] a retry while the first attempt still runs is told to come back, then gets the replay', async () => {
      const held = gate()
      const reached = gate()
      // Wait for the first attempt to have written and be holding its claim, not
      // for a guessed 50 ms: on a loaded runner the store can be slower than that
      // and the second request would then claim first.
      const first = send(
        `${name}-slow`,
        `${name} slow`,
        route({
          afterWrite: () => {
            reached.open()
            return held.opened
          },
        }),
      )
      await reached.opened
      const meanwhile = await send(`${name}-slow`, `${name} slow`, route())
      expect(meanwhile.status).toBe(503)
      expect(meanwhile.headers.get('retry-after')).toBe('1')
      expect(meanwhile.headers.get(IDEMPOTENCY_KEY_LIFETIME_HEADER)).toBe('86400')
      expect(await meanwhile.json()).toMatchObject({ error: { code: 'idempotent_request_in_progress' } })

      held.open()
      const fresh = await snapshot(await first)
      const later = await send(`${name}-slow`, `${name} slow`, route())
      expect(later.headers.get('idempotent-replayed')).toBe('true')
      expect(await snapshot(later)).toEqual(fresh)
      expect(calls).toBe(1)
      expect(await notesCalled(`${name} slow`)).toBe(1)
    })

    it('[api] a duplicate that arrives while the first attempt runs is handed its answer when it lands', async () => {
      const held = gate()
      const reached = gate()
      const first = send(
        `${name}-handed`,
        `${name} handed`,
        route({
          afterWrite: () => {
            reached.open()
            return held.opened
          },
        }),
      )
      await reached.opened
      const duplicate = send(`${name}-handed`, `${name} handed`, route(), {}, { waitForClaimMs: 5_000 })
      await new Promise((resolve) => setTimeout(resolve, 100))
      held.open()
      const [fresh, handed] = await Promise.all([first, duplicate])
      expect(handed.headers.get('idempotent-replayed')).toBe('true')
      expect(await snapshot(handed)).toEqual(await snapshot(fresh))
      expect(calls).toBe(1)
      expect(await notesCalled(`${name} handed`)).toBe(1)
    })

    it('[security] two attempts past the lookup at once: one write lands, the other is held off', async () => {
      const bothRead = gate()
      let waiting = 0
      const beforeWrite = async () => {
        waiting += 1
        if (waiting === 2) bothRead.open()
        await bothRead.opened
      }
      const answers = await Promise.all([
        send(`${name}-race`, `${name} race`, route({ beforeWrite })),
        send(`${name}-race`, `${name} race`, route({ beforeWrite })),
      ])
      expect(calls).toBe(2)
      expect(await notesCalled(`${name} race`)).toBe(1)
      const statuses = answers.map((answer) => answer.status).sort()
      // The loser is told to come back, or -- had the winner finished first --
      // handed the winner's answer.
      expect([
        [201, 503],
        [201, 201],
      ]).toContainEqual(statuses)
      const retry = await send(`${name}-race`, `${name} race`, route())
      expect(retry.status).toBe(201)
      expect(retry.headers.get('idempotent-replayed')).toBe('true')
      expect(await notesCalled(`${name} race`)).toBe(1)
    })

    it('[api] an attempt that stopped between its write and its record is reported done, never run again', async () => {
      await expect(send(`${name}-crash`, `${name} crash`, route({ crash: true }))).rejects.toThrow(
        /went away/,
      )
      clock = new Date(startedAt.getTime() + 1_000)
      const soon = await send(`${name}-crash`, `${name} crash`, route())
      expect(soon.status).toBe(503)
      expect(await soon.json()).toMatchObject({ error: { code: 'idempotent_request_in_progress' } })

      clock = new Date(startedAt.getTime() + 61_000)
      const later = await send(`${name}-crash`, `${name} crash`, route())
      expect(later.status).toBe(409)
      expect(await later.json()).toMatchObject({ error: { code: 'idempotent_result_unavailable' } })
      expect(calls).toBe(1)
      expect(await notesCalled(`${name} crash`)).toBe(1)
    })

    it('[api] a server error after the write lands is never replayed: the retry hears the work was done', async () => {
      const failed = await send(
        `${name}-500`,
        `${name} 500`,
        route({ answer: () => Response.json({ error: { code: 'internal' } }, { status: 500 }) }),
      )
      expect(failed.status).toBe(500)
      const retry = await send(`${name}-500`, `${name} 500`, route())
      expect(retry.status).toBe(409)
      expect(await retry.json()).toMatchObject({ error: { code: 'idempotent_result_unavailable' } })
      expect(calls).toBe(1)
      expect(await notesCalled(`${name} 500`)).toBe(1)
    })

    it('[api] a refusal that changed nothing is not kept: its retry runs, under its own credentials', async () => {
      const refusal = route({
        write: false,
        answer: () =>
          Response.json(
            { error: { code: 'scope_forbidden', fields: [] } },
            { status: 403 },
          ),
      })
      expect((await send(`${name}-403`, `${name} 403`, refusal)).status).toBe(403)
      // Signed in again, with a token that may write: the same key now lands.
      const retry = await send(`${name}-403`, `${name} 403`, route(), {
        credentials: { authorization: 'Bearer ezat_signed_in_again' },
      })
      expect(retry.status).toBe(201)
      expect(retry.headers.get('idempotent-replayed')).toBeNull()
      expect(calls).toBe(2)
      expect(await notesCalled(`${name} 403`)).toBe(1)
    })

    it('[api] a server error that wrote nothing is not kept: the retry runs', async () => {
      const busy = route({
        write: false,
        answer: () => Response.json({ error: { code: 'service_unavailable' } }, { status: 503 }),
      })
      expect((await send(`${name}-busy`, `${name} busy`, busy)).status).toBe(503)
      const retry = await send(`${name}-busy`, `${name} busy`, route())
      expect(retry.status).toBe(201)
      expect(retry.headers.get('idempotent-replayed')).toBeNull()
      expect(calls).toBe(2)
      expect(await notesCalled(`${name} busy`)).toBe(1)
    })

    it('[security] refuses the key on any other request: body, path, method or content type', async () => {
      expect((await send(`${name}-bound`, `${name} bound`, route())).status).toBe(201)
      const refusals = await Promise.all([
        send(`${name}-bound`, `${name} other body`, route()),
        send(`${name}-bound`, `${name} bound`, route(), { path: '/api/v1/expenses' }),
        send(`${name}-bound`, `${name} bound`, route(), { method: 'PUT' }),
        send(`${name}-bound`, `${name} bound`, route(), { contentType: 'text/plain' }),
      ])
      for (const refusal of refusals) {
        expect(refusal.status).toBe(422)
        expect(await refusal.json()).toMatchObject({
          error: {
            code: 'idempotency_key_reused',
            fields: [{ field: 'Idempotency-Key', code: 'reused' }],
          },
        })
      }
      expect(calls).toBe(1)
      expect(await notesCalled(`${name} other body`)).toBe(0)
    })

    it('[security] hands a stored answer only to the credentials that first carried it', async () => {
      const session = { cookie: 'theme=dark; __Host-ezacto_session=first-session' }
      const first = await snapshot(
        await send(`${name}-holder`, `${name} holder`, route(), { credentials: session }),
      )
      // Unrelated cookies may change; the credential is what counts.
      const same = await send(`${name}-holder`, `${name} holder`, route(), {
        credentials: { cookie: '__Host-ezacto_session=first-session; theme=light' },
      })
      expect(same.headers.get('idempotent-replayed')).toBe('true')
      expect(await snapshot(same)).toEqual(first)

      const others: Record<string, string>[] = [
        {},
        { authorization: 'Bearer ezat_someone_else' },
        { cookie: '__Host-ezacto_session=signed-in-again' },
        { cookie: '__Host-ezacto_session=first-session', 'cf-access-jwt-assertion': 'another.identity.jwt' },
      ]
      for (const credentials of others) {
        const other = await send(`${name}-holder`, `${name} holder`, route(), { credentials })
        expect(other.status).toBe(409)
        expect(other.headers.get('idempotent-replayed')).toBeNull()
        const text = await other.text()
        expect(text).toContain('idempotent_result_unavailable')
        expect(text).not.toContain(`${name} holder`)
        expect(other.headers.get('set-cookie')).toBeNull()
      }
      expect(calls).toBe(1)
      expect(await notesCalled(`${name} holder`)).toBe(1)
    })

    it('[security] refuses an invalid key before anything runs', async () => {
      for (const key of ['', 'has space', 'x'.repeat(256), 'ünicode']) {
        const refused = await send(key, `${name} invalid`, route())
        expect(refused.status).toBe(400)
        expect(await refused.json()).toMatchObject({ error: { code: 'invalid_idempotency_key' } })
      }
      expect(calls).toBe(0)
    })

    it('[security] bounds streamed request bodies before fingerprinting, even with a false length', async () => {
      let pulled = 0
      let canceled = false
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1
          controller.enqueue(new Uint8Array(1024 * 1024))
          if (pulled === 40) controller.close()
        },
        cancel() { canceled = true },
      })
      const request = new Request('https://ezacto.test/api/v1/upload', {
        method: 'POST', headers: { 'idempotency-key': `${name}-oversize`, 'content-length': '1' },
        body, duplex: 'half',
      } as RequestInit)
      const response = await withIdempotency(request, async () => {
        calls += 1
        return new Response(null, { status: 204 })
      }, { store: runtime.store, secret, authorize: async () => 'fixture-authorized' })
      expect(response.status).toBe(413)
      expect(await response.json()).toMatchObject({ error: { code: 'payload_too_large' } })
      expect(pulled).toBeLessThan(40)
      expect(canceled).toBe(true)
      expect(calls).toBe(0)
    })

    it('[api] streams a large response without buffering it all or replaying the write', async () => {
      let pulled = 0
      const answer = () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1
          controller.enqueue(new Uint8Array(64 * 1024).fill(42))
          if (pulled === 40) controller.close()
        },
      }), { status: 201 })
      const first = await send(`${name}-large-stream`, `${name} large stream`, route({ answer }))
      expect(first.status).toBe(201)
      expect(pulled).toBeLessThan(40)
      const bytes = new Uint8Array(await first.arrayBuffer())
      expect(bytes.byteLength).toBe(40 * 64 * 1024)
      expect(bytes.every((byte) => byte === 42)).toBe(true)
      const retry = await send(`${name}-large-stream`, `${name} large stream`, route({ answer }))
      expect(retry.status).toBe(409)
      expect(await notesCalled(`${name} large stream`)).toBe(1)
    })

    it('[unit] runs reads and unkeyed writes every time, and advertises the lifetime on all of them', async () => {
      const unkeyed = [
        await send(null, `${name} unkeyed`, route()),
        await send(null, `${name} unkeyed`, route()),
      ]
      for (const answer of unkeyed) {
        expect(answer.status).toBe(201)
        expect(answer.headers.get(IDEMPOTENCY_KEY_LIFETIME_HEADER)).toBe('86400')
      }
      expect(await notesCalled(`${name} unkeyed`)).toBe(2)

      let reads = 0
      const read = async (): Promise<Response> => {
        reads += 1
        return new Response(null, { status: 204 })
      }
      for (let index = 0; index < 2; index += 1) {
        const answer = await withIdempotency(
          new Request('https://ezacto.test/api/v1/whoami', { headers: { 'idempotency-key': `${name}-read` } }),
          read,
          { store: runtime.store, authorize: async () => 'fixture-authorized', secret },
        )
        expect(answer.status).toBe(204)
        expect(answer.headers.get(IDEMPOTENCY_KEY_LIFETIME_HEADER)).toBe('86400')
      }
      expect(reads).toBe(2)
    })

    it('[security] preserves boundary-like bytes inside uploaded filenames', async () => {
      const upload = (boundary: string) => withIdempotency(new Request('https://ezacto.test/api/v1/upload', {
        method: 'POST',
        headers: { 'idempotency-key': `${name}-boundary-content`, 'content-type': `multipart/form-data; boundary=${boundary}` },
        body: `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="receipt--${boundary}.txt"\r\nContent-Type: text/plain\r\n\r\ncontents\r\n--${boundary}--\r\n`,
      }), async (request) => {
        calls += 1
        const file = (await request.formData()).get('file') as File
        const contents = `${file.name}: ${await file.text()}`
        const id = await runtime.insert(`${name} ${contents}`)
        return Response.json({ id, contents }, { status: 201 })
      }, { store: runtime.store, secret, authorize: async () => 'fixture-authorized', now: () => clock })
      expect((await upload('boundary-one')).status).toBe(201)
      expect((await upload('boundary-one')).headers.get('idempotent-replayed')).toBe('true')
      const changedFile = await upload('boundary-two')
      expect(changedFile.status).toBe(422)
      expect(calls).toBe(1)
    })

    it('[api] knows an upload sent again under a new multipart boundary, and one with another file', async () => {
      const upload = async (contents: string): Promise<Response> => {
        const form = new FormData()
        form.set('file', new File([contents], 'receipt.txt', { type: 'text/plain' }))
        // Serialized here, so each send gets a boundary of its own -- the way a
        // browser or the generated client sends the same FormData twice.
        const request = new Request('https://ezacto.test/api/v1/expenses/1/attachments', {
          method: 'POST',
          headers: { 'idempotency-key': `${name}-upload` },
          body: form,
        })
        return withIdempotency(
          request,
          async (incoming) => {
            calls += 1
            const file = (await incoming.formData()).get('file') as File
            const id = await runtime.insert(`${name} upload ${await file.text()}`)
            return Response.json({ data: { id, name: file.name } }, { status: 201 })
          },
          { store: runtime.store, authorize: async () => 'fixture-authorized', secret, now: () => clock },
        )
      }
      const first = await upload('the same receipt')
      expect(first.status).toBe(201)
      const again = await upload('the same receipt')
      expect(again.headers.get('idempotent-replayed')).toBe('true')
      expect(await again.text()).toBe(await first.text())
      const other = await upload('a different receipt')
      expect(other.status).toBe(422)
      expect(calls).toBe(1)
      expect(await notesCalled(`${name} upload the same receipt`)).toBe(1)
    })

    it('[api] a response too large to keep is recorded as done, not replayed', async () => {
      const large = route({
        answer: (id) => new Response('x'.repeat(1024 * 1024 + 1), { status: 200, headers: { 'x-id': String(id) } }),
      })
      expect((await send(`${name}-large`, `${name} large`, large)).status).toBe(200)
      const retry = await send(`${name}-large`, `${name} large`, route())
      expect(retry.status).toBe(409)
      expect(await retry.json()).toMatchObject({ error: { code: 'idempotent_result_unavailable' } })
      expect(await notesCalled(`${name} large`)).toBe(1)
    })

    it('[api] forgets a key after its lifetime, so the same key runs afresh', async () => {
      expect((await send(`${name}-expiry`, `${name} expiry`, route())).status).toBe(201)
      clock = new Date(startedAt.getTime() + 24 * 60 * 60 * 1000)
      const later = await send(`${name}-expiry`, `${name} expiry`, route())
      expect(later.status).toBe(201)
      expect(later.headers.get('idempotent-replayed')).toBeNull()
      expect(await notesCalled(`${name} expiry`)).toBe(2)
    })

    it('[security] keeps nothing a reader of the database could use without the key', async () => {
      const answer = await send(`${name}-sealed`, `${name} sealed`, route())
      const cookie = answer.headers.getSetCookie()[0]!
      const [row] = await runtime.rows<{ id: string; sealed: string; nonce: string }>(
        `SELECT id, sealed, nonce FROM idempotency_keys WHERE state = 'done' ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      expect(row!.id).toMatch(/^[0-9a-f]{64}$/u)
      expect(row!.id).not.toContain(`${name}-sealed`)
      const stored = atob(row!.sealed)
      expect(stored).not.toContain(cookie.split(';')[0]!)
      expect(stored).not.toContain(`${name} sealed`)

      // Rotating the deployment secret must not make the committed claim disappear.
      const elsewhere = await deriveIdempotencySecret(new Uint8Array(32).fill(0x42))
      const foreign = await send(`${name}-sealed`, `${name} sealed`, route(), {}, { secret: elsewhere })
      expect(foreign.status).toBe(409)
      expect(foreign.headers.get('idempotent-replayed')).toBeNull()
      expect(await notesCalled(`${name} sealed`)).toBe(1)
      expect(reported).toEqual([])
    })

    it('[api] hands the Worker its work to hold open until the response is recorded', async () => {
      const held: Promise<unknown>[] = []
      const answer = await send(`${name}-wait`, `${name} wait`, route(), {}, { waitUntil: (promise) => held.push(promise) })
      expect(answer.status).toBe(201)
      expect(held).toHaveLength(1)
      await held[0]
      const [row] = await runtime.rows<{ state: string }>(
        `SELECT state FROM idempotency_keys ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      expect(row).toEqual({ state: 'done' })
    })
  })
}
