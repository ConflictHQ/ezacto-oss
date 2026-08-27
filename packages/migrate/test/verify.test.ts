import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeManifest, type Manifest } from '../src/manifest.js'
import { createRateLimiter } from '../src/rate-limiter.js'
import {
  REPORTS_RATE_LIMIT,
  REPORTS_RATE_WINDOW_MS,
  runVerify,
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
})

describe('report checksums', () => {
  let dir: string
  let server: Server
  let baseUrl: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ezacto-checksums-'))
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
      const results = url.pathname === '/v2/reports/time/clients'
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
      expect(grants.filter((grant) => grant >= at && grant < at + REPORTS_RATE_WINDOW_MS).length)
        .toBeLessThanOrEqual(REPORTS_RATE_LIMIT)
    }
  })
})
