// AC #4 (pagination follows the links object) and the second half of AC #2
// (429 honors Retry-After), both asserted against a real server so the claims are
// about what was actually requested.

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { paginate, type Page, type PaginateDeps } from '../src/paginator.js'
import { createRateLimiter } from '../src/rate-limiter.js'
import {
  envelope,
  startFakeHarvest,
  type FakeHarvest,
  type RouteHandler,
} from './harvest-server.js'

let server: FakeHarvest | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
})

/** Usable inside a route handler: by then the server is listening. */
const base = (): string => server?.baseUrl ?? ''

const config = (baseUrl: string) => ({
  pat: 'p',
  userAgentEmail: 'e@x.com',
  accountId: '1',
  baseUrl,
  timeoutMs: 5_000,
})

interface Harness {
  deps: PaginateDeps
  sleeps: number[]
  logs: string[]
}

const harness = (): Harness => {
  const sleeps: number[] = []
  const logs: string[] = []
  return {
    sleeps,
    logs,
    deps: {
      limiter: createRateLimiter({ sleep: () => Promise.resolve() }),
      sleep: (ms) => {
        sleeps.push(ms)
        return Promise.resolve()
      },
      log: (line) => logs.push(line),
    },
  }
}

const collect = async (
  routes: Record<string, RouteHandler>,
  start: { resource: string; path: string; collection: string; params?: Record<string, string> },
  h: Harness,
): Promise<Page[]> => {
  server = await startFakeHarvest(routes)
  const pages: Page[] = []
  for await (const page of paginate(start, config(server.baseUrl), h.deps)) pages.push(page)
  return pages
}

describe('paginate follows the links object', () => {
  it('[unit] uses links.next verbatim, never a URL it constructed', async () => {
    const h = harness()
    // A next URL no construction scheme could produce: a different path *and* an
    // opaque token. If the client rebuilt the URL from a cursor it would ask for
    // /v2/clients again and loop, or 404 — either way the recorded path would differ.
    const pages = await collect(
      {
        '/v2/clients': (url) => {
          expect(url.searchParams.get('per_page')).toBe('2000')
          return {
            body: envelope(
              'clients',
              [{ id: 1 }],
              `${base()}/v2/relocated-page-2?cursor=OPAQUE_ZZZ&per_page=2000`,
            ),
          }
        },
        '/v2/relocated-page-2': () => ({ body: envelope('clients', [{ id: 2 }], null) }),
      },
      { resource: 'clients', path: '/v2/clients', collection: 'clients' },
      h,
    )

    expect(server?.requests[1]).toBe('/v2/relocated-page-2?cursor=OPAQUE_ZZZ&per_page=2000')
    expect(pages.map((p) => p.objects)).toEqual([[{ id: 1 }], [{ id: 2 }]])
    expect(pages[1].nextUrl).toBeNull()
  })

  it('[unit] builds a query on the first request only, carrying per_page and declared params', async () => {
    const h = harness()
    // Harvest's own next link carries neither per_page nor is_active — it encodes
    // both in the cursor. The client must not helpfully add them back.
    await collect(
      {
        '/v2/user_assignments': (_url, hit) =>
          hit === 1
            ? {
                body: envelope(
                  'user_assignments',
                  [{ id: 1 }],
                  `${base()}/v2/user_assignments?cursor=CURSOR_A`,
                ),
              }
            : { body: envelope('user_assignments', [{ id: 2 }], null) },
      },
      {
        resource: 'user_assignments',
        path: '/v2/user_assignments',
        collection: 'user_assignments',
        params: { is_active: 'false' },
      },
      h,
    )

    expect(server?.requests).toEqual([
      '/v2/user_assignments?per_page=2000&is_active=false',
      '/v2/user_assignments?cursor=CURSOR_A',
    ])
  })

  it('[unit] a body with no links object fails loudly instead of ending after one page', async () => {
    const h = harness()
    const err = await collect(
      { '/v2/clients': () => ({ body: { clients: [{ id: 1 }], total_entries: 4000 } }) },
      { resource: 'clients', path: '/v2/clients', collection: 'clients' },
      h,
    ).catch((e: unknown) => e as Error)

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('"links" is missing')
    expect((err as Error).message).toContain('/v2/clients')
    expect((err as Error).message).toContain('missing most of the account')
  })

  it('[unit] a missing collection key fails loudly rather than writing an empty file', async () => {
    // The guess-guard for the nested endpoints, whose envelope keys are not
    // documented anywhere: a wrong guess must surface on the first live run.
    const h = harness()
    const err = await collect(
      { '/v2/invoices/1/messages': () => ({ body: envelope('messages', [{ id: 9 }]) }) },
      {
        resource: 'invoice_messages',
        path: '/v2/invoices/1/messages',
        collection: 'invoice_messages',
      },
      h,
    ).catch((e: unknown) => e as Error)

    expect((err as Error).message).toContain('"invoice_messages" is missing')
  })
})

