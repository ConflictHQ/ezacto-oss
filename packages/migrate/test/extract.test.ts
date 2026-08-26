// AC #1 behavioural half (account-wide assignment sweeps including is_active=false)
// and, deterministically, the snapshot/manifest mechanics AC #3 asserts on live
// data — so a regression is caught in milliseconds without credentials, and the
// live run is left to prove only the thing a fake server cannot: that the real
// account's shape matches what we assumed.

import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
import { preflight } from './fixtures.js'

const row = (id: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  name: `row ${id}`,
  created_at: '2026-01-01T00:00:00Z',
  ...extra,
})

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

const listRoutes = (mid: MidRun): Record<string, RouteHandler> => ({
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
    await writeManifest(dir, {
      account: { id: '42', name: 'CONFLICT' },
      company_name: 'CONFLICT',
      started_at: '2026-08-26T00:00:00.000Z',
      finished_at: null,
      tool_version: '0.0.0',
      preflight: preflight({ estimate_feature: false }),
      resources: {},
      updated_since: {},
    })

    result = await runExtract({
      env: { pat: 'p', accountId: '42', userAgentEmail: 'e@x.com' },
      snapshotDir: dir,
      baseUrl: server.baseUrl,
      timeoutMs: 5_000,
      now: tickingClock(),
      log: (line) => logs.push(line),
      sleep: () => Promise.resolve(),
    })
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

  it('[unit] the updated_since watermark is captured before the first request, not after', async () => {
    const manifest = manifestOnDisk()
    expect(mid.usersWatermarkBeforeFirstRequest).toBeDefined()
    expect(manifest.updated_since.users).toBe(mid.usersWatermarkBeforeFirstRequest)
    // …and strictly before the step finished, so a row edited mid-sweep is re-read.
    expect(Date.parse(manifest.updated_since.users)).toBeLessThan(
      Date.parse(manifest.resources.users.finished_at as string),
    )
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

  it('[unit] a 403 on the optional teammates step records a skip and the run continues', () => {
    const teammates = result.resources.teammates as ManifestResource
    expect(teammates.skipped_reason).toContain('403')
    expect(teammates.complete).toBe(true)
    // The refusal still cost a request; the cost record must not read as free.
    expect(teammates.requests).toBe(1)
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

  it('[unit] a re-run replaces rows rather than appending a second copy of the account', async () => {
    await runExtract({
      env: { pat: 'p', accountId: '42', userAgentEmail: 'e@x.com' },
      snapshotDir: dir,
      baseUrl: server?.baseUrl,
      timeoutMs: 5_000,
      now: tickingClock(),
      log: () => {},
      sleep: () => Promise.resolve(),
    })

    // Not four. Appending onto a populated snapshot would double every count in
    // the manifest and every row a later `load` reads.
    expect(linesOnDisk('users').map((l) => JSON.parse(l) as unknown)).toEqual(USERS)
    expect(manifestOnDisk().resources.users.count).toBe(2)
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
