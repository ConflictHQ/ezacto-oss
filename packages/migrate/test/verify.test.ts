import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeManifest, type Manifest } from '../src/manifest.js'
import { createRateLimiter } from '../src/rate-limiter.js'
import { acquireSnapshotLock, releaseSnapshotLock } from '../src/snapshot-lock.js'
import {
  REPORTS_RATE_LIMIT,
  REPORTS_RATE_WINDOW_MS,
  reportChunkKey,
  runVerify,
  snapshotDigest,
  splitReportRange,
  verifySnapshot,
} from '../src/verify.js'
import { preflight, resourceProgress } from './fixtures.js'

const row = (id: number, extra: Record<string, unknown> = {}) => ({ id, ...extra })

describe('snapshot verification', () => {
  let dir: string
  let manifest: Manifest

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ezacto-verify-'))
    await mkdir(join(dir, 'raw'))
    manifest = {
      account: { id: '42', name: 'CONFLICT' },
      company_name: 'CONFLICT',
      started_at: '2026-01-01T00:00:00.000Z',
      finished_at: '2026-01-02T00:00:00.000Z',
      tool_version: '0.0.0',
      preflight: preflight(),
      resources: {},
      updated_since: {},
    }
  })

  afterEach(async () => rm(dir, { recursive: true, force: true }))

  it('[unit] reports a dangling FK with the JSONL path and missing id', async () => {
    await writeFile(join(dir, 'raw', 'clients.jsonl'), `${JSON.stringify(row(1))}\n`)
    await writeFile(
      join(dir, 'raw', 'projects.jsonl'),
      `${JSON.stringify(row(9, { client: { id: 404 } }))}\n`,
    )
    manifest.resources.clients = resourceProgress({ count: 1 })
    manifest.resources.projects = resourceProgress({ count: 1 })
    const issues = await verifySnapshot(dir, manifest)
    expect(issues).toContainEqual(
      expect.objectContaining({
        kind: 'dangling_fk',
        path: 'raw/projects.jsonl:1.client.id',
        id: 404,
      }),
    )
  })

  it('[unit] rejects billed links and people associations whose targets are absent', async () => {
    await writeFile(join(dir, 'raw', 'users.jsonl'), `${JSON.stringify(row(1))}\n`)
    await writeFile(join(dir, 'raw', 'invoices.jsonl'), '')
    await writeFile(
      join(dir, 'raw', 'time_entries.jsonl'),
      `${JSON.stringify(row(2, { invoice: { id: 404 } }))}\n`,
    )
    await writeFile(
      join(dir, 'raw', 'expenses.jsonl'),
      `${JSON.stringify(row(3, { invoice: { id: 405 } }))}\n`,
    )
    await writeFile(
      join(dir, 'raw', 'roles.jsonl'),
      `${JSON.stringify(row(4, { user_ids: [406] }))}\n`,
    )
    await writeFile(join(dir, 'raw', 'teammates.jsonl'), `${JSON.stringify(row(407))}\n`)
    await writeFile(
      join(dir, 'raw', 'teammates.lineage.jsonl'),
      `${JSON.stringify({ source_id: 407, parent_id: 1 })}\n`,
    )
    manifest.resources.users = resourceProgress({ count: 1 })
    manifest.resources.invoices = resourceProgress({ count: 0 })
    manifest.resources.time_entries = resourceProgress({ count: 1 })
    manifest.resources.expenses = resourceProgress({ count: 1 })
    manifest.resources.roles = resourceProgress({ count: 1 })
    manifest.resources.teammates = resourceProgress({ count: 1 })

    const issues = await verifySnapshot(dir, manifest)
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'dangling_fk',
          path: 'raw/time_entries.jsonl:1.invoice.id',
          id: 404,
        }),
        expect.objectContaining({
          kind: 'dangling_fk',
          path: 'raw/expenses.jsonl:1.invoice.id',
          id: 405,
        }),
        expect.objectContaining({
          kind: 'dangling_fk',
          path: 'raw/roles.jsonl:1.user_ids[0]',
          id: 406,
        }),
        expect.objectContaining({
          kind: 'dangling_fk',
          path: 'raw/teammates.jsonl:1.id',
          id: 407,
        }),
      ]),
    )
  })

  it('[unit] rejects duplicate source identities before load can discard a row', async () => {
    await writeFile(
      join(dir, 'raw', 'clients.jsonl'),
      `${JSON.stringify(row(7, { name: 'first' }))}\n${JSON.stringify(row(7, { name: 'second' }))}\n`,
    )
    manifest.resources.clients = resourceProgress({ count: 2 })

    expect(await verifySnapshot(dir, manifest)).toContainEqual(
      expect.objectContaining({
        kind: 'invalid_row',
        path: 'raw/clients.jsonl:2.id',
        id: 7,
      }),
    )
  })

  it('[unit] compares duplicate time-entry identities from their exact number tokens', async () => {
    await writeFile(
      join(dir, 'raw', 'time_entries.jsonl'),
      '{"id":9007199254740993}\n{"id":9007199254740993}\n',
    )
    manifest.resources.time_entries = resourceProgress({ count: 2 })

    expect(await verifySnapshot(dir, manifest)).toContainEqual(
      expect.objectContaining({
        kind: 'invalid_row',
        path: 'raw/time_entries.jsonl:2.id',
        id: '9007199254740993',
      }),
    )
  })

  it('[unit] allows one teammate user under different managers but rejects a repeated pair', async () => {
    await writeFile(
      join(dir, 'raw', 'users.jsonl'),
      `${JSON.stringify(row(1))}\n${JSON.stringify(row(2))}\n${JSON.stringify(row(7))}\n`,
    )
    await writeFile(
      join(dir, 'raw', 'teammates.jsonl'),
      `${JSON.stringify(row(7))}\n${JSON.stringify(row(7))}\n`,
    )
    await writeFile(
      join(dir, 'raw', 'teammates.lineage.jsonl'),
      `${JSON.stringify({ source_id: 7, parent_id: 1 })}\n${JSON.stringify({ source_id: 7, parent_id: 2 })}\n`,
    )
    manifest.resources.users = resourceProgress({ count: 3 })
    manifest.resources.teammates = resourceProgress({ count: 2 })
    expect(await verifySnapshot(dir, manifest)).toEqual([])

    await writeFile(
      join(dir, 'raw', 'teammates.lineage.jsonl'),
      `${JSON.stringify({ source_id: 7, parent_id: 1 })}\n${JSON.stringify({ source_id: 7, parent_id: 1 })}\n`,
    )
    expect(await verifySnapshot(dir, manifest)).toContainEqual(
      expect.objectContaining({
        kind: 'invalid_row',
        path: 'raw/teammates.lineage.jsonl:2',
        id: 7,
      }),
    )
  })

  it('[unit] refuses child snapshots without aligned parent lineage', async () => {
    await writeFile(join(dir, 'raw', 'invoices.jsonl'), `${JSON.stringify(row(7))}\n`)
    await writeFile(join(dir, 'raw', 'invoice_messages.jsonl'), `${JSON.stringify(row(10))}\n`)
    manifest.resources.invoices = resourceProgress({ count: 1 })
    manifest.resources.invoice_messages = resourceProgress({ count: 1 })
    expect(await verifySnapshot(dir, manifest)).toContainEqual(
      expect.objectContaining({
        kind: 'lineage_mismatch',
        path: 'raw/invoice_messages.lineage.jsonl',
      }),
    )
  })

  it('[unit] includes child lineage in the stable snapshot digest', async () => {
    await writeFile(join(dir, 'raw', 'invoices.jsonl'), `${JSON.stringify(row(7))}\n`)
    await writeFile(join(dir, 'raw', 'invoice_messages.jsonl'), `${JSON.stringify(row(10))}\n`)
    await writeFile(
      join(dir, 'raw', 'invoice_messages.lineage.jsonl'),
      `${JSON.stringify({ source_id: 10, parent_id: 7 })}\n`,
    )
    manifest.resources.invoices = resourceProgress({ count: 1 })
    manifest.resources.invoice_messages = resourceProgress({ count: 1 })
    const first = await snapshotDigest(dir, manifest)
    await writeFile(
      join(dir, 'raw', 'invoice_messages.lineage.jsonl'),
      `${JSON.stringify({ source_id: 10, parent_id: 8 })}\n`,
    )
    expect(await snapshotDigest(dir, manifest)).not.toBe(first)
  })
})