// `links.next` is a request target named by the response body, and harvest-client
// attaches the account's PAT to every request it makes. Following links verbatim is
// about not *rebuilding* the URL; it was never a licence to follow one off the API
// origin, where the token would land in someone else's log — in cleartext, if the
// link says http://.
describe('paginate refuses a next link off the API origin [unit]', () => {
  let elsewhere: Server | undefined
  afterEach(async () => {
    const closing = elsewhere
    elsewhere = undefined
    if (closing) {
      closing.closeAllConnections()
      await new Promise<void>((resolve) => closing.close(() => resolve()))
    }
  })

  it('[unit] does not send the PAT to a host named by links.next', async () => {
    const received: (string | undefined)[] = []
    const started = createServer((req, res) => {
      received.push(req.headers.authorization)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(envelope('users', [])))
    })
    elsewhere = started
    await new Promise<void>((resolve) => started.listen(0, '127.0.0.1', resolve))
    const collector = `http://127.0.0.1:${(started.address() as AddressInfo).port}/collect`

    const h = harness()
    const err = await collect(
      { '/v2/users': () => ({ body: envelope('users', [{ id: 1 }], collector) }) },
      { resource: 'users', path: '/v2/users', collection: 'users' },
      h,
    ).catch((e: unknown) => e as Error)

    expect(received).toEqual([])
    expect((err as Error).message).toContain('refusing to follow users pagination')
    expect((err as Error).message).toContain(collector)
    expect((err as Error).message).toContain("carries the account's Harvest PAT")
  })
})

