import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runExtract } from '../src/extract.js'
import { readManifest, writeManifest } from '../src/manifest.js'
import { runSync, syncExitCode, type SyncResult } from '../src/sync.js'
import { envelope, startFakeHarvest, type FakeHarvest, type RouteHandler } from './harvest-server.js'
import { ADMIN_USER, preflight } from './fixtures.js'

const row = (id: number): Record<string, unknown> => ({
  id,
  name: `row ${id}`,
  created_at: '2026-01-01T00:00:00Z',
})

const env = { pat: 'p', accountId: '42', userAgentEmail: 'sync@test.invalid' }

let upstreamHasUser2 = true
let upstreamHasRole20 = true
let upstreamHasInvoiceMessage = true
let shortUsersWitness = false
let server: FakeHarvest
let dir: string

const list = (
  collection: string,
  ids: readonly number[],
  url: URL,
): { body: Record<string, unknown> } => ({
  body: envelope(collection, url.searchParams.has('updated_since') ? [] : ids.map(row)),
})

/** A complete, feature-reduced Harvest account whose one user can disappear. */
const routes = (): Record<string, RouteHandler> => ({
  '/v2/users/me': () => ({ body: ADMIN_USER }),
  '/v2/users': (url) => {
    const reply = list('users', upstreamHasUser2 ? [1, 2] : [1], url)
    if (shortUsersWitness && !url.searchParams.has('updated_since')) reply.body.total_entries = 2
    return reply
  },
  '/v2/users/{id}/billable_rates': (url) => {
    const id = Number(url.pathname.split('/')[3])
    return upstreamHasUser2 || id !== 2
      ? { body: envelope('billable_rates', [row(id * 10)]) }
      : { status: 404, body: { message: 'gone' } }
  },
  '/v2/users/{id}/cost_rates': (url) => {
    const id = Number(url.pathname.split('/')[3])
    return upstreamHasUser2 || id !== 2
      ? { body: envelope('cost_rates', [row(id * 100)]) }
      : { status: 404, body: { message: 'gone' } }
  },
  '/v2/users/{id}/teammates': () => ({ status: 403, body: { message: 'disabled' } }),
  '/v2/roles': (url) => list('roles', upstreamHasRole20 ? [20] : [], url),
  '/v2/clients': (url) => list('clients', [30], url),
  '/v2/contacts': (url) => list('contacts', [40], url),
  '/v2/tasks': (url) => list('tasks', [50], url),
  '/v2/expense_categories': (url) => list('expense_categories', [60], url),
  '/v2/invoice_item_categories': (url) => list('invoice_item_categories', [70], url),
  '/v2/projects': (url) => list('projects', [80], url),
  '/v2/task_assignments': (url) =>
    list('task_assignments', [url.searchParams.get('is_active') === 'false' ? 91 : 90], url),
  '/v2/user_assignments': (url) =>
    list('user_assignments', [url.searchParams.get('is_active') === 'false' ? 96 : 95], url),
  '/v2/invoices': (url) => list('invoices', [100], url),
  '/v2/invoices/{id}/messages': () => ({
    body: envelope('invoice_messages', upstreamHasInvoiceMessage ? [row(1100)] : []),
  }),
  '/v2/invoices/{id}/payments': () => ({ body: envelope('invoice_payments', [row(2100)]) }),
  '/v2/time_entries': (url) => list('time_entries', [500], url),
  '/v2/expenses': (url) => list('expenses', [600], url),
})

const clock = (): (() => Date) => {
  let ms = Date.parse('2026-08-26T00:00:00.000Z')
  return () => new Date((ms += 1_000))
}

const run = (): Promise<SyncResult> =>
  runSync({
    env,
    snapshotDir: dir,
    baseUrl: server.baseUrl,
    timeoutMs: 5_000,
    now: clock(),
    log: () => undefined,
    sleep: () => Promise.resolve(),
  })

