import { mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  archiveInvoicePdfs,
  createInvoicePdfThrottle,
  readInvoicePdfInputs,
  sanitizePriorInvoicePdfArchive,
  type ArchiveInvoicePdfsOptions,
  type InvoicePdfArchive,
  type InvoicePdfInput,
} from '../src/invoice-pdfs.js'

const PDF = new TextEncoder().encode('%PDF-1.7\ninvoice')
const pdfResponse = (): Response =>
  new Response(PDF, { status: 200, headers: { 'content-type': 'application/pdf' } })
const archive = (options: ArchiveInvoicePdfsOptions) =>
  archiveInvoicePdfs({ expectedFullDomain: 'example.harvestapp.com', ...options })

describe('invoice PDF archive', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ezacto-invoice-pdfs-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('[unit] stores verified PDFs by content hash and reports the current archive count', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(pdfResponse())
    const result = await archive({
      snapshotDir: dir,
      baseUri: 'https://example.harvestapp.com/',
      invoices: [{ id: 7, client_key: 'client-secret' }],
      fetchImpl,
      throttle: () => Promise.resolve(),
    })

    expect(fetchImpl).toHaveBeenCalledWith(
      new URL('https://example.harvestapp.com/client/invoices/client-secret.pdf'),
      expect.objectContaining({ redirect: 'manual' }),
    )
    expect(result.records['7'].path).toMatch(/^invoice-pdfs\/[a-f0-9]{64}\.pdf$/)
    expect(await readFile(join(dir, result.records['7'].path))).toEqual(Buffer.from(PDF))
    expect(result.summary).toEqual({
      total: 1,
      archived: 1,
      skipped: 0,
      failed: 0,
      unarchivable: 0,
    })
  })

  it('[unit] refuses every non-account production origin without sending or exposing the key', async () => {
    const key = 'origin-scope-bearer-secret'
    const cases: Array<{ baseUri: string; expectedFullDomain?: string }> = [
      { baseUri: 'https://attacker.example' },
      { baseUri: 'https://example.harvestapp.com.attacker.example' },
      { baseUri: 'http://example.harvestapp.com' },
      { baseUri: 'https://example.harvestapp.com:8443' },
      { baseUri: 'https://example.harvestapp.com/account' },
      { baseUri: 'https://example.harvestapp.com?redirect=attacker.example' },
      { baseUri: 'https://example.harvestapp.com#fragment' },
      { baseUri: 'https://user@example.harvestapp.com' },
      {
        baseUri: 'https://different.harvestapp.com',
        expectedFullDomain: 'example.harvestapp.com',
      },
    ]

    for (const candidate of cases) {
      const logs: string[] = []
      const fetchImpl = vi.fn<typeof fetch>()
      const result = await archive({
        snapshotDir: dir,
        baseUri: candidate.baseUri,
        ...(candidate.expectedFullDomain
          ? { expectedFullDomain: candidate.expectedFullDomain }
          : {}),
        invoices: [{ id: 7, client_key: key }],
        fetchImpl,
        throttle: () => Promise.resolve(),
        log: (line) => logs.push(line),
      })

      expect(fetchImpl, candidate.baseUri).not.toHaveBeenCalled()
      expect(result.anomalies).toEqual([{ invoice_id: 7, reason: 'invalid_base_uri' }])
      expect(`${JSON.stringify(result)}\n${logs.join('\n')}`).not.toContain(key)
    }

    const noDomainFetch = vi.fn<typeof fetch>()
    await archiveInvoicePdfs({
      snapshotDir: dir,
      baseUri: 'https://example.harvestapp.com',
      invoices: [{ id: 7, client_key: key }],
      fetchImpl: noDomainFetch,
      throttle: () => Promise.resolve(),
    })
    expect(noDomainFetch).not.toHaveBeenCalled()
  })

  it('[unit] permits only an explicitly supplied loopback test origin', async () => {
    const baseUri = 'http://127.0.0.1:43117'
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(pdfResponse())
    const result = await archiveInvoicePdfs({
      snapshotDir: dir,
      baseUri,
      testBaseUri: baseUri,
      invoices: [{ id: 7, client_key: 'loopback-only-key' }],
      fetchImpl,
      throttle: () => Promise.resolve(),
    })

    expect(result.summary.archived).toBe(1)
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL(`${baseUri}/client/invoices/loopback-only-key.pdf`),
      expect.objectContaining({ redirect: 'manual' }),
    )
  })

  it('[unit] rejects non-200 and non-PDF responses and never stores them', async () => {
    const html = new Response('<html>not found</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })
    const falsePdf = new Response('<html>not a PDF</html>', {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
    })
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(html)
      .mockResolvedValueOnce(falsePdf)
      .mockResolvedValueOnce(new Response(null, { status: 404 }))

    const result = await archive({
      snapshotDir: dir,
      baseUri: 'https://example.harvestapp.com',
      invoices: [
        { id: 1, client_key: 'first-secret' },
        { id: 2, client_key: 'second-secret' },
        { id: 3, client_key: 'third-secret' },
      ],
      fetchImpl,
      throttle: () => Promise.resolve(),
    })

    expect(result.records).toEqual({})
    expect(result.anomalies).toEqual([
      { invoice_id: 1, reason: 'wrong_content_type' },
      { invoice_id: 2, reason: 'invalid_pdf' },
      { invoice_id: 3, reason: 'http_status' },
    ])
    expect(result.summary.archived).toBe(0)
  })

  it('[unit] never exposes client keys in archive results, logs, or caught transport errors', async () => {
    const key = 'known-bearer-secret'
    const logs: string[] = []
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error(`request failed for ${key}`))
    const result = await archive({
      snapshotDir: dir,
      baseUri: 'https://example.harvestapp.com',
      invoices: [
        { id: 2, client_key: null },
        { id: 1, client_key: key },
      ],
      fetchImpl,
      throttle: () => Promise.resolve(),
      log: (line) => logs.push(line),
    })

    const serialized = `${JSON.stringify(result)}\n${logs.join('\n')}`
    expect(serialized).not.toContain(key)
    expect(serialized).not.toContain('not a URI')
    expect(result.anomalies).toEqual([
      { invoice_id: 2, reason: 'missing_client_key' },
      { invoice_id: 1, reason: 'download_failed' },
    ])
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    const invalidBase = await archive({
      snapshotDir: dir,
      baseUri: 'not a URI',
      invoices: [{ id: 3, client_key: key }],
      fetchImpl,
      throttle: () => Promise.resolve(),
      log: (line) => logs.push(line),
    })
    expect(`${JSON.stringify(invalidBase)}\n${logs.join('\n')}`).not.toContain(key)
    expect(invalidBase.anomalies).toEqual([{ invoice_id: 3, reason: 'invalid_base_uri' }])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('[unit] uses only its own request throttle', async () => {
    const throttle = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(pdfResponse())
    await archive({
      snapshotDir: dir,
      baseUri: 'https://example.harvestapp.com',
      invoices: [
        { id: 1, client_key: 'one' },
        { id: 2, client_key: 'two' },
      ],
      fetchImpl,
      throttle,
    })

    expect(throttle).toHaveBeenCalledTimes(2)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('[unit] spaces grants from the actual prior grant when a sleep overshoots', async () => {
    let now = 0
    let firstSleep = true
    const throttle = createInvoicePdfThrottle({
      minimumDelayMs: 250,
      now: () => now,
      sleep: (ms) => {
        now += ms + (firstSleep ? 100 : 0)
        firstSleep = false
        return Promise.resolve()
      },
    })
    const grants: number[] = []
    for (let index = 0; index < 3; index += 1) {
      await throttle()
      grants.push(now)
    }

    expect(grants).toEqual([0, 350, 600])
  })

  it('[unit] starts the network timeout after its independent throttle grants a slot', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      if (init?.signal?.aborted) return Promise.reject(new Error('already aborted'))
      return Promise.resolve(pdfResponse())
    })
    const result = await archive({
      snapshotDir: dir,
      baseUri: 'https://example.harvestapp.com',
      invoices: [{ id: 1, client_key: 'one' }],
      timeoutMs: 1,
      fetchImpl,
      throttle: () => new Promise<void>((resolve) => setTimeout(resolve, 10)),
    })

    expect(result.summary.archived).toBe(1)
    expect(result.anomalies).toEqual([])
  })

  it('[unit] skips present successes but retries failed and missing archives', async () => {
    const invoices: InvoicePdfInput[] = [
      { id: 1, client_key: 'one' },
      { id: 2, client_key: 'two' },
    ]
    const firstFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(pdfResponse())
      .mockRejectedValueOnce(new Error('temporary failure for two'))
    const first = await archive({
      snapshotDir: dir,
      baseUri: 'https://example.harvestapp.com',
      invoices,
      fetchImpl: firstFetch,
      throttle: () => Promise.resolve(),
    })
    expect(first.summary.archived).toBe(1)

    const retryFetch = vi.fn<typeof fetch>().mockResolvedValue(pdfResponse())
    const second = await archive({
      snapshotDir: dir,
      baseUri: 'https://example.harvestapp.com',
      invoices,
      prior: first,
      fetchImpl: retryFetch,
      throttle: () => Promise.resolve(),
    })
    expect(retryFetch).toHaveBeenCalledTimes(1)
    expect(second.summary).toEqual({
      total: 2,
      archived: 2,
      skipped: 1,
      failed: 0,
      unarchivable: 0,
    })

    const checkpointedRecords: string[][] = []
    const unchangedFetch = vi.fn<typeof fetch>()
    await archive({
      snapshotDir: dir,
      baseUri: 'https://example.harvestapp.com',
      invoices,
      prior: second,
      fetchImpl: unchangedFetch,
      throttle: () => Promise.resolve(),
      onProgress: (archive) => {
        checkpointedRecords.push(Object.keys(archive.records).sort())
        return Promise.resolve()
      },
    })
    expect(unchangedFetch).not.toHaveBeenCalled()
    expect(checkpointedRecords).toEqual([
      ['1', '2'],
      ['1', '2'],
    ])

    await unlink(join(dir, second.records['1'].path))
    const missingFetch = vi.fn<typeof fetch>().mockResolvedValue(pdfResponse())
    const third = await archive({
      snapshotDir: dir,
      baseUri: 'https://example.harvestapp.com',
      invoices,
      prior: second,
      fetchImpl: missingFetch,
      throttle: () => Promise.resolve(),
    })
    expect(missingFetch).toHaveBeenCalledTimes(1)
    expect(third.summary.archived).toBe(2)
    expect(third.summary.skipped).toBe(1)

    await writeFile(join(dir, third.records['2'].path), '%PDF-corrupt-after-prefix')
    const corruptFetch = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(pdfResponse()))
    const fourth = await archive({
      snapshotDir: dir,
      baseUri: 'https://example.harvestapp.com',
      invoices,
      prior: third,
      fetchImpl: corruptFetch,
      throttle: () => Promise.resolve(),
    })
    // Both fixture invoices share one content-addressed object. Repairing it for
    // the first record makes the second record valid without another request.
    expect(corruptFetch).toHaveBeenCalledTimes(1)
    expect(fourth.summary.archived).toBe(2)

    const traversal = structuredClone(fourth)
    traversal.records['1'].path = '../outside.pdf'
    const traversalFetch = vi.fn<typeof fetch>().mockResolvedValue(pdfResponse())
    const fifth = await archive({
      snapshotDir: dir,
      baseUri: 'https://example.harvestapp.com',
      invoices,
      prior: traversal,
      fetchImpl: traversalFetch,
      throttle: () => Promise.resolve(),
    })
    expect(traversalFetch).toHaveBeenCalledTimes(1)
    expect(fifth.records['1'].path).toMatch(/^invoice-pdfs\/[a-f0-9]{64}\.pdf$/)

    const preserved = await archive({
      snapshotDir: dir,
      baseUri: 'https://example.harvestapp.com',
      invoices: [],
      prior: fifth,
      fetchImpl: vi.fn<typeof fetch>(),
    })
    expect(preserved.records).toEqual(fifth.records)
    expect(preserved.summary).toMatchObject({ total: 0, archived: 0 })
  })

  it('[unit] retains only verified historical records outside the current input set', async () => {
    const sourceKey = 'must-not-escape-retained-record'
    const current = await archive({
      snapshotDir: dir,
      baseUri: 'https://example.harvestapp.com',
      invoices: [
        { id: 1, client_key: 'one' },
        { id: 2, client_key: 'two' },
      ],
      fetchImpl: vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(pdfResponse())),
      throttle: () => Promise.resolve(),
    })
    const prior = structuredClone(current)
    const runtimeRecords = prior.records as Record<string, unknown>
    const firstRuntimeRecord = runtimeRecords['1'] as Record<string, unknown>
    firstRuntimeRecord.client_key = sourceKey
    prior.records['1'].path = `invoice-pdfs\\${prior.records['1'].sha256}.pdf`
    prior.records['2'].path = `../${sourceKey}.pdf`

    const corruptSha = 'a'.repeat(64)
    const corruptBytes = Buffer.from('%PDF-corrupt-retained-object')
    await writeFile(join(dir, 'invoice-pdfs', `${corruptSha}.pdf`), corruptBytes)
    prior.records['3'] = {
      source_id: 3,
      sha256: corruptSha,
      path: `invoice-pdfs/${corruptSha}.pdf`,
      bytes: corruptBytes.byteLength,
      content_type: 'application/pdf',
    }
    prior.records['4'] = {
      ...prior.records['1'],
      source_id: 4,
      content_type: sourceKey,
    }
    runtimeRecords['5'] = null
    runtimeRecords['6'] = 'not an object'
    runtimeRecords['7'] = []

    const logs: string[] = []
    const retained = await archive({
      snapshotDir: dir,
      baseUri: 'https://example.harvestapp.com',
      invoices: [],
      prior,
      fetchImpl: vi.fn<typeof fetch>(),
      log: (line) => logs.push(line),
    })

    expect(retained.records).toEqual({ '1': current.records['1'] })
    expect(retained.summary).toMatchObject({ total: 0, archived: 0 })
    expect(`${JSON.stringify(retained)}\n${logs.join('\n')}`).not.toContain(sourceKey)

    const malformedMap = await archive({
      snapshotDir: dir,
      baseUri: 'https://example.harvestapp.com',
      invoices: [],
      prior: { ...prior, records: null } as unknown as InvoicePdfArchive,
      fetchImpl: vi.fn<typeof fetch>(),
    })
    expect(malformedMap.records).toEqual({})
  })

  it('[unit] sanitizes, deduplicates, and reconciles retained invoice outcomes', async () => {
    const secret = 'retained-invoice-secret'
    const current = await archive({
      snapshotDir: dir,
      baseUri: 'https://example.harvestapp.com',
      invoices: [
        { id: 1, client_key: 'one' },
        { id: 2, client_key: 'two' },
      ],
      fetchImpl: vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(pdfResponse())),
      throttle: () => Promise.resolve(),
    })
    const raw = structuredClone(current) as unknown as Record<string, unknown>
    const records = raw.records as Record<string, Record<string, unknown>>
    records['1'].client_key = secret
    raw.anomalies = [
      { invoice_id: 1, reason: 'download_failed', client_key: secret },
      { invoice_id: 3, reason: 'missing_client_key' },
      { invoice_id: 3, reason: 'download_failed' },
      { invoice_id: 4, reason: 'download_failed' },
      { invoice_id: 5, reason: secret },
    ]
    raw.summary = {
      total: 999,
      archived: 999,
      skipped: 999,
      failed: 999,
      unarchivable: 999,
      client_key: secret,
    }

    const safe = await sanitizePriorInvoicePdfArchive(dir, raw)

    expect(safe?.records).toEqual(current.records)
    expect(safe?.anomalies).toEqual([
      { invoice_id: 3, reason: 'missing_client_key' },
      { invoice_id: 4, reason: 'download_failed' },
    ])
    expect(safe?.summary).toEqual({
      total: 4,
      archived: 2,
      skipped: 0,
      failed: 1,
      unarchivable: 1,
    })
    expect(JSON.stringify(safe)).not.toContain(secret)
  })

  it('[unit] rejects a symlinked retained PDF even when its target has valid bytes', async () => {
    const current = await archive({
      snapshotDir: dir,
      baseUri: 'https://example.harvestapp.com',
      invoices: [{ id: 1, client_key: 'one' }],
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(pdfResponse()),
      throttle: () => Promise.resolve(),
    })
    const archivedPath = join(dir, current.records['1'].path)
    const outsidePath = join(dir, 'outside-archive.pdf')
    await writeFile(outsidePath, PDF)
    await unlink(archivedPath)
    try {
      await symlink(outsidePath, archivedPath, 'file')
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        return
      }
      throw error
    }

    const retained = await archive({
      snapshotDir: dir,
      baseUri: 'https://example.harvestapp.com',
      invoices: [],
      prior: current,
      fetchImpl: vi.fn<typeof fetch>(),
    })
    expect(retained.records).toEqual({})
  })

  it('[unit] refuses to store through a symlinked archive root', async () => {
    const outsideRoot = join(dir, 'outside-archive-root')
    await mkdir(outsideRoot)
    try {
      await symlink(outsideRoot, join(dir, 'invoice-pdfs'), 'dir')
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        return
      }
      throw error
    }

    const result = await archive({
      snapshotDir: dir,
      baseUri: 'https://example.harvestapp.com',
      invoices: [{ id: 1, client_key: 'one' }],
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(pdfResponse()),
      throttle: () => Promise.resolve(),
    })

    expect(result.records).toEqual({})
    expect(result.anomalies).toEqual([{ invoice_id: 1, reason: 'archive_write_failed' }])
    expect(await readdir(outsideRoot)).toEqual([])
  })

  it('[unit] checkpoints a secret-free outcome after every invoice', async () => {
    const checkpoints: number[] = []
    const result = await archive({
      snapshotDir: dir,
      baseUri: 'https://example.harvestapp.com',
      invoices: [
        { id: 1, client_key: 'one' },
        { id: 2, client_key: null },
      ],
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(pdfResponse()),
      throttle: () => Promise.resolve(),
      onProgress: (archive) => {
        checkpoints.push(archive.summary.archived + archive.anomalies.length)
        return Promise.resolve()
      },
    })

    expect(checkpoints).toEqual([1, 2])
    expect(result.summary).toMatchObject({ archived: 1, unarchivable: 1 })
  })

  it('[unit] reads only id and client_key and keeps validation errors secret-safe', async () => {
    const key = 'reader-bearer-secret'
    await mkdir(join(dir, 'raw'))
    await writeFile(
      join(dir, 'raw', 'invoices.jsonl'),
      `${JSON.stringify({ id: 7, client_key: key, number: 'INV-7', nested: { ignored: true } })}\n`,
    )
    expect(await readInvoicePdfInputs(dir)).toEqual([{ id: 7, client_key: key }])

    await writeFile(
      join(dir, 'raw', 'invoices.jsonl'),
      `${JSON.stringify({ id: 7, client_key: { secret: key } })}\n`,
    )
    let error: unknown
    try {
      await readInvoicePdfInputs(dir)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('invalid invoice PDF input at line 1: invalid_client_key')
    expect((error as Error).message).not.toContain(key)

    await writeFile(
      join(dir, 'raw', 'invoices.jsonl'),
      `${JSON.stringify({ id: 7, client_key: key })}\n${JSON.stringify({ id: 7, client_key: 'other' })}\n`,
    )
    await expect(readInvoicePdfInputs(dir)).rejects.toThrow('duplicate_invoice_id')

    await rm(join(dir, 'raw', 'invoices.jsonl'))
    await expect(readInvoicePdfInputs(dir)).rejects.toThrow('raw/invoices.jsonl is missing')
  })
})
