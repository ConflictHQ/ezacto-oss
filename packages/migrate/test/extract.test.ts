// AC #1 behavioural half (account-wide assignment sweeps including is_active=false)
// and, deterministically, the snapshot/manifest mechanics AC #3 asserts on live
// data — so a regression is caught in milliseconds without credentials, and the
// live run is left to prove only the thing a fake server cannot: that the real
// account's shape matches what we assumed.

import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { appendFile, mkdtemp, readFile, rm, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runExtract, type ExtractResult } from '../src/extract.js'
import { writeManifest, type Manifest, type ManifestResource } from '../src/manifest.js'
import { RESOURCES } from '../src/resources.js'
import {
  envelope,
  startFakeHarvest,
  type FakeHarvest,
  type RouteHandler,
} from './harvest-server.js'
import { ADMIN_USER, preflight } from './fixtures.js'

const row = (id: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  name: `row ${id}`,
  created_at: '2026-01-01T00:00:00Z',
  ...extra,
})

/**
 * The same page with its `total_entries` removed. Harvest publishes no body for
 * any of the nested endpoints — resources.ts calls their envelope shape an
 * informed guess — so a child page that states no tally is a shape extract has to
 * be correct without: there is no outside witness to catch a truncation after
 * the fact.
 */
const untallied = (body: Record<string, unknown>): Record<string, unknown> => {
  const page = { ...body }
  delete page.total_entries
  return page
}

const USERS = [row(1), row(2)]
const INVOICES = [row(100), row(101)]

let server: FakeHarvest | undefined
let dir: string

/** Read straight off disk, mid-run, from inside a route handler. */
const manifestOnDisk = (): Manifest =>
  JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest
