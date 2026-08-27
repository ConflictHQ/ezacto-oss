import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  archiveInvoicePdfs,
  readInvoicePdfInputs,
  type InvoicePdfInput,
} from '../src/invoice-pdfs.js'

const PDF = new TextEncoder().encode('%PDF-1.7\ninvoice')
const pdfResponse = (): Response =>
  new Response(PDF, { status: 200, headers: { 'content-type': 'application/pdf' } })

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
    const result = await archiveInvoicePdfs({
      snapshotDir: dir,
      baseUri: 'https://example.harvestapp.com/',
      invoices: [{ id: 7, client_key: 'client-secret' }],
      fetchImpl,
      throttle: () => Promise.resolve(),
    })

    expect(fetchImpl).toHaveBeenCalledWith(
      new URL('https://example.harvestapp.com/client/invoices/client-secret.pdf'),
      expect.objectContaining({ redirect: 'follow' }),
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

    const result = await archiveInvoicePdfs({
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
    const result = await archiveInvoicePdfs({
      snapshotDir: dir,
      baseUri: 'https://example.harvestapp.com',
      invoices: [
        { id: 1, client_key: key },
        { id: 2, client_key: null },
      ],
      fetchImpl,
      throttle: () => Promise.resolve(),
      log: (line) => logs.push(line),
    })

    const serialized = `${JSON.stringify(result)}\n${logs.join('\n')}`
    expect(serialized).not.toContain(key)
    expect(serialized).not.toContain('not a URI')
    expect(result.anomalies).toEqual([
      { invoice_id: 1, reason: 'download_failed' },
      { invoice_id: 2, reason: 'missing_client_key' },
    ])
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    const invalidBase = await archiveInvoicePdfs({
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
    await archiveInvoicePdfs({
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

  it('[unit] skips present successes but retries failed and missing archives', async () => {
    const invoices: InvoicePdfInput[] = [
      { id: 1, client_key: 'one' },
      { id: 2, client_key: 'two' },
    ]
    const firstFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(pdfResponse())
      .mockRejectedValueOnce(new Error('temporary failure for two'))
    const first = await archiveInvoicePdfs({
      snapshotDir: dir,
      baseUri: 'https://example.harvestapp.com',
      invoices,
      fetchImpl: firstFetch,
      throttle: () => Promise.resolve(),
    })
    expect(first.summary.archived).toBe(1)

    const retryFetch = vi.fn<typeof fetch>().mockResolvedValue(pdfResponse())
    const second = await archiveInvoicePdfs({
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

    await unlink(join(dir, second.records['1'].path))
    const missingFetch = vi.fn<typeof fetch>().mockResolvedValue(pdfResponse())
    const third = await archiveInvoicePdfs({
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
  })
})