describe('report checksums', () => {
  let dir: string
  let server: Server
  let baseUrl: string
  let requested: URL[]

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ezacto-checksums-'))
    requested = []
    await mkdir(join(dir, 'raw'))
    await writeFile(
      join(dir, 'raw', 'time_entries.jsonl'),
      `${JSON.stringify(row(1, { spent_date: '2026-01-02' }))}\n`,
    )
    await writeFile(join(dir, 'raw', 'expenses.jsonl'), '')
    await writeManifest(dir, {
      account: { id: '42', name: 'CONFLICT' },
      company_name: 'CONFLICT',
      started_at: '2026-01-01T00:00:00.000Z',
      finished_at: '2026-01-02T00:00:00.000Z',
      tool_version: '0.0.0',
      preflight: preflight(),
      resources: { time_entries: resourceProgress({ count: 1 }) },
      updated_since: {},
    })
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      requested.push(url)
      const results =
        url.pathname === '/v2/reports/time/clients'
          ? [
              { client_id: 7, currency: 'USD', total_hours: 1 },
              { client_id: 7, currency: 'EUR', total_hours: 2 },
            ]
          : []
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ results, total_entries: results.length, links: { next: null } }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  })

  it('[api] preserves one checksum row per currency for a multi-currency client', async () => {
    const result = await runVerify({
      env: { pat: 'p', accountId: '42', userAgentEmail: 'e@example.com' },
      snapshotDir: dir,
      baseUrl,
      now: () => new Date('2026-12-31T00:00:00.000Z'),
    })
    expect(result.checksums.reports['time/clients/2026']).toEqual([
      expect.objectContaining({ client_id: 7, currency: 'USD' }),
      expect.objectContaining({ client_id: 7, currency: 'EUR' }),
    ])
    expect(JSON.parse(await readFile(join(dir, 'checksums.json'), 'utf8'))).toEqual(
      result.checksums,
    )
    const next = await acquireSnapshotLock(dir, 'extract')
    await releaseSnapshotLock(next)
  })

  it('[unit] splits inclusive report ranges at the 365-day Harvest boundary', () => {
    const ordinary = splitReportRange({ from: '2023-01-01', to: '2023-12-31' })
    expect(ordinary).toEqual([{ from: '2023-01-01', to: '2023-12-31' }])
    expect(reportChunkKey('time/clients/2023', ordinary[0]!, ordinary.length)).toBe(
      'time/clients/2023',
    )

    const leap = splitReportRange({ from: '2024-01-01', to: '2024-12-31' })
    expect(leap).toEqual([
      { from: '2024-01-01', to: '2024-12-30' },
      { from: '2024-12-31', to: '2024-12-31' },
    ])
    expect(reportChunkKey('time/clients/2024', leap[0]!, leap.length)).toBe(
      'time/clients/2024/2024-01-01..2024-12-30',
    )
  })

  it('[api] requests a leap year in capped chunks and records deterministic keys', async () => {
    await writeFile(
      join(dir, 'raw', 'time_entries.jsonl'),
      `${JSON.stringify(row(1, { spent_date: '2024-01-01' }))}\n`,
    )
    const result = await runVerify({
      env: { pat: 'p', accountId: '42', userAgentEmail: 'e@example.com' },
      snapshotDir: dir,
      baseUrl,
      now: () => new Date('2024-12-31T00:00:00.000Z'),
    })

    expect(
      requested
        .filter((url) => url.pathname === '/v2/reports/time/clients')
        .map((url) => ({ from: url.searchParams.get('from'), to: url.searchParams.get('to') })),
    ).toEqual([
      { from: '2024-01-01', to: '2024-12-30' },
      { from: '2024-12-31', to: '2024-12-31' },
    ])
    expect(Object.keys(result.checksums.reports)).toEqual(
      expect.arrayContaining([
        'time/clients/2024/2024-01-01..2024-12-30',
        'time/clients/2024/2024-12-31..2024-12-31',
      ]),
    )
    expect(result.checksums.reports['time/clients/2024']).toBeUndefined()
  })

  it('[unit] refuses verify while another snapshot owner is live', async () => {
    const owner = await acquireSnapshotLock(dir, 'extract')
    try {
      await expect(
        runVerify({
          env: { pat: 'p', accountId: '42', userAgentEmail: 'e@example.com' },
          snapshotDir: dir,
          baseUrl,
        }),
      ).rejects.toThrow('snapshot is locked by extract')
    } finally {
      await releaseSnapshotLock(owner)
    }
  })

  it('[unit] releases the snapshot lock when report collection fails', async () => {
    await expect(
      runVerify({
        env: { pat: 'p', accountId: '42', userAgentEmail: 'e@example.com' },
        snapshotDir: dir,
        baseUrl: 'not-a-url',
      }),
    ).rejects.toThrow()
    const next = await acquireSnapshotLock(dir, 'reconcile')
    await releaseSnapshotLock(next)
  })

  it('[unit] reports limiter never grants more than 100 calls in any 15-minute window', async () => {
    let clock = 0
    const grants: number[] = []
    const limiter = createRateLimiter({
      limit: REPORTS_RATE_LIMIT,
      windowMs: REPORTS_RATE_WINDOW_MS,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
    })
    for (let index = 0; index < 205; index += 1) {
      await limiter.acquire()
      grants.push(clock)
    }
    for (const at of grants) {
      expect(
        grants.filter((grant) => grant >= at && grant < at + REPORTS_RATE_WINDOW_MS).length,
      ).toBeLessThanOrEqual(REPORTS_RATE_LIMIT)
    }
  })
})
