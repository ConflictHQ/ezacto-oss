import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createManagedDeelSyncRuntime,
  type DeelSyncSource,
  type DeelSyncSummary,
  type DeelTransferIntents,
  type ManagedDeelCredentialSource,
  type TransferLogRecord,
  type TransferTimeEntry,
} from '../src/index.js'
import { peoplePageOne } from './fixtures/deel-api.js'

/**
 * Issue 1238. The provider is an owned local HTTP server, so the real client and
 * a real fetch run end to end and a dropped connection is a dropped connection.
 * Nothing leaves the machine and no money moves.
 */

const ana = 7
const now = () => new Date('2026-10-19T03:00:00.000Z')
const manualSettings = {
  get: async () => ({ mode: 'manual' as const, runTime: '03:00' }),
  claimAutomaticDay: async () => true,
  organizationTimezone: async () => 'UTC',
}

type PostMode = 'accept' | 'drop' | 'reject'
interface Provider {
  url: string
  posts: { authorization: string | undefined; body: unknown }[]
  gets: number
  mode: PostMode
  onPost?: () => void
}

let server: Server | undefined
afterEach(async () => {
  server?.closeAllConnections()
  await new Promise((resolve) => server?.close(resolve))
  server = undefined
})

const read = async (request: IncomingMessage): Promise<string> => {
  let text = ''
  for await (const chunk of request) text += String(chunk)
  return text
}

