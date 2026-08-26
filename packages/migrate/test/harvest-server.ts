// A real HTTP server standing in for Harvest, not a mocked `fetch`.
//
// The assertions these tests exist to make are about what went over the wire —
// that page 2 was requested at the URL Harvest handed back, byte for byte, and
// that a retry re-requested the same one. A mocked fetch can only tell you what
// the client *intended*; a server tells you what it received.

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface Reply {
  status?: number
  headers?: Record<string, string>
  /** Serialized as JSON unless it is already a string. */
  body?: unknown
}

/** `hit` is 1 for the first request to this route, 2 for the second, and so on. */
export type RouteHandler = (url: URL, hit: number) => Reply

export interface FakeHarvest {
  baseUrl: string
  /** Every request path+query received, in order. */
  requests: string[]
  close: () => Promise<void>
}

/** Route keys may contain `{id}`, which matches one or more digits. */
const toPattern = (route: string): RegExp =>
  new RegExp(`^${route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{id\\\}/g, '(\\d+)')}$`)

export const startFakeHarvest = async (
  routes: Record<string, RouteHandler>,
): Promise<FakeHarvest> => {
  const patterns = Object.entries(routes).map(([route, handler]) => ({
    pattern: toPattern(route),
    handler,
  }))
  const requests: string[] = []
  const hits = new Map<string, number>()

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    requests.push(req.url ?? '')
    const match = patterns.find((p) => p.pattern.test(url.pathname))
    if (!match) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ message: `no route for ${url.pathname}` }))
      return
    }
    const hit = (hits.get(url.pathname) ?? 0) + 1
    hits.set(url.pathname, hit)
    const reply = match.handler(url, hit)
    res.writeHead(reply.status ?? 200, {
      'content-type': 'application/json',
      ...reply.headers,
    })
    res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {}))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** A Harvest list envelope (research §0.4). */
export const envelope = (
  collection: string,
  objects: unknown[],
  nextUrl: string | null = null,
): Record<string, unknown> => ({
  [collection]: objects,
  page: 1,
  total_pages: 1,
  total_entries: objects.length,
  next_page: null,
  previous_page: null,
  links: { first: null, next: nextUrl, previous: null, last: null },
})