const linesOnDisk = (resource: string): string[] =>
  readFileSync(join(dir, 'raw', `${resource}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)

/**
 * Observations taken *during* the run, at the moment Harvest was asked for the
 * next page. This is how the ordering guarantee is asserted rather than assumed:
 * by the time page 2 is requested, page 1 must already be on disk and claimed.
 */
interface MidRun {
  usersWatermarkBeforeFirstRequest: string | undefined
  invoicePage2: { count: number; pages: number; lines: number } | undefined
}

const listRoutes = (
  mid: MidRun,
  overrides: Record<string, RouteHandler> = {},
): Record<string, RouteHandler> => ({
  // extract asks who this PAT is before it sweeps: the manifest describes the
  // token `auth` ran with, and this process re-read HARVEST_PAT.
  '/v2/users/me': () => ({ body: ADMIN_USER }),
  '/v2/users': () => {
    mid.usersWatermarkBeforeFirstRequest = manifestOnDisk().resources.users?.started_at
    return { body: envelope('users', USERS) }
  },
  '/v2/users/{id}/billable_rates': (url) => ({
    body: envelope('billable_rates', [row(Number(url.pathname.split('/')[3]) * 10)]),
  }),
  '/v2/users/{id}/cost_rates': (url) => ({
    body: envelope('cost_rates', [row(Number(url.pathname.split('/')[3]) * 100)]),
  }),
  // Gated by company.team_feature, which /v2/company does not report: the only
  // way to learn it is to ask and be refused.
  '/v2/users/{id}/teammates': () => ({ status: 403, body: { message: 'not enabled' } }),
  '/v2/roles': () => ({ body: envelope('roles', [row(20)]) }),
  '/v2/clients': () => ({ body: envelope('clients', [row(30)]) }),
  '/v2/contacts': () => ({ body: envelope('contacts', [row(40)]) }),
  '/v2/tasks': () => ({ body: envelope('tasks', [row(50)]) }),
  '/v2/expense_categories': () => ({ body: envelope('expense_categories', [row(60)]) }),
  '/v2/invoice_item_categories': () => ({ body: envelope('invoice_item_categories', [row(70)]) }),
  '/v2/projects': () => ({ body: envelope('projects', [row(80)]) }),
  '/v2/task_assignments': (url) => ({
    body: envelope('task_assignments', [
      row(url.searchParams.get('is_active') === 'true' ? 90 : 91),
    ]),
  }),
  '/v2/user_assignments': (url) => ({
    body: envelope('user_assignments', [
      row(url.searchParams.get('is_active') === 'true' ? 95 : 96),
    ]),
  }),
  // Two pages, so the per-page checkpoint has something to be observed between.
  '/v2/invoices': (_url, hit) => {
    if (hit === 1) {
      return {
        body: envelope(
          'invoices',
          [INVOICES[0]],
          `${server?.baseUrl ?? ''}/v2/invoices?cursor=NEXT`,
        ),
      }
    }
    const m = manifestOnDisk().resources.invoices
    mid.invoicePage2 = { count: m.count, pages: m.pages, lines: linesOnDisk('invoices').length }
    return { body: envelope('invoices', [INVOICES[1]]) }
  },
  '/v2/invoices/{id}/messages': (url) => ({
    body: envelope('invoice_messages', [row(Number(url.pathname.split('/')[3]) + 1000)]),
  }),
  '/v2/invoices/{id}/payments': (url) => ({
    body: envelope('invoice_payments', [row(Number(url.pathname.split('/')[3]) + 2000)]),
  }),
  '/v2/time_entries': () => ({ body: envelope('time_entries', [row(500), row(501)]) }),
  '/v2/expenses': () => ({ body: envelope('expenses', [row(600)]) }),
  ...overrides,
})

/** The manifest `auth` leaves behind: administrator PAT, estimate_feature off. */
const seedManifest = async (target: string): Promise<void> =>
  writeManifest(target, {
    account: { id: '42', name: 'CONFLICT' },
    company_name: 'CONFLICT',
    started_at: '2026-08-26T00:00:00.000Z',
    finished_at: null,
    tool_version: '0.0.0',
    preflight: preflight({ estimate_feature: false }),
    resources: {},
    updated_since: {},
  })

const extract = (target: string, logs?: string[], sleeps?: number[]): Promise<ExtractResult> =>
  runExtract({
    env: { pat: 'p', accountId: '42', userAgentEmail: 'e@x.com' },
    snapshotDir: target,
    baseUrl: server?.baseUrl,
    timeoutMs: 5_000,
    now: tickingClock(),
    log: (line) => logs?.push(line),
    // Recorded rather than waited: what a backoff *decided* is the assertion, and
    // no test should spend the seconds it decided on.
    sleep: (ms) => {
      sleeps?.push(ms)
      return Promise.resolve()
    },
  })

/** A clock that advances a second per read, so watermarks are distinguishable. */
const tickingClock = (): (() => Date) => {
  let t = Date.parse('2026-08-26T00:00:00.000Z')
  return () => {
    t += 1_000
    return new Date(t)
  }
}

describe('runExtract against a fake Harvest account', () => {
  let mid: MidRun
  let result: ExtractResult
  let logs: string[]

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ezacto-migrate-extract-'))
    mid = { usersWatermarkBeforeFirstRequest: undefined, invoicePage2: undefined }
    logs = []
    server = await startFakeHarvest(listRoutes(mid))

    // estimate_feature off, invoice/expense on: one feature-gated skip and one
    // live child fan-out in the same run.
    await seedManifest(dir)

    result = await extract(dir, logs)
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    await rm(dir, { recursive: true, force: true })
  })

  const paths = (): string[] => (server?.requests ?? []).map((r) => r.split('?')[0])

  it('[unit] assignment sweeps are account-wide and include is_active=false', async () => {
    for (const name of ['task_assignments', 'user_assignments']) {
      const hits = (server?.requests ?? []).filter((r) => r.startsWith(`/v2/${name}?`))
      expect(hits).toHaveLength(2)
      expect(hits.some((r) => r.includes('is_active=true'))).toBe(true)
      expect(hits.some((r) => r.includes('is_active=false'))).toBe(true)
    }
    // Never per-project, which is the shape that misses inactive rows entirely.
    expect(paths().some((p) => /^\/v2\/projects\/\d+\//.test(p))).toBe(false)

    // Both passes land in one file, distinguished by the rows themselves.
    expect(linesOnDisk('user_assignments').map((l) => JSON.parse(l))).toEqual([row(95), row(96)])
    expect(result.resources.user_assignments.count).toBe(2)
    expect(result.resources.user_assignments.pass).toBe(1)
  })

  it('[unit] requests go out in registry order', () => {
    const expected = RESOURCES.filter(
      (s) => !['estimates', 'estimate_messages', 'estimate_item_categories'].includes(s.name),
    ).map((s) => s.name)
    const seen: string[] = []
    for (const path of paths()) {
      const step = [...RESOURCES]
        .reverse()
        .find((s) =>
          s.kind === 'list'
            ? s.path === path
            : new RegExp(`^${s.path(0).replace('0', '\\d+')}$`).test(path),
        )
      if (step && seen[seen.length - 1] !== step.name) seen.push(step.name)
    }
    expect(seen).toEqual(expected)
  })

  it('[unit] raw jsonl is one parseable object per line, byte-for-byte what Harvest served', async () => {
    const invoices = (await readFile(join(dir, 'raw', 'invoices.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
    expect(invoices).toHaveLength(2)
    expect(invoices.map((l) => JSON.parse(l) as unknown)).toEqual(INVOICES)
    expect(
      (await readFile(join(dir, 'raw', 'users.jsonl'), 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as unknown),
    ).toEqual(USERS)
  })

  it('[unit] every non-skipped resource count equals its jsonl line count', () => {
    for (const [name, record] of Object.entries(result.resources)) {
      if (record.skipped_reason && record.count === 0 && record.pages === 0) continue
      expect(linesOnDisk(name), `${name} line count`).toHaveLength(record.count)
    }
  })

  it('[unit] the manifest is checkpointed per page, and never ahead of the file', () => {
    // Observed at the moment page 2 was requested: page 1 already appended, and
    // the manifest already claiming exactly what was on disk — not more.
    expect(mid.invoicePage2).toEqual({ count: 1, pages: 1, lines: 1 })
    expect(result.resources.invoices).toMatchObject({ count: 2, pages: 2, requests: 2 })
  })

  // Harvest evaluates updated_since against ITS clock, not ours. This suite's
  // clock is a fixed fake starting at 2026-08-26T00:00:00Z — years off the fake
  // server's real Date header — so if the watermark still came from `now()` it
  // would read 2026-08-26T00:00:0Xz and this fails.
  it('[unit] the updated_since watermark comes from the server clock, not the local one', async () => {
    const manifest = manifestOnDisk()
    const stamped = Date.parse(manifest.updated_since.users)
    const localClock = Date.parse(manifest.resources.users.finished_at as string)

    expect(Number.isFinite(stamped)).toBe(true)
    // not the local clock, which is what the defect stamped
    expect(Math.abs(stamped - localClock)).toBeGreaterThan(60_000)
    // and it is behind the server's own Date, never ahead: a watermark that runs
    // ahead of the server puts every row updated in the gap permanently out of
    // reach of updated_since, and nothing downstream can see that it happened
    expect(stamped).toBeLessThanOrEqual(Date.now())
    expect(manifest.resources.users.watermark_source).toBe(manifest.updated_since.users)
  })

  it('[unit] a feature-gated step is recorded as skipped and issues no requests', () => {
    for (const name of ['estimates', 'estimate_messages', 'estimate_item_categories']) {
      expect(result.resources[name]).toMatchObject({
        count: 0,
        pages: 0,
        requests: 0,
        complete: true,
        skipped_reason: 'estimate_feature is false',
      })
    }
    expect(paths().some((p) => p.startsWith('/v2/estimate'))).toBe(false)
    expect(logs.join('\n')).toContain('skipping 3 feature-gated step(s)')
  })

  it('[unit] a 403 from every user is the account answering, and the run continues', () => {
    const teammates = result.resources.teammates as ManifestResource
    // Only "the feature is off" once every parent has said so — and every parent
    // was asked, rather than the first refusal ending the fan-out.
    expect(paths().filter((p) => /^\/v2\/users\/\d+\/teammates$/.test(p))).toEqual([
      '/v2/users/1/teammates',
      '/v2/users/2/teammates',
    ])
    expect(teammates.skipped_reason).toContain('403 for all 2 users')
    expect(teammates.complete).toBe(true)
    // Each refusal still cost a request; the cost record must not read as free.
    expect(teammates.requests).toBe(2)
    // …and everything after it still ran.
    expect(result.resources.expenses.count).toBe(1)
    expect(manifestOnDisk().finished_at).not.toBeNull()
  })

  it('[unit] the child fan-out reads parent ids back off disk and covers every parent', () => {
    expect(paths().filter((p) => /^\/v2\/invoices\/\d+\/messages$/.test(p))).toEqual([
      '/v2/invoices/100/messages',
      '/v2/invoices/101/messages',
    ])
    expect(result.resources.invoice_payments.count).toBe(2)
    expect(result.resources.billable_rates.count).toBe(2)
    expect(logs.join('\n')).toContain('invoice_messages: fanning out over 2 invoices')
  })

  it('[unit] a re-run over a complete resource does not duplicate rows when nothing changed', async () => {
    // A re-run over a *complete* resource is an updated_since pass, not a
    // truncate-and-resweep — so the route only has to answer accurately for
    // that filter, the way a real account would when nothing changed.
    await server?.close()
    server = await startFakeHarvest(
      listRoutes(mid, {
        '/v2/users': (url) => ({
          body: envelope('users', url.searchParams.get('updated_since') ? [] : USERS),
        }),
      }),
    )

    await extract(dir)

    // Not four. Appending a second copy of unchanged rows is exactly what an
    // `updated_since` filter exists to avoid.
    expect(linesOnDisk('users').map((l) => JSON.parse(l) as unknown)).toEqual(USERS)
    expect(manifestOnDisk().resources.users).toMatchObject({ count: 2, incremental: true })
  })

  it('[unit] a re-run over a complete snapshot becomes an updated_since incremental pass', async () => {
    const watermark = manifestOnDisk().updated_since.users
    expect(watermark).toBeDefined()

    await server?.close()
    const seenParams: (string | null)[] = []
    server = await startFakeHarvest(
      listRoutes(mid, {
        '/v2/users': (url) => {
          const since = url.searchParams.get('updated_since')
          seenParams.push(since)
          // The one user Harvest reports as touched since the watermark.
          return { body: envelope('users', since ? [row(3)] : USERS) }
        },
      }),
    )

    await extract(dir)

    // The filter Harvest was actually asked with — the watermark this exact
    // resource stamped on the run before, not a fresh full sweep (`null`).
    expect(seenParams).toEqual([watermark])
    // Appended after the existing rows, not in place of them.
    expect(linesOnDisk('users').map((l) => JSON.parse(l) as unknown)).toEqual([...USERS, row(3)])
    expect(manifestOnDisk().resources.users).toMatchObject({
      count: 3,
      complete: true,
      incremental: true,
    })
    // A watermark is stamped for the *next* incremental pass to use.
    expect(manifestOnDisk().updated_since.users).toBeDefined()
  })

  it('[unit] the run reports its own cost', () => {
    expect(result.requests).toBe(server?.requests.length ?? 0)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })
})

describe('runExtract preconditions', () => {
  it('[unit] refuses a snapshot dir with no manifest, naming the command that makes one', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'ezacto-migrate-extract-empty-'))
    try {
      const err = await runExtract({
        env: { pat: 'p', accountId: '42', userAgentEmail: 'e@x.com' },
        snapshotDir: empty,
        log: () => {},
      }).catch((e: unknown) => e as Error)

      expect((err as Error).message).toContain('ezacto-migrate auth')
      expect((err as Error).message).toContain(empty)
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })
})

/**
 * The account is not a fixture: rows are created and deleted while the sweep runs
 * (migration-spec §5 runs extract against an account people are still using), the
 * PAT in the environment is not necessarily the one `auth` ran with, and a step
 * can fail after earlier ones have already written files. Each case below is a way
 * the previous shape of this module lost data, or claimed data it did not have.
 */
describe('runExtract when the account moves under it', () => {
  let logs: string[]
  let sleeps: number[]
  const mid: MidRun = { usersWatermarkBeforeFirstRequest: undefined, invoicePage2: undefined }

  /** Starts a fake account whose routes differ from the happy path where stated. */
  const start = async (overrides: Record<string, RouteHandler>): Promise<void> => {
    server = await startFakeHarvest(listRoutes(mid, overrides))
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ezacto-migrate-extract-moving-'))
    logs = []
    sleeps = []
    await seedManifest(dir)
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    await rm(dir, { recursive: true, force: true })
  })

  const userId = (url: URL): number => Number(url.pathname.split('/')[3])
  const requestPaths = (): string[] => (server?.requests ?? []).map((r) => r.split('?')[0])

  // Harvest's 403 is scoped to the object asked for (research §0.3: "the object you
  // requested was found but you don't have authorization"), so one user's refusal
  // says nothing about the next user's — and nothing at all about the account.
  it('[unit] one user refused does not end the teammates fan-out, and the reason says so', async () => {
    await start({
      '/v2/users/{id}/teammates': (url) =>
        userId(url) === 1
          ? { status: 403, body: { message: 'not authorized' } }
          : { body: envelope('teammates', [row(1002)]) },
    })

    const result = await extract(dir, logs)

    // User 2 was asked, and their teammates are in the snapshot.
    expect(server?.requests.map((r) => r.split('?')[0])).toContain('/v2/users/2/teammates')
    expect(linesOnDisk('teammates').map((l) => JSON.parse(l) as unknown)).toEqual([row(1002)])
    expect(result.resources.teammates.count).toBe(1)
    // …and the manifest says what actually happened, not "the account has no teammates".
    expect(result.resources.teammates.skipped_reason).toBe(
      'Harvest returned 403 for 1 of 2 users — those teammates are not in this snapshot',
    )
    expect(manifestOnDisk().finished_at).not.toBeNull()
  })

  // An invoice deleted between the parent sweep and the fan-out is a routine race,
  // not a reason to abandon every step after it.
  // Found by the live account, not by a fixture: Harvest answers
  // /v2/users/{id}/teammates with 422 "User must be a Manager to have teammates"
  // for every non-manager. Handling only 403/404 killed a full extract 34s in.
  it('[unit] a 422 saying the parent cannot have these rows is a refusal, not a failure', async () => {
    await start({
      '/v2/users/{id}/teammates': (url) =>
        url.pathname.endsWith('/1/teammates')
          ? { body: envelope('teammates', [row(900)]) }
          : {
              status: 422,
              body: { message: 'User must be a Manager to have teammates' },
            },
    })

    const result = await extract(dir, logs)

    const teammates = result.resources.teammates as ManifestResource
    expect(teammates.count).toBe(1)
    expect(teammates.complete).toBe(true)
    expect(teammates.skipped_reason).toContain('422 for 1 of 2 users')
    expect(teammates.requests).toBe(2)
    expect(manifestOnDisk().finished_at).not.toBeNull()
  })

  // The exact payload the adversarial pass used to prove the old writer corrupted
  // data: every value here is changed by JSON.parse -> JSON.stringify, and the id
  // is a bigint (research §15.5 flags time_entry.id specifically), so the old
  // path silently changed a primary key.
  it('[unit] record bytes reach raw/ unchanged, including a bigint id and money scale', async () => {
    const wire =
      '{"id":9007199254740993,"hours":8.00,"billable_rate":1e2,' +
      '"notes":"caf\u00e9","rounding":0.1000000000000000055511151231257827}'
    await start({
      '/v2/time_entries': () => ({
        body:
          '{"time_entries":[' +
          wire +
          '],"page":1,"total_pages":1,"total_entries":1,"links":{"next":null}}',
      }),
    })

    await extract(dir, logs)

    const onDisk = readFileSync(join(dir, 'raw', 'time_entries.jsonl'), 'utf8')
    expect(onDisk).toBe(`${wire}\n`)
    // and nothing was quietly re-serialised on the way
    expect(manifestOnDisk().resources.time_entries).toMatchObject({
      reserialized: 0,
      reflowed: 0,
    })
  })

  // The defect: the watermark was `now().toISOString()` from THIS machine. Harvest
  // filters updated_since against its own clock, so a host running fast stamped a
  // watermark in Harvest's future and every row updated in that window became
  // unreachable by any later incremental pass — permanently, and invisibly,
  // because the pass's own witness pair (0 fetched / 0 expected) agrees with
  // itself and the resource is marked complete.
  it('[unit] a host clock running fast cannot push the watermark past the server', async () => {
    await start({})
    await extract(dir, logs)

    const manifest = manifestOnDisk()
    const stamped = Date.parse(manifest.updated_since.clients)
    // the suite's injected clock is a fixed fake, years from real time; the
    // watermark must not have come from it
    const hostClock = Date.parse(manifest.resources.clients.finished_at as string)
    expect(Math.abs(stamped - hostClock)).toBeGreaterThan(60_000)
    // and it must sit at or behind real now, never ahead
    expect(stamped).toBeLessThanOrEqual(Date.now())
  })

  // Without a Date header there is no sound watermark, and inventing one from the
  // local clock is the defect above. Stamping nothing costs a full re-sweep next
  // run; stamping a guess costs rows.
  it('[unit] no server Date means no watermark, and the run says so', async () => {
    await start({
      '/v2/clients': () => ({
        headers: { date: '' },
        body: envelope('clients', [row(1)]),
      }),
    })

    await extract(dir, logs)

    const manifest = manifestOnDisk()
    expect(manifest.resources.clients.watermark_source).toBeNull()
    expect(manifest.updated_since.clients).toBeUndefined()
    expect(logs.join('\n')).toContain('no updated_since')
  })

  it('[unit] a 404 on one parent is recorded as missing and the run carries on', async () => {
    await start({
      '/v2/invoices/{id}/messages': (url) =>
        userId(url) === 101
          ? { status: 404, body: { message: 'Not Found' } }
          : { body: envelope('invoice_messages', [row(1100)]) },
    })

    const result = await extract(dir, logs)

    expect(result.resources.invoice_messages).toMatchObject({
      count: 1,
      missing_parents: 1,
      complete: true,
    })
    // The steps after the failure ran — which is the whole point.
    expect(result.resources.time_entries.count).toBe(2)
    expect(result.resources.expenses.count).toBe(1)
    expect(logs.join('\n')).toContain('invoices 101 returned 404')
  })

  // A 404 partway through one parent's *own* pagination is not that parent
  // vanishing — page 1 of it is already on disk and already counted. Classifying it
  // as "deleted since the parent sweep" keeps the partial rows, marks the resource
  // complete, and stamps updated_since over the rows it dropped, so no later
  // incremental pass ever re-reads them. The loss is permanent and the run exits 0.
  it('[unit] a 404 partway through one parent is a truncation, not a missing parent', async () => {
    await start({
      '/v2/invoices/{id}/messages': (url, hit) => {
        if (userId(url) !== 100) return { body: envelope('invoice_messages', [row(1101)]) }
        return hit === 1
          ? {
              body: {
                ...envelope(
                  'invoice_messages',
                  [row(1001), row(1002), row(1003)],
                  `${server?.baseUrl ?? ''}/v2/invoices/100/messages?cursor=PAGE2`,
                ),
                total_entries: 6,
              },
            }
          : { status: 404, body: { message: 'Not Found' } }
      },
    })

    const err = (await extract(dir, logs).catch((e: unknown) => e)) as Error

    expect(err.message).toContain('invoices 100 answered 404 on page 2 of its own pagination')
    expect(err.message).toContain('raw/invoice_messages.jsonl')
    expect(err.message).toContain('truncated invoices, not a missing one')

    const manifest = manifestOnDisk()
    // Not counted as missing: invoice 100 was found, and partly extracted.
    expect(manifest.resources.invoice_messages).toMatchObject({
      count: 3,
      missing_parents: 0,
      complete: false,
    })
    // The only outside witness has to point *at* the loss. Folding the tally in
    // after the last page instead of the first left this at 1 against a count of 4
    // — a snapshot 3 rows short, described as 3 rows long.
    expect(manifest.resources.invoice_messages.total_entries).toBe(6)
    expect(linesOnDisk('invoice_messages')).toHaveLength(3)

    // Nothing downstream may treat this snapshot as usable, and nothing may step
    // over the dropped rows next time.
    expect(manifest.finished_at).toBeNull()
    expect(manifest.updated_since.invoice_messages).toBeUndefined()
    expect(requestPaths()).not.toContain('/v2/invoices/101/messages')
  })

  // The same misclassification with a single parent used to reach the guess-guard
  // below and abort with a message that was flatly false — "refusing to record an
  // empty billable_rates" while raw/billable_rates.jsonl held rows.
  it('[unit] a truncated lone parent is not reported as an empty resource', async () => {
    await start({
      '/v2/users': () => ({ body: envelope('users', [row(1)]) }),
      '/v2/users/{id}/billable_rates': (_url, hit) =>
        hit === 1
          ? {
              body: envelope(
                'billable_rates',
                [row(10), row(11)],
                `${server?.baseUrl ?? ''}/v2/users/1/billable_rates?cursor=PAGE2`,
              ),
            }
          : { status: 404, body: { message: 'Not Found' } },
    })

    const err = (await extract(dir, logs).catch((e: unknown) => e)) as Error

    expect(err.message).not.toContain('refusing to record an empty')
    expect(err.message).toContain('users 1 answered 404 on page 2')
    expect(linesOnDisk('billable_rates')).toHaveLength(2)
  })

  // The same misclassification across a *resume*, which the guard above could not
  // see: `pagesBefore` is captured fresh each run, so a parent picked up at its
  // stored cursor starts level with it. A 404 on that first request then left
  // `record.pages` where it began and read as a parent that gave us nothing — it
  // was recorded missing, the checkpoint moved past it, its page 1 stayed in
  // raw/invoice_messages.jsonl and in `count`, and the step finished
  // `complete: true` with updated_since stamped over the rows it never got. With
  // no total_entries on the page (the nested endpoints publish no body) there is
  // no second witness either: the run exits 0 and the loss is permanent.
  it('[unit] a parent resumed at its cursor and then 404d is a truncation, not a missing parent', async () => {
    let cursorGone = false
    await start({
      '/v2/invoices/{id}/messages': (url) => {
        if (userId(url) !== 100) return { body: envelope('invoice_messages', [row(1101)]) }
        if (url.searchParams.get('cursor') === 'NEXT') {
          return cursorGone
            ? { status: 404, body: { message: 'Not Found' } }
            : { status: 500, body: { message: 'boom' } }
        }
        return {
          body: untallied(
            envelope(
              'invoice_messages',
              [row(1001)],
              `${server?.baseUrl ?? ''}/v2/invoices/100/messages?cursor=NEXT`,
            ),
          ),
        }
      },
    })

    const crashed = (await extract(dir, logs).catch((e: unknown) => e)) as Error
    expect(crashed.message).toContain('invoice_messages')
    expect(manifestOnDisk().resources.invoice_messages).toMatchObject({
      count: 1,
      pages: 1,
      parent_id: 100,
      interrupted: true,
    })
    expect(manifestOnDisk().resources.invoice_messages.next_url).toContain('cursor=NEXT')

    // Invoice 100 is deleted between the crash and the resume, so the cursor the
    // checkpoint names — the resumed parent's first request — now 404s.
    cursorGone = true
    const requestsBefore = server?.requests.length ?? 0
    const err = (await extract(dir, logs).catch((e: unknown) => e)) as Error
    const resumed = (server?.requests ?? []).slice(requestsBefore).map((r) => r.split('?')[0])

    expect(err.message).toContain('invoices 100 answered 404')
    expect(err.message).toContain('truncated invoices, not a missing one')
    expect(err.message).toContain('raw/invoice_messages.jsonl')

    const manifest = manifestOnDisk()
    expect(manifest.resources.invoice_messages).toMatchObject({
      count: 1,
      missing_parents: 0,
      complete: false,
    })
    // Page 1 of invoice 100 is still on disk — and nothing may describe the file
    // holding it as a complete sweep, or step over the rest of it next time.
    expect(linesOnDisk('invoice_messages')).toHaveLength(1)
    expect(manifest.finished_at).toBeNull()
    expect(manifest.updated_since.invoice_messages).toBeUndefined()
    expect(resumed).not.toContain('/v2/invoices/101/messages')
  })

  // …but a path that 404s for *every* parent is not a race, and an empty resource
  // recorded as complete is the silent data loss the registry's guess-guard exists for.
  it('[unit] every parent 404ing stops the run and names the path that answered', async () => {
    await start({
      '/v2/invoices/{id}/messages': () => ({ status: 404, body: { message: 'Not Found' } }),
    })

    const err = (await extract(dir, logs).catch((e: unknown) => e)) as Error

    expect(err.message).toContain('every one of the 2 invoices')
    expect(err.message).toContain('/v2/invoices/101/messages')
    expect(err.message).toContain('refusing to record an empty invoice_messages')
  })

  // …and it has to be a stop the snapshot can come back from. Every one of those
  // 404s checkpointed itself, so the record was left `interrupted` at the last
  // invoice: the next run resumed into it, skipped every parent looking for that
  // id, issued no request to the child endpoint at all, inherited the dead run's
  // missing_parents and threw the byte-identical error — forever, however long
  // ago Harvest recovered. The usage text and RESUME_GUIDANCE both promise a
  // re-run resumes; the only way out was editing manifest.json by hand.
  it('[unit] a fan-out that 404d for every parent is swept again once the path answers', async () => {
    let gone = true
    await start({
      '/v2/invoices/{id}/messages': (url) =>
        gone
          ? { status: 404, body: { message: 'Not Found' } }
          : { body: envelope('invoice_messages', [row(userId(url) + 1000)]) },
    })

    const err = (await extract(dir, logs).catch((e: unknown) => e)) as Error
    expect(err.message).toContain('every one of the 2 invoices')
    // Not resumable: nothing is left for a re-run to pick up mid-fan-out, and the
    // dead run's tally does not carry into the run that sweeps this again.
    expect(manifestOnDisk().resources.invoice_messages).toMatchObject({
      interrupted: false,
      parent_id: null,
      next_url: null,
      missing_parents: 0,
      complete: false,
    })

    gone = false
    const requestsBefore = server?.requests.length ?? 0
    const result = await extract(dir, logs)
    const resumed = (server?.requests ?? []).slice(requestsBefore).map((r) => r.split('?')[0])

    // Every invoice asked again, once each — the requests the stuck record made
    // impossible.
    expect(resumed.filter((p) => /^\/v2\/invoices\/\d+\/messages$/.test(p))).toEqual([
      '/v2/invoices/100/messages',
      '/v2/invoices/101/messages',
    ])
    expect(result.resources.invoice_messages).toMatchObject({
      count: 2,
      missing_parents: 0,
      complete: true,
    })
    expect(linesOnDisk('invoice_messages')).toHaveLength(2)
    expect(manifestOnDisk().finished_at).not.toBeNull()
  })

  // `Harvest API error: 422 {"message":"…"}` names no resource, no path, and none of
  // the "everything so far is on disk" guidance the 429/5xx path already gives.
  it('[unit] a failure a retry cannot fix names the resource, the path and the way on', async () => {
    await start({
      '/v2/invoices/{id}/messages': () => ({ status: 422, body: { message: 'Unprocessable' } }),
    })

    const err = (await extract(dir, logs).catch((e: unknown) => e)) as Error

    expect(err.message).toContain('invoice_messages')
    expect(err.message).toContain('/v2/invoices/100/messages')
    expect(err.message).toContain('422')
    expect(err.message).toContain('--snapshot-dir')
  })

  // manifest.finished_at is the completeness signal every consumer keys on. A
  // re-run over an already-complete resource is now an incremental append, not a
  // truncate-and-resweep — so a failure before that pass writes anything must
  // leave the *previous* run's rows standing (they are still an accurate,
  // complete snapshot as of the old watermark) while still refusing to claim the
  // run that just failed finished.
  it('[unit] a re-run that dies mid-sweep leaves the previous rows in place, unfinished', async () => {
    await start({})
    await extract(dir)
    expect(manifestOnDisk().finished_at).not.toBeNull()
    expect(linesOnDisk('clients')).toHaveLength(1)

    await server?.close()
    await start({ '/v2/clients': () => ({ status: 500, body: { message: 'boom' } }) })
    const err = (await extract(dir, logs).catch((e: unknown) => e)) as Error

    expect(err.message).toContain('clients')
    const manifest = manifestOnDisk()
    expect(manifest.finished_at).toBeNull()
    // The prior run's row is untouched — an incremental pass stages its rows and
    // merges them only once it finishes, so a failure before its first successful
    // page is a no-op on the file the manifest is describing.
    expect(manifest.resources.clients).toMatchObject({
      count: 1,
      complete: false,
      incremental: true,
    })
    expect(linesOnDisk('clients')).toHaveLength(1)
  })

  // The same failure one step earlier is where this used to lose rows silently.
  // The incremental record was spread from the last *full* sweep's, inheriting
  // its `pages`, `pass` and `next_url: null` — so a pass that died before its
  // first request left a record the next run read as "that pass ran to the end of
  // its cursor". It issued no requests at all, stamped the resource complete, and
  // moved updated_since to the dead run's start time: every row changed in
  // between was behind the watermark for good, and the run exited 0.
  it('[unit] an incremental pass that dies before its first page is re-run, not stepped over', async () => {
    let down = false
    await start({
      '/v2/clients': (url) =>
        down
          ? { status: 500, body: { message: 'boom' } }
          : {
              body: envelope(
                'clients',
                url.searchParams.get('updated_since') ? [row(31)] : [row(30)],
              ),
            },
    })
    await extract(dir, logs)
    const watermark = manifestOnDisk().updated_since.clients
    expect(watermark).toBeDefined()

    down = true
    const failed = (await extract(dir, logs).catch((e: unknown) => e)) as Error
    expect(failed.message).toContain('clients')
    // A pass that fetched nothing may not move the watermark it was reading.
    expect(manifestOnDisk().updated_since.clients).toBe(watermark)

    down = false
    const before = server?.requests.length ?? 0
    const result = await extract(dir, logs)
    const resumed = (server?.requests ?? [])
      .slice(before)
      .filter((r) => r.startsWith('/v2/clients?'))

    // The pass the outage killed actually goes out this time, filtered on the
    // watermark it never got past — so the row changed in the meantime lands.
    expect(resumed).toHaveLength(1)
    expect(resumed[0]).toContain(`updated_since=${encodeURIComponent(watermark)}`)
    expect(linesOnDisk('clients').map((l) => JSON.parse(l) as unknown)).toEqual([row(30), row(31)])
    expect(result.resources.clients).toMatchObject({
      count: 2,
      complete: true,
      incremental: true,
    })
  })

  // /v2/roles takes only `page` and `per_page` (research §7, §13). Harvest ignores
  // query params it does not implement, so an incremental pass over it asked for
  // the changed roles, was handed the whole collection, and appended it: a second
  // copy of every role on every re-run, unbounded, with the truncation warning
  // suppressed because the record called itself incremental.
  it('[unit] roles is swept in full on a re-run — Harvest has no updated_since for it', async () => {
    await start({ '/v2/roles': () => ({ body: envelope('roles', [row(20), row(21)]) }) })

    await extract(dir, logs)
    await extract(dir, logs)

    const queries = (server?.requests ?? []).filter((r) => r.startsWith('/v2/roles?'))
    expect(queries).toHaveLength(2)
    expect(queries.some((q) => q.includes('updated_since'))).toBe(false)
    expect(linesOnDisk('roles').map((l) => JSON.parse(l) as unknown)).toEqual([row(20), row(21)])
    expect(manifestOnDisk().resources.roles).toMatchObject({
      count: 2,
      total_entries: 2,
      complete: true,
      incremental: false,
    })
  })

  // A sweep that ran out of cursor short of Harvest's tally has no page left to
  // resume from — but it looked exactly like one that did (`pages > 0`,
  // `next_url: null`), so the re-run skipped straight past it, issued nothing,
  // re-evaluated the same shortfall and threw the same error. Forever: the
  // snapshot could never be finished, while the error and the CLI both promised a
  // re-run would sweep it again.
  it('[unit] a sweep that fell short is swept again next run, not resumed into a no-op', async () => {
    let honest = false
    await start({
      '/v2/clients': () =>
        honest
          ? { body: envelope('clients', [row(30), row(31)]) }
          : { body: { ...envelope('clients', [row(30)]), total_entries: 2 } },
    })

    const err = (await extract(dir, logs).catch((e: unknown) => e)) as Error
    expect(err.message).toContain('extract did not complete: clients')

    honest = true
    const before = server?.requests.length ?? 0
    const result = await extract(dir, logs)
    const second = (server?.requests ?? [])
      .slice(before)
      .filter((r) => r.startsWith('/v2/clients?'))

    // Asked again, from page 1 — not an incremental pass over a file known to be
    // missing rows, which would leave the gap in place behind a watermark.
    expect(second).toHaveLength(1)
    expect(second[0]).not.toContain('updated_since')
    expect(linesOnDisk('clients').map((l) => JSON.parse(l) as unknown)).toEqual([row(30), row(31)])
    expect(result.resources.clients).toMatchObject({
      count: 2,
      total_entries: 2,
      complete: true,
    })
    expect(manifestOnDisk().finished_at).not.toBeNull()
  })

  // The same truncation on the path that carries the volume on every re-run, and
  // the path that stamps the watermark. A filtered pass had no witness at all:
  // `total_entries` was discarded for one and the shortfall gate was suppressed, so
  // a `links.next: null` that should not have been null was merged, stamped
  // `complete`, given a fresh watermark and exited 0 — and the changed rows the pass
  // never fetched were behind that watermark for good. Harvest states total_entries
  // for a filtered query too, and it counts exactly the rows the pass staged.
  it('[unit] an incremental pass that stops short of the changed rows is not a complete pass', async () => {
    let honest = false
    await start({
      '/v2/clients': (url) =>
        url.searchParams.get('updated_since') === null
          ? { body: envelope('clients', [row(30)]) }
          : honest
            ? { body: envelope('clients', [row(31)]) }
            : // Harvest states five rows match the filter, hands back one, and
              // calls it the last page.
              { body: { ...envelope('clients', [row(31)]), total_entries: 5 } },
    })

    await extract(dir, logs)
    const watermark = manifestOnDisk().updated_since.clients
    expect(watermark).toBeDefined()

    const err = (await extract(dir, logs).catch((e: unknown) => e)) as Error

    expect(err.message).toContain('extract did not complete: clients')
    expect(err.message).toContain('clients staged 1 of the 5 entries Harvest reported changed')
    expect(logs.join('\n')).toContain('WARNING: clients — Harvest reported 5 entries changed since')
    const manifest = manifestOnDisk()
    expect(manifest.resources.clients).toMatchObject({
      staged_count: 1,
      staged_total_entries: 5,
      complete: false,
      incremental: true,
    })
    // The watermark is what would put the four rows this pass never got out of
    // reach of every later pass, so it stays exactly where the last complete
    // sweep left it — and the snapshot does not claim to be finished.
    expect(manifest.updated_since.clients).toBe(watermark)
    expect(manifest.finished_at).toBeNull()

    // …and the resource is not stuck: a pass that fell short has no page left to
    // continue from, so the next run sweeps it again from page 1.
    honest = true
    const before = server?.requests.length ?? 0
    const result = await extract(dir, logs)
    const swept = (server?.requests ?? []).slice(before).filter((r) => r.startsWith('/v2/clients?'))

    expect(swept).toHaveLength(1)
    expect(swept[0]).not.toContain('updated_since')
    expect(result.resources.clients).toMatchObject({ count: 1, complete: true })
    expect(manifestOnDisk().finished_at).not.toBeNull()
  })

  // The ordinary re-run path — a complete snapshot, a fresh incremental pass — was
  // the one resume path that took `count` on trust. The other two reconcile it
  // against the file first and refuse a file holding fewer rows than the manifest
  // claims; this one went straight to staging, and let the merge rewrite the
  // resource around whatever was on disk. The rows an fsync had promised were gone,
  // the shorter file became the new `count`, and the record was stamped complete
  // with a fresh watermark over the loss.
  it('[unit] a fresh incremental pass refuses a file that lost rows the manifest claims', async () => {
    await start({
      '/v2/clients': (url) => ({
        body: envelope(
          'clients',
          url.searchParams.get('updated_since') ? [row(31)] : [row(30), row(32), row(33)],
        ),
      }),
    })

    await extract(dir, logs)
    expect(manifestOnDisk().resources.clients).toMatchObject({ count: 3, complete: true })

    // A restored or half-copied snapshot dir, a partial restore, a disk error —
    // anything that moves the file out from under a manifest the page loop is not
    // running inside of.
    await truncate(join(dir, 'raw', 'clients.jsonl'), 0)

    const err = (await extract(dir, logs).catch((e: unknown) => e)) as Error

    expect(err.message).toContain('holds 0 committed line(s) but manifest.json claims 3')
    expect(err.message).toContain('This snapshot cannot be resumed safely')
    const manifest = manifestOnDisk()
    expect(manifest.finished_at).toBeNull()
    // The refusal comes before the pass writes anything, so nothing adopted the
    // shorter file: `count` still says what the snapshot is supposed to hold, and
    // the merge that would have rewritten the resource around the loss never ran.
    expect(manifest.resources.clients.count).toBe(3)
    expect(linesOnDisk('clients')).toEqual([])

    // And it stays refused rather than healing itself into a smaller account —
    // this is the one state extract asks for a restore from backup.
    const again = (await extract(dir, logs).catch((e: unknown) => e)) as Error
    expect(again.message).toContain('manifest.json claims 3')
  })

  // An incremental pass returns fresher copies of rows the snapshot already
  // holds. Appended, they were a second line for every changed row — and where
  // the resource is a fan-out parent, `readIds` handed the same id to the child
  // step twice: two requests per changed parent and two copies of its children,
  // with `count` and `total_entries` both doubling so nothing noticed.
  it('[unit] an incremental parent pass does not duplicate rows or fan its children out twice', async () => {
    await start({
      '/v2/invoices': (url) => ({
        body: envelope(
          'invoices',
          url.searchParams.get('updated_since') ? [INVOICES[0]] : INVOICES,
        ),
      }),
    })

    await extract(dir, logs)
    const before = server?.requests.length ?? 0
    const result = await extract(dir, logs)
    const second = (server?.requests ?? []).slice(before).map((r) => r.split('?')[0])

    // Invoice 100 came back changed. It is still one invoice, in the position it
    // already had — a fan-out resuming into this file skips forward through it in
    // order, so a merge that moved changed parents to the end would make it skip
    // every parent that had moved behind the one it stopped inside.
    expect(linesOnDisk('invoices').map((l) => JSON.parse(l) as unknown)).toEqual(INVOICES)
    expect(result.resources.invoices).toMatchObject({ count: 2, incremental: true })
    expect(second.filter((p) => p === '/v2/invoices/100/messages')).toHaveLength(1)
    expect(second.filter((p) => p === '/v2/invoices/101/messages')).toHaveLength(1)
    expect(linesOnDisk('invoice_messages').map((l) => JSON.parse(l) as unknown)).toEqual([
      row(1100),
      row(1101),
    ])
    expect(result.resources.invoice_messages).toMatchObject({
      count: 2,
      total_entries: 2,
      complete: true,
    })
  })

  // `watermark` was only resolved for a *fresh* incremental pass, but the
  // `incremental` flag survived into the resumed record — so every pass after the
  // one being resumed spread `undefined` into the query string and asked Harvest
  // for `updated_since=undefined`. Harvest either rejects it (the resume can
  // never finish) or ignores it and hands back the whole collection.
  it('[unit] a re-run of a killed multi-pass incremental filters every pass, never on undefined', async () => {
    let page2Recovered = false
    await start({
      '/v2/task_assignments': (url) => {
        const since = url.searchParams.get('updated_since')
        const active = url.searchParams.get('is_active') === 'true'
        // `links.next` is followed verbatim, so the cursor page carries neither
        // filter — it is checked first, before the params either pass sends.
        if (url.searchParams.get('cursor') === 'NEXT') {
          return page2Recovered
            ? { body: envelope('task_assignments', [row(902)]) }
            : { status: 500, body: { message: 'boom' } }
        }
        if (since === null) return { body: envelope('task_assignments', [row(active ? 90 : 91)]) }
        if (!active) return { body: envelope('task_assignments', [row(901)]) }
        return {
          body: envelope(
            'task_assignments',
            [row(900)],
            `${server?.baseUrl ?? ''}/v2/task_assignments?cursor=NEXT`,
          ),
        }
      },
    })

    await extract(dir, logs)
    const watermark = manifestOnDisk().updated_since.task_assignments

    const err = (await extract(dir, logs).catch((e: unknown) => e)) as Error
    expect(err.message).toContain('task_assignments')

    page2Recovered = true
    const before = server?.requests.length ?? 0
    const result = await extract(dir, logs)
    const resumed = (server?.requests ?? [])
      .slice(before)
      .filter((r) => r.startsWith('/v2/task_assignments?'))

    expect(resumed.join('\n')).not.toContain('undefined')
    // The is_active=false pass is the one that used to carry it: it is reached
    // after the pass the crash landed in, so it is built from params, not replayed
    // from a stored cursor.
    const inactive = resumed.filter((r) => r.includes('is_active=false'))
    expect(inactive).toHaveLength(1)
    expect(inactive[0]).toContain(`updated_since=${encodeURIComponent(watermark)}`)
    // The killed pass's staged rows were discarded and re-fetched, so nothing is
    // in the file twice.
    expect(linesOnDisk('task_assignments').map((l) => JSON.parse(l) as unknown)).toEqual([
      row(90),
      row(91),
      row(900),
      row(902),
      row(901),
    ])
    expect(result.resources.task_assignments).toMatchObject({ count: 5, complete: true })
  })

  // count == jsonl line count is true of any truncation. Harvest's own tally is the
  // only witness from outside the sweep, and it is what `verify` will gate on.
  // Harvest's own tally is the only witness to a sweep from outside it, and a
  // sweep that comes up short of it is the same permanent truncation this file
  // refuses to accept from a child parent. Recording it `complete: true` would
  // stamp updated_since and put the 3999 missing rows out of reach of every later
  // incremental pass — the loss would be silent and unrecoverable.
  it('[unit] a sweep that stops short of Harvest total_entries is not a complete sweep', async () => {
    await start({
      '/v2/time_entries': () => ({
        // one row, a stated four thousand, and links.next already null
        body: { ...envelope('time_entries', [row(500)]), total_entries: 4000, total_pages: 2 },
      }),
    })

    const err = (await extract(dir, logs).catch((e: unknown) => e)) as Error

    expect(err.message).toContain('extract did not complete: time_entries')
    expect(err.message).toContain('time_entries holds 1 of 4000 entries')
    expect(logs.join('\n')).toContain(
      'WARNING: time_entries — Harvest reported 4000 entries and the snapshot holds 1 rows',
    )

    const manifest = manifestOnDisk()
    // recorded, not complete, and no watermark to step over the missing rows with
    expect(manifest.resources.time_entries).toMatchObject({
      count: 1,
      total_entries: 4000,
      complete: false,
    })
    expect(manifest.updated_since.time_entries).toBeUndefined()
    // and the snapshot as a whole does not claim to be finished
    expect(manifest.finished_at).toBeNull()
    // every other resource still swept — one short resource does not throw the run away
    expect(manifest.resources.clients).toMatchObject({ complete: true })
  })

  // Writing *more* than the stated tally is rows created while the sweep ran. It
  // cannot conceal a truncation, so it warns and completes — failing here would
  // fail every extract of an account somebody is still working in.
  it('[unit] a sweep that overshoots total_entries warns but still completes', async () => {
    await start({
      '/v2/time_entries': () => ({
        body: { ...envelope('time_entries', [row(500), row(501)]), total_entries: 1 },
      }),
    })

    const result = await extract(dir, logs)

    expect(result.resources.time_entries).toMatchObject({ count: 2, complete: true })
    expect(logs.join('\n')).toContain('(1 over)')
    expect(manifestOnDisk().finished_at).not.toBeNull()
  })

  // `count: 0` is a claim about raw/<resource>.jsonl. A feature switched off
  // between runs used to leave the previous run's rows sitting there under a
  // manifest that denied they existed: `load` reads raw/ (§3) and would have
  // imported them, `verify` compares manifest counts and would have seen none —
  // and the run stamped finished_at and exited 0 over the disagreement.
  it('[unit] a resource gated off since the last run has its rows cleared, not orphaned', async () => {
    await start({})
    await extract(dir, logs)
    expect(linesOnDisk('invoices')).toHaveLength(2)

    // what `auth` writes after the customer turns invoicing off
    const manifest = manifestOnDisk()
    await writeManifest(dir, {
      ...manifest,
      preflight: { ...manifest.preflight, invoice_feature: false },
    })
    await server?.close()
    await start({})

    await extract(dir, logs)

    const after = manifestOnDisk()
    expect(after.resources.invoices).toMatchObject({
      count: 0,
      complete: true,
      skipped_reason: 'invoice_feature is false',
    })
    // the file agrees with the count that describes it
    expect(linesOnDisk('invoices')).toEqual([])
    // and no watermark is left standing for an incremental pass to step over
    expect(after.updated_since.invoices).toBeUndefined()
  })

  // The mirror image of the test above: a skipped resource's manifest record is
  // `complete: true` with no `updated_since` entry — exactly what an already-swept
  // resource looks like. Turning the feature back on has to read that correctly
  // as "never actually swept", not query `updated_since=undefined` and hand back
  // an empty resource forever.
  it('[unit] a resource gated back on after being skipped gets a full sweep, not a broken incremental one', async () => {
    await start({})
    const before = manifestOnDisk()
    await writeManifest(dir, {
      ...before,
      preflight: { ...before.preflight, invoice_feature: false },
    })

    await extract(dir, logs)
    expect(manifestOnDisk().resources.invoices).toMatchObject({
      count: 0,
      complete: true,
      skipped_reason: 'invoice_feature is false',
    })
    expect(manifestOnDisk().updated_since.invoices).toBeUndefined()

    await server?.close()
    await start({})
    const reenabled = manifestOnDisk()
    await writeManifest(dir, {
      ...reenabled,
      preflight: { ...reenabled.preflight, invoice_feature: true },
    })

    await extract(dir, logs)

    const after = manifestOnDisk()
    expect(after.resources.invoices).toMatchObject({
      count: 2,
      complete: true,
      skipped_reason: null,
    })
    expect(linesOnDisk('invoices').map((l) => JSON.parse(l) as unknown)).toEqual(INVOICES)
    expect(after.updated_since.invoices).toBeDefined()
  })

  // The manifest describes the PAT `auth` ran with; this process re-read HARVEST_PAT.
  // Sweeping anyway writes a fraction of the account under a preflight that claims
  // administrator visibility, prints no warning, and exits 0.
  it('[unit] a PAT that is not the stamped identity is refused before the first sweep', async () => {
    await start({
      // same user, demoted since auth — the case that silently shrinks the snapshot
      '/v2/users/me': () => ({ body: { id: 1, access_roles: ['member'] } }),
    })

    const err = (await extract(dir, logs).catch((e: unknown) => e)) as Error

    expect(err.message).toContain('was administrator, is now member-scoped')
    expect(err.message).toContain('ezacto-migrate auth')
    // Nothing was swept, so nothing on disk was overwritten by the wrong identity.
    expect(server?.requests).toEqual(['/v2/users/me'])
    expect(manifestOnDisk().resources).toEqual({})
  })

  // The identity check is the first request of every run and the one most likely to
  // meet a rate-limit window left warm by the run before it. Issued outside the
  // paginator's policy it took the whole run down at request #1 on a 429, with no
  // Retry-After honored and no retry — the exact condition AC #2 exists for.
  it('[unit] a 429 on the identity check honors Retry-After and retries, like every other request', async () => {
    await start({
      '/v2/users/me': (_url, hit) =>
        hit === 1
          ? { status: 429, headers: { 'retry-after': '2' }, body: { message: 'throttled' } }
          : { body: ADMIN_USER },
    })

    const result = await extract(dir, logs, sleeps)

    expect(requestPaths().filter((p) => p === '/v2/users/me')).toHaveLength(2)
    expect(sleeps[0]).toBe(2_000)
    expect(logs.join('\n')).toContain('identity check: throttled by Harvest (429), waiting 2s')
    // …and the run it would have killed went on to sweep the account.
    expect(result.resources.users.count).toBe(2)
    expect(manifestOnDisk().finished_at).not.toBeNull()
  })

  it('[unit] an identity-check failure a retry cannot fix says what it was and what is on disk', async () => {
    await start({ '/v2/users/me': () => ({ status: 422, body: { message: 'nope' } }) })

    const err = (await extract(dir, logs).catch((e: unknown) => e)) as Error

    // Not the bare `Harvest API error: 422 {...}` this call used to surface.
    expect(err.message).toContain('identity check: request to /v2/users/me failed')
    expect(err.message).toContain('Nothing was swept')
    expect(err.message).toContain(dir)
  })

  // manifest.resources[*].next_url is read back now, so "re-run to continue"
  // means what it says: the resources that already finished are not re-swept
  // from page 1, and the one that failed picks up from wherever it stopped.
  it('[unit] a failed run resumes without re-sweeping every already-complete resource', async () => {
    await start({
      '/v2/expenses': (_url, hit) =>
        hit === 1
          ? { status: 422, body: { message: 'Unprocessable' } }
          : { body: envelope('expenses', [row(600)]) },
    })

    const err = (await extract(dir, logs).catch((e: unknown) => e)) as Error
    expect(err.message).toContain('resumes this resource from its last checkpoint')

    const afterFirstRun = server?.requests.length ?? 0
    const result = await extract(dir, logs)
    const second = (server?.requests ?? []).slice(afterFirstRun).map((r) => r.split('?')[0])

    // users is a complete `list` resource: the second run touches it exactly
    // once, as an updated_since pass — not the sweep a fresh run would issue.
    expect(second.filter((p) => p === '/v2/users')).toHaveLength(1)
    // expenses never wrote a row before the failure, so there was nothing to
    // resume — the second run sweeps it fresh, and this time it succeeds.
    expect(second).toContain('/v2/expenses')
    expect(result.resources.expenses.count).toBe(1)
    expect(manifestOnDisk().finished_at).not.toBeNull()
  })

  // AC #1: a kill mid-resource resumes from the last cursor rather than
  // re-fetching completed pages — page 1 lands on disk and is claimed by the
  // manifest, page 2 never comes back, and the resumed run has to ask for
  // exactly the one page it is missing.
  it('[unit] Kill -9 mid-resource then rerun: no duplicate lines, no gaps, manifest counts correct', async () => {
    // `next_url` is only ever valid on the origin that issued it (paginator
    // refuses to follow a link off the API host), so the crash and the resume
    // have to hit the same fake server — one flag flips page 2 from "500 forever"
    // to "answers", the way a real Harvest outage recovering would look.
    let page2Recovered = false
    await start({
      '/v2/invoices': (url) =>
        url.searchParams.get('cursor') === 'NEXT'
          ? page2Recovered
            ? { body: envelope('invoices', [INVOICES[1]]) }
            : { status: 500, body: { message: 'boom' } }
          : {
              body: envelope(
                'invoices',
                [INVOICES[0]],
                `${server?.baseUrl ?? ''}/v2/invoices?cursor=NEXT`,
              ),
            },
    })

    const err = (await extract(dir, logs).catch((e: unknown) => e)) as Error
    expect(err.message).toContain('invoices')

    const midCrash = manifestOnDisk()
    expect(midCrash.resources.invoices).toMatchObject({ count: 1, pages: 1, complete: false })
    expect(midCrash.resources.invoices.next_url).toContain('cursor=NEXT')
    expect(linesOnDisk('invoices')).toHaveLength(1)

    page2Recovered = true
    const requestsBefore = server?.requests.length ?? 0

    const result = await extract(dir, logs)

    // Resumed straight from the stored cursor: exactly one further request to
    // /v2/invoices, not the two a from-scratch sweep would have made.
    expect(
      (server?.requests ?? [])
        .slice(requestsBefore)
        .map((r) => r.split('?')[0])
        .filter((p) => p === '/v2/invoices'),
    ).toHaveLength(1)
    // No gap, no duplicate: page 1 from before the crash, page 2 from the resume.
    expect(linesOnDisk('invoices').map((l) => JSON.parse(l) as unknown)).toEqual(INVOICES)
    expect(result.resources.invoices).toMatchObject({ count: 2, pages: 2, complete: true })
    expect(manifestOnDisk().finished_at).not.toBeNull()
  })

  // Same guarantee one level deeper: a fan-out killed partway through one
  // parent's own pagination resumes that parent from its cursor, then carries on
  // to the parents it had not reached yet — never re-requesting parent 100's
  // page 1, never skipping parent 101 entirely.
  it('[unit] Kill -9 mid-parent of a child fan-out then rerun: no duplicate lines, no gaps', async () => {
    let page2Recovered = false
    await start({
      // invoices itself is a complete `list` resource by the time invoice_messages
      // resumes, so the second run makes its own updated_since pass over it —
      // and re-reports invoice 101, the way a real account would for an invoice
      // touched since the watermark. The fan-out below still has to see two
      // parents, once each.
      '/v2/invoices': (url) => ({
        body: envelope(
          'invoices',
          url.searchParams.get('updated_since') ? [INVOICES[1]] : INVOICES,
        ),
      }),
      '/v2/invoices/{id}/messages': (url) => {
        if (userId(url) !== 100) return { body: envelope('invoice_messages', [row(1101)]) }
        if (url.searchParams.get('cursor') === 'NEXT') {
          return page2Recovered
            ? { body: envelope('invoice_messages', [row(1002)]) }
            : { status: 500, body: { message: 'boom' } }
        }
        return {
          body: envelope(
            'invoice_messages',
            [row(1001)],
            `${server?.baseUrl ?? ''}/v2/invoices/100/messages?cursor=NEXT`,
          ),
        }
      },
    })

    const err = (await extract(dir, logs).catch((e: unknown) => e)) as Error
    expect(err.message).toContain('invoice_messages')

    const midCrash = manifestOnDisk()
    expect(midCrash.resources.invoice_messages).toMatchObject({
      count: 1,
      pages: 1,
      parent_id: 100,
      complete: false,
    })
    expect(linesOnDisk('invoice_messages')).toHaveLength(1)
    // Parent 101 was never reached — the crash happened inside parent 100's own
    // pagination, before the fan-out moved on.
    expect(requestPaths()).not.toContain('/v2/invoices/101/messages')

    page2Recovered = true
    const requestsBefore = server?.requests.length ?? 0

    const result = await extract(dir, logs)
    const resumedPaths = (server?.requests ?? []).slice(requestsBefore).map((r) => r.split('?')[0])

    // Parent 100's page 1 was never re-requested; parent 101 was reached exactly once.
    expect(resumedPaths.filter((p) => p === '/v2/invoices/100/messages')).toHaveLength(1)
    expect(resumedPaths.filter((p) => p === '/v2/invoices/101/messages')).toHaveLength(1)
    expect(linesOnDisk('invoice_messages').map((l) => JSON.parse(l) as unknown)).toEqual([
      row(1001),
      row(1002),
      row(1101),
    ])
    expect(result.resources.invoice_messages).toMatchObject({ count: 3, complete: true })
    expect(manifestOnDisk().finished_at).not.toBeNull()
  })

  // A fan-out checkpoint is positional — "every invoice before this one in
  // raw/invoices.jsonl was swept" — so it only describes the invoices file it was
  // taken over. The parent is swept again from page 1 whenever it ended
  // `complete: false`, which the ordinary short-sweep path reaches on any account
  // rows are being created in, and the list that comes back can be reordered, be
  // missing the checkpointed id, or carry rows in front of it. Resuming into it
  // skipped every invoice ahead of the checkpoint, then inherited the pre-crash
  // tallies — which agree with each other — and stamped the step complete.
  it('[unit] a parent swept again from page 1 drops the fan-out checkpoint taken over it', async () => {
    let invoices = INVOICES // 100, 101
    let statedEntries = 3 // one more than the two rows served: a short sweep
    let messagesDown = true
    await start({
      '/v2/invoices': () => ({
        body: { ...envelope('invoices', invoices), total_entries: statedEntries },
      }),
      '/v2/invoices/{id}/messages': (url) =>
        userId(url) === 101 && messagesDown
          ? { status: 500, body: { message: 'boom' } }
          : { body: envelope('invoice_messages', [row(userId(url) + 1000)]) },
    })

    const err = (await extract(dir, logs).catch((e: unknown) => e)) as Error
    expect(err.message).toContain('invoice_messages')
    expect(manifestOnDisk().resources.invoice_messages).toMatchObject({
      count: 1,
      parent_id: 100,
      interrupted: true,
      complete: false,
    })
    expect(manifestOnDisk().resources.invoices.complete).toBe(false)

    // Between the runs: invoice 100 was deleted and invoice 102 created, which
    // Harvest lists first. The checkpoint now names a row the file does not hold,
    // and the row that replaced it sits in front of an invoice never swept.
    invoices = [row(102), INVOICES[1]]
    statedEntries = 2
    messagesDown = false
    const requestsBefore = server?.requests.length ?? 0

    const result = await extract(dir, logs)
    const resumed = (server?.requests ?? []).slice(requestsBefore).map((r) => r.split('?')[0])

    expect(logs.join('\n')).toContain('invoice_messages: its fan-out checkpoint (invoices 100)')
    // Every invoice in the snapshot was asked, exactly once — including the new
    // one in front of the checkpoint, which the resume used to skip.
    expect(resumed.filter((p) => p === '/v2/invoices/102/messages')).toHaveLength(1)
    expect(resumed.filter((p) => p === '/v2/invoices/101/messages')).toHaveLength(1)
    // …and the messages of the deleted invoice 100 are not in the file: children
    // of a parent this snapshot no longer holds are exactly the FK-unsafe rows
    // the fan-out order exists to prevent.
    expect(linesOnDisk('invoice_messages').map((l) => JSON.parse(l) as unknown)).toEqual([
      row(1102),
      row(1101),
    ])
    expect(result.resources.invoice_messages).toMatchObject({ count: 2, complete: true })
    expect(linesOnDisk('invoice_messages')).toHaveLength(result.resources.invoice_messages.count)
    expect(manifestOnDisk().finished_at).not.toBeNull()
  })

  // The same stale checkpoint the other way round: the checkpointed invoice is
  // still there, further down the re-swept list. Resuming skipped forward to it,
  // which swept every invoice now in front of it a second time and appended their
  // messages to a file that was never truncated. The shortfall guard cannot see it
  // — a re-swept parent adds one row *and* one total_entries tally, so `count` and
  // `total_entries` stay in lockstep.
  it('[unit] a parent re-swept in a new order does not double-sweep parents into duplicate rows', async () => {
    let invoices = [INVOICES[0], INVOICES[1], row(102)]
    let statedEntries = 4 // short, so invoices is swept again from page 1 next run
    let cursorRecovered = false
    await start({
      '/v2/invoices': () => ({
        body: { ...envelope('invoices', invoices), total_entries: statedEntries },
      }),
      '/v2/invoices/{id}/messages': (url) => {
        const id = userId(url)
        if (id !== 102) return { body: envelope('invoice_messages', [row(id + 1000)]) }
        if (url.searchParams.get('cursor') === 'PAGE2') {
          return cursorRecovered
            ? { body: envelope('invoice_messages', [row(1022)]) }
            : { status: 500, body: { message: 'boom' } }
        }
        return {
          body: envelope(
            'invoice_messages',
            [row(1021)],
            `${server?.baseUrl ?? ''}/v2/invoices/102/messages?cursor=PAGE2`,
          ),
        }
      },
    })

    const err = (await extract(dir, logs).catch((e: unknown) => e)) as Error
    expect(err.message).toContain('invoice_messages')
    expect(manifestOnDisk().resources.invoice_messages).toMatchObject({
      count: 3,
      parent_id: 102,
      interrupted: true,
    })

    // Harvest lists newest first, and the sweep that comes up short is re-run
    // whole: the same three invoices come back in a different order.
    invoices = [row(102), INVOICES[0], INVOICES[1]]
    statedEntries = 3
    cursorRecovered = true

    const result = await extract(dir, logs)

    const written = linesOnDisk('invoice_messages').map((l) => JSON.parse(l) as unknown)
    expect(written).toEqual([row(1021), row(1022), row(1100), row(1101)])
    expect(new Set(written.map((o) => (o as { id: number }).id)).size).toBe(written.length)
    expect(result.resources.invoice_messages).toMatchObject({ count: 4, complete: true })
    expect(linesOnDisk('invoice_messages')).toHaveLength(result.resources.invoice_messages.count)
    expect(manifestOnDisk().finished_at).not.toBeNull()
  })

  // The residual case the invalidation above cannot reach: a checkpoint whose
  // parent id is not in raw/<parent>.jsonl at all, over a parent file this run did
  // not rewrite (a crash between truncating the parent file and committing the
  // manifest leaves exactly this). The scan then skips every parent looking for a
  // row that is not there, issues no request, and used to inherit the dead run's
  // tallies straight into `complete: true`.
  it('[unit] a fan-out resumed at a parent the file no longer holds fails instead of finishing', async () => {
    await start({})
    await extract(dir, logs)
    expect(manifestOnDisk().finished_at).not.toBeNull()

    const seeded = manifestOnDisk()
    seeded.resources.invoice_messages = {
      ...seeded.resources.invoice_messages,
      parent_id: 999,
      next_url: null,
      interrupted: true,
      complete: false,
      finished_at: null,
    }
    await writeManifest(dir, seeded)

    const requestsBefore = server?.requests.length ?? 0
    const err = (await extract(dir, logs).catch((e: unknown) => e)) as Error
    const resumed = (server?.requests ?? []).slice(requestsBefore).map((r) => r.split('?')[0])

    expect(err.message).toContain('invoice_messages: resumed at invoices 999')
    expect(err.message).toContain('raw/invoices.jsonl does not hold')
    expect(resumed.filter((p) => /^\/v2\/invoices\/\d+\/messages$/.test(p))).toEqual([])
    // Not complete, and not resumable either: the next run sweeps it from the
    // first invoice rather than meeting the same missing checkpoint forever.
    expect(manifestOnDisk().resources.invoice_messages).toMatchObject({
      complete: false,
      interrupted: false,
      parent_id: null,
    })
    expect(manifestOnDisk().finished_at).toBeNull()

    const healed = await extract(dir, logs)
    expect(healed.resources.invoice_messages).toMatchObject({ count: 2, complete: true })
    expect(linesOnDisk('invoice_messages').map((l) => JSON.parse(l) as unknown)).toEqual([
      row(1100),
      row(1101),
    ])
    expect(manifestOnDisk().finished_at).not.toBeNull()
  })

  // `count` describes raw/<resource>.jsonl; an incremental pass writes to
  // raw/<resource>.jsonl.incoming until it merges. Counting its pages as they were
  // staged left the manifest claiming rows the file it names does not hold — a
  // crash mid-pass froze that over-claim, and the merge that normally corrects it
  // does nothing when the re-run stages nothing at all.
  it('[unit] an incremental pass never claims rows the file it describes does not hold', async () => {
    let deletedUpstream = false
    await start({
      '/v2/clients': (url) => {
        if (url.searchParams.get('cursor') === 'NEXT') {
          return { status: 500, body: { message: 'boom' } }
        }
        if (url.searchParams.get('updated_since') === null) {
          return { body: envelope('clients', [row(30)]) }
        }
        return deletedUpstream
          ? { body: envelope('clients', []) }
          : {
              body: envelope(
                'clients',
                [row(31)],
                `${server?.baseUrl ?? ''}/v2/clients?cursor=NEXT`,
              ),
            }
      },
    })

    await extract(dir, logs)
    const watermark = manifestOnDisk().updated_since.clients

    // The pass dies after its first page, which is sitting in .incoming.
    const failed = (await extract(dir, logs).catch((e: unknown) => e)) as Error
    expect(failed.message).toContain('clients')
    const crashed = manifestOnDisk().resources.clients
    expect(crashed).toMatchObject({ incremental: true, interrupted: true, complete: false })
    expect(crashed.count).toBe(linesOnDisk('clients').length)
    expect(crashed.count).toBe(1)

    // Client 31 is deleted before the re-run, so the same watermark now matches
    // nothing: the pass stages no rows and there is no merge to correct a count.
    deletedUpstream = true
    const requestsBefore = server?.requests.length ?? 0
    const result = await extract(dir, logs)
    const resumed = (server?.requests ?? [])
      .slice(requestsBefore)
      .filter((r) => r.startsWith('/v2/clients?'))

    // The pass really re-ran, on the watermark it never got past — it just had
    // nothing to stage, which is the case that leaves the merge no count to fix.
    expect(resumed).toHaveLength(1)
    expect(resumed[0]).toContain(`updated_since=${encodeURIComponent(watermark)}`)
    expect(result.resources.clients).toMatchObject({ count: 1, complete: true, incremental: true })
    expect(linesOnDisk('clients')).toHaveLength(result.resources.clients.count)
    expect(manifestOnDisk().finished_at).not.toBeNull()
  })

  // The same window one level up, and the same lie the other way round. The merge
  // commits raw/clients.jsonl with a rename and the manifest claims its length at
  // the write several statements later — a kill in between leaves the file holding
  // a merged row `count` does not know about. The re-run of the pass is the only
  // thing that could correct it, and it cannot whenever it stages nothing: the
  // merge reports no length, and the record gets stamped complete, with the
  // snapshot's finished_at over it, still under-claiming the file `load` reads.
  it('[unit] a kill between the incremental merge and the manifest is reconciled, not stamped over', async () => {
    let deletedUpstream = false
    await start({
      '/v2/clients': (url) => {
        // Cursor first: `links.next` carries the cursor and nothing else, so the
        // second page of the pass arrives without the filter that started it.
        if (url.searchParams.get('cursor') === 'C2') {
          return { status: 500, body: { message: 'boom' } }
        }
        if (url.searchParams.get('updated_since') === null) {
          return { body: envelope('clients', [row(30)]) }
        }
        if (deletedUpstream) return { body: envelope('clients', []) }
        return {
          body: envelope('clients', [row(31)], `${server?.baseUrl ?? ''}/v2/clients?cursor=C2`),
        }
      },
    })

    await extract(dir, logs)
    expect(linesOnDisk('clients')).toHaveLength(1)

    // The pass dies on its second page, its first page staged in .incoming.
    const failed = (await extract(dir, logs).catch((e: unknown) => e)) as Error
    expect(failed.message).toContain('clients')
    expect(manifestOnDisk().resources.clients).toMatchObject({
      count: 1,
      incremental: true,
      interrupted: true,
      complete: false,
    })

    // Exactly what a completed merge does to the filesystem, and nothing else:
    // the merged file in place, the staging file gone, the manifest untouched —
    // the state a kill between the rename and the manifest write leaves behind.
    await appendFile(join(dir, 'raw', 'clients.jsonl'), `${JSON.stringify(row(31))}\n`)
    await rm(join(dir, 'raw', 'clients.jsonl.incoming'), { force: true })

    // Client 31 is deleted upstream before the re-run, so the pass stages nothing
    // and there is no merged length for the record to be corrected by.
    deletedUpstream = true
    const result = await extract(dir, logs)

    // The manifest describes the file it names again: two rows on disk, two rows
    // claimed — not a snapshot stamped finished over a count one row behind it.
    expect(linesOnDisk('clients')).toHaveLength(2)
    expect(result.resources.clients).toMatchObject({ count: 2, complete: true })
    expect(manifestOnDisk().finished_at).not.toBeNull()
  })

  // A 404 parent is dealt with, not swept: the resume skips past it, so the run
  // that meets it is the only one that can record it. Tallied in a local and
  // written back after the last parent, a crash erased it — and the resumed run
  // reported full coverage of a fan-out whose children are demonstrably absent.
  it('[unit] a parent 404 recorded before a crash survives into the resumed run', async () => {
    let messagesDown = true
    await start({
      '/v2/invoices': () => ({ body: envelope('invoices', [...INVOICES, row(102)]) }),
      '/v2/invoices/{id}/messages': (url) => {
        const id = userId(url)
        if (id === 100) return { status: 404, body: { message: 'Not Found' } }
        if (id === 102 && messagesDown) return { status: 500, body: { message: 'boom' } }
        return { body: envelope('invoice_messages', [row(id + 1000)]) }
      },
    })

    const err = (await extract(dir, logs).catch((e: unknown) => e)) as Error
    expect(err.message).toContain('invoice_messages')
    expect(manifestOnDisk().resources.invoice_messages).toMatchObject({
      missing_parents: 1,
      parent_id: 101,
      interrupted: true,
    })

    messagesDown = false
    const requestsBefore = server?.requests.length ?? 0
    const result = await extract(dir, logs)
    const resumed = (server?.requests ?? []).slice(requestsBefore).map((r) => r.split('?')[0])

    // The resume picks up where it stopped — invoice 100 is not asked again — and
    // the manifest still says why its messages are missing.
    expect(resumed.filter((p) => /^\/v2\/invoices\/\d+\/messages$/.test(p))).toEqual([
      '/v2/invoices/102/messages',
    ])
    expect(result.resources.invoice_messages).toMatchObject({
      count: 2,
      missing_parents: 1,
      complete: true,
    })
    expect(manifestOnDisk().finished_at).not.toBeNull()
  })

  // Same for an optional step's refusals, whose only trace is `skipped_reason` —
  // composed after the last parent, from a tally the crash took with it. The
  // resumed run claimed teammates had been swept for every user, including the one
  // Harvest refused.
  it('[unit] an optional step refusal recorded before a crash survives into the resumed run', async () => {
    let teammatesDown = true
    await start({
      '/v2/users': () => ({ body: envelope('users', [...USERS, row(3)]) }),
      '/v2/users/{id}/teammates': (url) => {
        const id = userId(url)
        if (id === 1) return { status: 403, body: { message: 'not authorized' } }
        if (id === 3 && teammatesDown) return { status: 500, body: { message: 'boom' } }
        return { body: envelope('teammates', [row(id + 1000)]) }
      },
    })

    const err = (await extract(dir, logs).catch((e: unknown) => e)) as Error
    expect(err.message).toContain('teammates')
    expect(manifestOnDisk().resources.teammates).toMatchObject({
      refused_parents: 1,
      refused_status: 403,
      parent_id: 2,
      interrupted: true,
    })

    teammatesDown = false
    const requestsBefore = server?.requests.length ?? 0
    const result = await extract(dir, logs)
    const resumed = (server?.requests ?? []).slice(requestsBefore).map((r) => r.split('?')[0])

    expect(resumed.filter((p) => /^\/v2\/users\/\d+\/teammates$/.test(p))).toEqual([
      '/v2/users/3/teammates',
    ])
    expect(result.resources.teammates).toMatchObject({ count: 2, complete: true })
    expect(result.resources.teammates.skipped_reason).toBe(
      'Harvest returned 403 for 1 of 3 users — those teammates are not in this snapshot',
    )
    expect(manifestOnDisk().finished_at).not.toBeNull()
  })
})

/**
 * The allow-list that keeps `links.next` on the API origin inspects the URL before
 * the request goes out; a 3xx moves the request after that check, inside fetch().
 * What answered would be appended to raw/<resource>.jsonl verbatim, counted in the
 * manifest, and stamped complete — a row that never came from Harvest, in the
 * snapshot `load` consumes, described as a consistent sweep.
 */
describe('runExtract refuses a redirect off the API origin', () => {
  let elsewhere: Server | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ezacto-migrate-extract-redirect-'))
    await seedManifest(dir)
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    if (elsewhere) {
      const closing = elsewhere
      elsewhere = undefined
      closing.closeAllConnections()
      await new Promise<void>((resolve) => closing.close(() => resolve()))
    }
    await rm(dir, { recursive: true, force: true })
  })

  it('[unit] a 302 on a sweep never reaches the snapshot, and the run does not finish', async () => {
    const hits: string[] = []
    const started = createServer((req, res) => {
      hits.push(req.url ?? '')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(envelope('users', [row(999999, { email: 'attacker@evil.test' })])))
    })
    elsewhere = started
    await new Promise<void>((resolve) => started.listen(0, '127.0.0.1', resolve))
    const evil = `http://127.0.0.1:${(started.address() as AddressInfo).port}/v2/users`

    const mid: MidRun = { usersWatermarkBeforeFirstRequest: undefined, invoicePage2: undefined }
    server = await startFakeHarvest(
      listRoutes(mid, {
        '/v2/users': () => ({ status: 302, headers: { location: evil }, body: 'moved' }),
      }),
    )

    const err = (await extract(dir).catch((e: unknown) => e)) as Error

    expect(hits).toEqual([])
    expect(err.message).toContain('users: request to /v2/users failed')
    expect(err.message).toContain('refusing to follow the 302 redirect')
    // Nothing the off-origin host would have said is on disk or in the manifest.
    expect(linesOnDisk('users')).toEqual([])
    expect(manifestOnDisk().resources.users).toMatchObject({ count: 0, complete: false })
    expect(manifestOnDisk().finished_at).toBeNull()
  })
})