const provider = async (): Promise<Provider> => {
  const state: Provider = { url: '', posts: [], gets: 0, mode: 'accept' }
  let created = 0
  server = createServer((request, response) => {
    void (async () => {
      if (request.method === 'GET') {
        state.gets += 1
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(peoplePageOne))
        return
      }
      state.posts.push({
        authorization: request.headers.authorization,
        body: JSON.parse(await read(request)),
      })
      state.onPost?.()
      if (state.mode === 'drop') {
        request.socket.destroy()
        return
      }
      if (state.mode === 'reject') {
        response.statusCode = 422
        response.end('{}')
        return
      }
      created += 1
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ data: { id: `tms_${created}` } }))
    })()
  })
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/rest`
  return state
}

/** The database's contract, in memory: a log that refuses duplicates and durable intents. */
const storage = () => {
  const log = new Map<number, TransferLogRecord>()
  const open = new Map<number, string>()
  const runs: { outcome: string; summary: DeelSyncSummary | null }[] = []
  const entries: TransferTimeEntry[] = []
  const intents: DeelTransferIntents = {
    open: async () => [...open.keys()],
    begin: async (submission) => {
      for (const entry of submission.entries) {
        if (open.has(entry.entryId)) throw new Error('intent already open')
      }
      for (const entry of submission.entries) open.set(entry.entryId, entry.fingerprint)
    },
    release: async (ids) => {
      for (const id of ids) open.delete(id)
    },
  }
  const source: DeelSyncSource = {
    directory: async () => [
      { userId: ana, emails: [{ address: 'ana.personal@example.test', kind: 'payroll' }] },
    ],
    entries: async (window) =>
      entries.filter((entry) => entry.spentDate >= window.from && entry.spentDate <= window.to),
    log: async () => [...log.values()],
    logged: async () =>
      [...log.values()].map((row) => ({
        ...row,
        current: entries.find((entry) => entry.id === row.entryId) ?? null,
      })),
    record: async (record) => {
      if (log.has(record.entryId)) throw new Error('already logged')
      log.set(record.entryId, record)
      open.delete(record.entryId)
    },
    beginRun: async () => {
      if (runs.some((run) => run.outcome === 'running')) return null
      runs.push({ outcome: 'running', summary: null })
      return runs.length
    },
    finishRun: async (id, outcome, summary) => {
      runs[id - 1] = { outcome, summary }
    },
    intents,
  }
  return { source, log, open, runs, entries }
}

const credentialSource = (initial: { token: string; startDate: string } | null) => {
  const state = { current: initial, generation: 1 }
  const source: ManagedDeelCredentialSource = {
    current: async () =>
      state.current === null ? null : { ...state.current, generation: state.generation },
    generation: async () => state.generation,
  }
  return {
    source,
    state,
    /** Any lifecycle change advances the counter, as the database trigger does. */
    set: (next: { token: string; startDate: string } | null) => {
      state.current = next
      state.generation += 1
    },
  }
}

// Fails closed: a request that is not for the owned local server never leaves.
const ownedOnly = async (request: Request): Promise<Response> => {
  if (new URL(request.url).hostname !== '127.0.0.1') throw new Error('refused a non-local request')
  return fetch(request)
}

const TOKEN = 'OWNED_TOKEN_SENTINEL'
const connected = { token: TOKEN, startDate: '2026-09-01' }
const posts = (p: Provider) => p.posts.length
const hour = (id: number, spentDate = '2026-09-02'): TransferTimeEntry => ({
  id,
  userId: ana,
  spentDate,
  roundedSeconds: 3_600,
})

const build = async (initial: typeof connected | null = connected) => {
  const p = await provider()
  const s = storage()
  const creds = credentialSource(initial)
  const runtime = createManagedDeelSyncRuntime({
    credentials: creds.source,
    source: s.source,
    settings: manualSettings,
    fetch: ownedOnly,
    now,
    baseUrl: p.url,
  })
  return { p, s, creds, runtime }
}

describe('managed Deel runtime: nothing without a live connection', () => {
  it('reports unconfigured and makes no provider request when absent, disconnected or erased', async () => {
    const { p, s, creds, runtime } = await build(null)
    s.entries.push(hour(1))
    const window = { from: '2026-09-01', to: '2026-10-18' }
    const check = async () => {
      expect(await runtime.status()).toEqual({
        configured: false,
        reason: 'no Deel connection is configured',
      })
      expect(await runtime.preview(window)).toMatchObject({ status: 'unconfigured' })
      expect(await runtime.run({ window, expectedEntryIds: [1] })).toMatchObject({
        status: 'unconfigured',
      })
      expect(await runtime.runAutomaticIfDue()).toMatchObject({ status: 'unconfigured' })
      expect(await runtime.reconcile()).toMatchObject({ status: 'unconfigured' })
      expect(p.gets + posts(p)).toBe(0)
      expect(s.runs).toEqual([])
    }
    await check()
    creds.set(connected)
    expect((await runtime.status()).configured).toBe(true)
    creds.set(null)
    await check()
  })
})

describe('managed Deel runtime: preview sends nothing, a confirmed run sends once', () => {
  it('previews without a create, sends exactly the previewed entries, and never twice', async () => {
    const { p, s, runtime } = await build()
    s.entries.push(hour(1), hour(2), hour(3, '2026-09-03'))
    const window = { from: '2026-09-01', to: '2026-10-18' }

    const preview = await runtime.preview(window)
    expect(preview).toMatchObject({
      status: 'ready',
      entryIds: [1, 2, 3],
      timesheets: 2,
      unresolved: [],
    })
    expect(posts(p)).toBe(0)
    expect(p.posts).toEqual([])

    expect(await runtime.run({ window, expectedEntryIds: [1, 2] })).toMatchObject({
      status: 'stale',
    })
    expect(posts(p)).toBe(0)

    const sent = await runtime.run({ window, expectedEntryIds: [1, 2, 3] })
    expect(sent).toMatchObject({
      status: 'completed',
      timesheetsSubmitted: 2,
      entriesTransferred: 3,
    })
    expect(posts(p)).toBe(2)
    expect(p.posts.every((post) => post.authorization === `Bearer ${TOKEN}`)).toBe(true)

    expect(await runtime.run({ window, expectedEntryIds: [] })).toMatchObject({
      status: 'completed',
      timesheetsSubmitted: 0,
    })
    expect(posts(p)).toBe(2)
    expect(s.open.size).toBe(0)
    expect(JSON.stringify([sent, s.runs])).not.toContain(TOKEN)
  })

  it('uses the current token after a rotation and the new start date floor', async () => {
    const { p, s, creds, runtime } = await build()
    s.entries.push(hour(1, '2026-09-02'), hour(2, '2026-10-02'))
    creds.set({ token: 'ROTATED_TOKEN', startDate: '2026-10-01' })
    const window = { from: '2026-10-01', to: '2026-10-18' }
    expect(await runtime.run({ window, expectedEntryIds: [2] })).toMatchObject({
      status: 'completed',
      entriesTransferred: 1,
    })
    expect(p.posts.map((post) => post.authorization)).toEqual(['Bearer ROTATED_TOKEN'])
    expect(await runtime.run({ window: { from: '2026-09-01', to: '2026-10-18' } })).toMatchObject({
      status: 'invalid',
    })
  })
})

describe('managed Deel runtime: an unknown create result is never repeated', () => {
  it('holds the entries after a lost response, across a restart, until an operator says nothing was created', async () => {
    const { p, s, runtime } = await build()
    s.entries.push(hour(1))
    const window = { from: '2026-09-01', to: '2026-10-18' }
    p.mode = 'drop'

    const lost = await runtime.run({ window, expectedEntryIds: [1] })
    expect(lost).toMatchObject({ status: 'failed', entriesTransferred: 0 })
    expect(posts(p)).toBe(1)
    expect(s.log.size).toBe(0)
    expect([...s.open.keys()]).toEqual([1])

    // A restart builds a new runtime over the same storage; Deel is healthy again.
    p.mode = 'accept'
    const restarted = createManagedDeelSyncRuntime({
      credentials: credentialSource(connected).source,
      source: s.source,
      settings: manualSettings,
      fetch: ownedOnly,
      now,
      baseUrl: p.url,
    })
    expect(await restarted.preview(window)).toMatchObject({
      status: 'ready',
      entryIds: [],
      unresolved: [1],
    })
    expect(await restarted.run({ window })).toMatchObject({
      status: 'completed',
      timesheetsSubmitted: 0,
    })
    expect(posts(p)).toBe(1)

    await s.source.intents?.release([1])
    expect(await restarted.run({ window, expectedEntryIds: [1] })).toMatchObject({
      status: 'completed',
      entriesTransferred: 1,
    })
    expect(posts(p)).toBe(2)
  })

  it('releases the entries after a definite rejection so the next run retries them', async () => {
    const { p, s, runtime } = await build()
    s.entries.push(hour(1))
    const window = { from: '2026-09-01', to: '2026-10-18' }
    p.mode = 'reject'
    expect(await runtime.run({ window })).toMatchObject({ status: 'failed' })
    expect(s.open.size).toBe(0)
    p.mode = 'accept'
    expect(await runtime.run({ window })).toMatchObject({
      status: 'completed',
      entriesTransferred: 1,
    })
    expect(posts(p)).toBe(2)
  })

  it('stops before the next timesheet when the connection changes mid-run', async () => {
    const { p, s, creds, runtime } = await build()
    s.entries.push(hour(1), hour(2, '2026-09-03'))
    p.onPost = () => creds.set(null)
    const result = await runtime.run({ window: { from: '2026-09-01', to: '2026-10-18' } })
    expect(result).toMatchObject({
      status: 'failed',
      timesheetsSubmitted: 1,
      error: 'the Deel connection changed during the run, so the rest was not sent',
    })
    expect(posts(p)).toBe(1)
    expect([...s.log.keys()]).toEqual([1])
    expect(s.open.size).toBe(0)
  })
})
