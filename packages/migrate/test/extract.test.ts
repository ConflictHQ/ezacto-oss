// AC #1 behavioural half (account-wide assignment sweeps including is_active=false)
// and, deterministically, the snapshot/manifest mechanics AC #3 asserts on live
// data — so a regression is caught in milliseconds without credentials, and the
// live run is left to prove only the thing a fake server cannot: that the real
// account's shape matches what we assumed.

import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
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
import { ADMIN_USER, preflight } from './fixtures.js'

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

  it('[unit] a re-run replaces rows rather than appending a second copy of the account', async () => {
    await extract(dir)

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

  // manifest.finished_at is the completeness signal every consumer keys on, and
  // startResource truncates a resource's raw file at the start of its step: a
  // re-run that dies must not leave the previous run's stamp over an empty file.
  it('[unit] a re-run that dies mid-sweep clears the finished_at of the run before it', async () => {
    await start({})
    await extract(dir)
    expect(manifestOnDisk().finished_at).not.toBeNull()
    expect(linesOnDisk('roles')).toHaveLength(1)

    await server?.close()
    await start({ '/v2/roles': () => ({ status: 500, body: { message: 'boom' } }) })
    const err = (await extract(dir, logs).catch((e: unknown) => e)) as Error

    expect(err.message).toContain('roles')
    const manifest = manifestOnDisk()
    expect(manifest.finished_at).toBeNull()
    expect(manifest.resources.roles).toMatchObject({ count: 0, complete: false })
    // The old rows are gone — which is exactly why the manifest must not say finished.
    expect(readFileSync(join(dir, 'raw', 'roles.jsonl'), 'utf8')).toBe('')
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

  // The CLI called extract "resumable" and every failure message said "re-run to
  // continue". Nothing reads manifest.resources[*].next_url back, and startResource
  // truncates each raw file at the top of its step — so "continue" named a command
  // that begins by deleting the rows the sentence promised were safe.
  it('[unit] a failed run says a re-run re-sweeps from page 1, and a re-run does exactly that', async () => {
    await start({
      '/v2/expenses': (_url, hit) =>
        hit === 1
          ? { status: 422, body: { message: 'Unprocessable' } }
          : { body: envelope('expenses', [row(600)]) },
    })

    const err = (await extract(dir, logs).catch((e: unknown) => e)) as Error
    expect(err.message).toContain('does not yet resume mid-resource')
    expect(err.message).toContain('re-sweeps every resource from page 1')

    const afterFirstRun = server?.requests.length ?? 0
    await extract(dir, logs)
    const second = (server?.requests ?? []).slice(afterFirstRun).map((r) => r.split('?')[0])

    // A run that had resumed would have issued one request. This is the whole
    // account again, from the top — which is what the message now promises.
    expect(second[0]).toBe('/v2/users/me')
    expect(second).toContain('/v2/users')
    expect(second.length).toBeGreaterThan(10)
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