describe('paginate throttle and backoff policy [unit]', () => {
  it('[unit] a 429 waits exactly the Retry-After it was given, then re-requests the same URL', async () => {
    const h = harness()
    const pages = await collect(
      {
        '/v2/time_entries': (_url, hit) =>
          hit === 1
            ? { status: 429, headers: { 'retry-after': '3' }, body: { message: 'throttled' } }
            : { body: envelope('time_entries', [{ id: 7 }]) },
      },
      { resource: 'time_entries', path: '/v2/time_entries', collection: 'time_entries' },
      h,
    )

    expect(h.sleeps).toEqual([3_000])
    expect(server?.requests[0]).toBe(server?.requests[1])
    expect(pages[0].objects).toEqual([{ id: 7 }])
    expect(h.logs.join('\n')).toContain('waiting 3s')
  })

  it('[unit] a 429 with an unreadable Retry-After falls back to one full window', async () => {
    const h = harness()
    await collect(
      {
        '/v2/tasks': (_url, hit) =>
          hit === 1
            ? { status: 429, headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }, body: {} }
            : { body: envelope('tasks', []) },
      },
      { resource: 'tasks', path: '/v2/tasks', collection: 'tasks' },
      h,
    )
    expect(h.sleeps).toEqual([15_000])

    const h2 = harness()
    await server?.close()
    await collect(
      {
        '/v2/tasks': (_url, hit) =>
          hit === 1 ? { status: 429, body: {} } : { body: envelope('tasks', []) },
      },
      { resource: 'tasks', path: '/v2/tasks', collection: 'tasks' },
      h2,
    )
    expect(h2.sleeps).toEqual([15_000])
  })

  it('[unit] a 5xx backs off exponentially, then succeeds', async () => {
    const h = harness()
    const pages = await collect(
      {
        '/v2/projects': (_url, hit) =>
          hit <= 2
            ? { status: 500, body: { message: 'boom' } }
            : { body: envelope('projects', [{ id: 3 }]) },
      },
      { resource: 'projects', path: '/v2/projects', collection: 'projects' },
      h,
    )

    expect(h.sleeps).toEqual([1_000, 2_000])
    expect(pages[0].objects).toEqual([{ id: 3 }])
  })

  // A 429 that is honored with a zero wait *and* a forgotten window is not
  // backoff — it is a tight loop against a server that has already said stop, at
  // whatever rate the network allows. `Retry-After: 0` is legal and a blank header
  // is common, so both have to land on the floor rather than on 0.
  it('[unit] a 429 telling us to come back immediately still waits, and keeps the window', async () => {
    for (const header of ['', '0', '   ']) {
      const h = harness()
      const before = h.deps.limiter.granted
      await collect(
        {
          '/v2/clients': (_url, hit) =>
            hit === 1
              ? { status: 429, headers: { 'retry-after': header }, body: {} }
              : { body: envelope('clients', []) },
        },
        { resource: 'clients', path: '/v2/clients', collection: 'clients' },
        h,
      )

      // never zero, whatever the header said
      expect(h.sleeps.every((ms) => ms >= 1_000)).toBe(true)
      // and the window was not wiped: a one-second nap does not roll Harvest's
      // 15s window, so forgetting ours would hand back a budget nothing aged out
      // of — a 429 would *raise* our request rate instead of lowering it
      expect(h.deps.limiter.granted).toBe(before + 2)
      await server?.close()
      server = undefined
    }
  })

  // A connection that drops or a body that stalls carries no `status`, so it fell
  // past the 429 and 5xx branches to the rethrow: no backoff, no retry, and a
  // message naming no resource. One blip ended a multi-hour sweep that cannot
  // resume mid-resource.
  it('[unit] a dropped connection is retried with backoff, not rethrown on the first failure', async () => {
    const h = harness()
    const pages = await collect(
      {
        '/v2/projects': (_url, hit) =>
          hit <= 2 ? { destroy: true } : { body: envelope('projects', [{ id: 3 }]) },
      },
      { resource: 'projects', path: '/v2/projects', collection: 'projects' },
      h,
    )

    expect(pages[0].objects).toEqual([{ id: 3 }])
    expect(h.sleeps).toEqual([1_000, 2_000])
    expect(h.logs.join('\n')).toContain('projects: could not reach Harvest')
  })

  it('[unit] a connection that never recovers gives up naming the resource and the resume path', async () => {
    const h = harness()
    const err = (await collect(
      { '/v2/expenses': () => ({ destroy: true }) },
      { resource: 'expenses', path: '/v2/expenses', collection: 'expenses' },
      h,
    ).catch((e: unknown) => e)) as Error

    expect(err.message).toContain('expenses: gave up on')
    expect(err.message).toContain('could not reach Harvest')
    expect(err.message).toContain('resumes this resource from its last checkpoint')
  })

  it('[unit] five consecutive 429s give up with a message naming the resource and the resume path', async () => {
    const h = harness()
    const err = await collect(
      { '/v2/expenses': () => ({ status: 429, headers: { 'retry-after': '1' }, body: {} }) },
      { resource: 'expenses', path: '/v2/expenses', collection: 'expenses' },
      h,
    ).catch((e: unknown) => e as Error)

    expect(server?.requests).toHaveLength(5)
    const message = (err as Error).message
    expect(message).toContain('expenses')
    expect(message).toContain('/v2/expenses?per_page=2000')
    expect(message).toContain('after 5 attempts')
    expect(message).toContain('--snapshot-dir')
  })

  it('[unit] a 403 is an answer, not weather — rethrown immediately with no sleep', async () => {
    const h = harness()
    const err = await collect(
      { '/v2/users/1/teammates': () => ({ status: 403, body: { message: 'nope' } }) },
      { resource: 'teammates', path: '/v2/users/1/teammates', collection: 'teammates' },
      h,
    ).catch((e: unknown) => e as Error)

    expect((err as Error & { status: number }).status).toBe(403)
    expect(h.sleeps).toEqual([])
    expect(server?.requests).toHaveLength(1)
  })
})