describe('runSync', () => {
  beforeEach(async () => {
    upstreamHasUser2 = true
    upstreamHasRole20 = true
    upstreamHasInvoiceMessage = true
    shortUsersWitness = false
    dir = await mkdtemp(join(tmpdir(), 'ezacto-migrate-sync-'))
    server = await startFakeHarvest(routes())
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
    await runExtract({
      env,
      snapshotDir: dir,
      baseUrl: server.baseUrl,
      timeoutMs: 5_000,
      now: clock(),
      log: () => undefined,
      sleep: () => Promise.resolve(),
    })
  })

  afterEach(async () => {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('[unit] marks a vanished upstream ID only after a complete full-ID witness, retaining raw rows', async () => {
    upstreamHasUser2 = false

    const result = await run()
    const manifest = await readManifest(dir)

    expect(result.deleted).toBeGreaterThan(0)
    expect(manifest.deleted_upstream?.users).toEqual([2])
    expect(manifest.full_id_sweeps?.users).toMatchObject({ seen_count: 1, total_entries: 1 })
    expect(
      (await readFile(join(dir, 'raw', 'users.jsonl'), 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line).id),
    ).toEqual([1, 2])
  })

  it('[unit] makes a second unchanged sync a zero deletion/domain delta, then clears a reappearing ID mark', async () => {
    upstreamHasUser2 = false
    await run()
    const first = await readManifest(dir)

    const second = await run()
    const afterSecond = await readManifest(dir)
    expect(second.deleted).toBe(0)
    expect(second.restored).toBe(0)
    expect(afterSecond.deleted_upstream).toEqual(first.deleted_upstream)
    // A new witness timestamp is metadata, not a domain change, so byte equality
    // is intentionally not the idempotency definition.
    expect(afterSecond.full_id_sweeps?.users.completed_at).toBeDefined()

    upstreamHasUser2 = true
    const restored = await run()
    expect(restored.restored).toBeGreaterThan(0)
    expect((await readManifest(dir)).deleted_upstream?.users).toBeUndefined()
  })

  it('[unit] never publishes a deletion decision from a short full-ID witness', async () => {
    upstreamHasUser2 = false
    upstreamHasRole20 = false
    upstreamHasInvoiceMessage = false
    shortUsersWitness = true

    await expect(run()).rejects.toThrow('users: full-ID sweep saw 1 distinct id(s), but Harvest reported 2')
    const manifest = await readManifest(dir)
    expect(manifest.deleted_upstream?.users).toBeUndefined()
    expect(manifest.full_id_sweeps?.users).toBeUndefined()
    // `roles` and `invoice_messages` have already been replaced by extract by
    // the time users' malformed witness is found. Their original raw rows are
    // restored before any witness runs, not discarded in cleanup.
    expect((await readFile(join(dir, 'raw', 'roles.jsonl'), 'utf8')).trim()).toContain('"id":20')
    expect((await readFile(join(dir, 'raw', 'invoice_messages.jsonl'), 'utf8')).trim()).toContain(
      '"id":1100',
    )
  })

  it('[unit] retains and marks vanished child and no-updated-since rows after extract replaces them', async () => {
    upstreamHasRole20 = false
    upstreamHasInvoiceMessage = false

    await run()
    const manifest = await readManifest(dir)
    expect(manifest.deleted_upstream?.roles).toEqual([20])
    expect(manifest.deleted_upstream?.invoice_messages).toEqual([1100])
    expect((await readFile(join(dir, 'raw', 'roles.jsonl'), 'utf8')).trim()).toContain('"id":20')
    expect((await readFile(join(dir, 'raw', 'invoice_messages.jsonl'), 'utf8')).trim()).toContain(
      '"id":1100',
    )
  })

  it('[unit] reports teammate deletion detection as incomplete because raw rows lack manager context', async () => {
    const result = await run()

    expect(result.complete).toBe(false)
    expect(result.unwitnessed.teammates).toContain('(manager_id, teammate_id)')
    expect(syncExitCode(result)).toBe(1)
    expect((await readManifest(dir)).deleted_upstream?.teammates).toBeUndefined()
  })

  it('[unit] rejects a concurrent sync before it can make a request or replace raw rows', async () => {
    const before = server.requests.length
    await mkdir(join(dir, '.sync.lock'))

    await expect(run()).rejects.toThrow(`sync already running for ${dir}`)
    expect(server.requests).toHaveLength(before)
    expect((await readFile(join(dir, 'raw', 'roles.jsonl'), 'utf8')).trim()).toContain('"id":20')
  })
})
