import { createHash } from 'node:crypto'
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

export interface InvoicePdfInput {
  id: number
  client_key: string | null
}

export interface InvoicePdfRecord {
  source_id: number
  sha256: string
  path: string
  bytes: number
  content_type: string
}

export type InvoicePdfAnomalyReason =
  | 'missing_client_key'
  | 'invalid_base_uri'
  | 'http_status'
  | 'wrong_content_type'
  | 'invalid_pdf'
  | 'download_failed'
  | 'archive_write_failed'

export interface InvoicePdfAnomaly {
  invoice_id: number
  reason: InvoicePdfAnomalyReason
}

export interface InvoicePdfArchiveSummary {
  /** Number of invoice rows supplied for this sweep. */
  total: number
  /** Number of requested invoices with a verified, present PDF after this sweep. */
  archived: number
  /** Number of already-successful PDFs that did not need a request in this sweep. */
  skipped: number
  /** Network, response-validation, or storage failures in this sweep. */
  failed: number
  /** Invoices that cannot be fetched because Harvest supplied no client key. */
  unarchivable: number
}

export interface InvoicePdfArchive {
  records: Record<string, InvoicePdfRecord>
  anomalies: InvoicePdfAnomaly[]
  summary: InvoicePdfArchiveSummary
}

export type InvoicePdfThrottle = () => Promise<void>

export interface CreateInvoicePdfThrottleOptions {
  minimumDelayMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface ArchiveInvoicePdfsOptions {
  snapshotDir: string
  baseUri: string
  invoices: InvoicePdfInput[]
  prior?: InvoicePdfArchive
  timeoutMs?: number
  fetchImpl?: typeof fetch
  throttle?: InvoicePdfThrottle
  log?: (line: string) => void
}

const PDF_PREFIX = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MINIMUM_DELAY_MS = 250

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const isPdf = (bytes: Uint8Array): boolean =>
  bytes.length >= PDF_PREFIX.length && PDF_PREFIX.every((byte, index) => bytes[index] === byte)

const normalizedBaseUri = (value: string): URL | null => {
  try {
    const base = new URL(value)
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) return null
    base.hash = ''
    base.search = ''
    base.pathname = base.pathname.replace(/\/+$/, '')
    return base
  } catch {
    return null
  }
}

const invoicePdfUrl = (base: URL, clientKey: string): URL => {
  const target = new URL(base)
  const prefix = base.pathname === '/' ? '' : base.pathname
  target.pathname = `${prefix}/client/invoices/${encodeURIComponent(clientKey)}.pdf`
  return target
}

const validationError = (line: number, reason: string): Error =>
  new Error(`invalid invoice PDF input at line ${line}: ${reason}`)

/**
 * Reads only the two fields needed by the web-surface archive. JSON parser
 * messages and source rows are deliberately discarded because client_key is a
 * bearer secret that must never escape into a diagnostic.
 */
export const readInvoicePdfInputs = async (snapshotDir: string): Promise<InvoicePdfInput[]> => {
  let raw: string
  try {
    raw = await readFile(join(snapshotDir, 'raw', 'invoices.jsonl'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  const inputs: InvoicePdfInput[] = []
  const lines = raw.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(lines[index]) as unknown
    } catch {
      throw validationError(index + 1, 'invalid_json')
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw validationError(index + 1, 'invalid_record')
    }
    const record = parsed as Record<string, unknown>
    if (!Number.isSafeInteger(record.id)) {
      throw validationError(index + 1, 'invalid_invoice_id')
    }
    if (
      record.client_key !== undefined &&
      record.client_key !== null &&
      typeof record.client_key !== 'string'
    ) {
      throw validationError(index + 1, 'invalid_client_key')
    }
    inputs.push({
      id: record.id as number,
      client_key: (record.client_key as string | null | undefined) ?? null,
    })
  }
  return inputs
}

/**
 * A deliberately separate throttle for Harvest's undocumented client-facing
 * invoice surface. It shares no state with the API request budget.
 */
export const createInvoicePdfThrottle = (
  options: CreateInvoicePdfThrottleOptions = {},
): InvoicePdfThrottle => {
  const minimumDelayMs = options.minimumDelayMs ?? DEFAULT_MINIMUM_DELAY_MS
  if (!Number.isFinite(minimumDelayMs) || minimumDelayMs < 0) {
    throw new Error('invoice PDF throttle delay must be a non-negative number')
  }
  const now = options.now ?? Date.now
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let nextRequestAt = 0

  return async () => {
    const at = now()
    const delay = Math.max(nextRequestAt - at, 0)
    if (delay > 0) await sleep(delay)
    nextRequestAt = Math.max(nextRequestAt, at) + minimumDelayMs
  }
}

const storePdf = async (
  snapshotDir: string,
  invoiceId: number,
  bytes: Uint8Array,
): Promise<InvoicePdfRecord> => {
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const directory = join(snapshotDir, 'invoice-pdfs')
  const destination = join(directory, `${sha256}.pdf`)
  await mkdir(directory, { recursive: true })
  if (!(await exists(destination))) {
    const temporary = `${destination}.tmp-${process.pid}-${invoiceId}`
    await writeFile(temporary, bytes)
    await rename(temporary, destination).catch(async (error: unknown) => {
      await rm(temporary, { force: true })
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    })
  }
  return {
    source_id: invoiceId,
    sha256,
    path: relative(snapshotDir, destination),
    bytes: bytes.byteLength,
    content_type: 'application/pdf',
  }
}

/**
 * Archives the invoice renderings exactly as clients received them. The
 * client_key exists only long enough to construct a request URL; outcomes use
 * stable reason enums so fetch errors can never leak that bearer secret.
 */
export const archiveInvoicePdfs = async (
  options: ArchiveInvoicePdfsOptions,
): Promise<InvoicePdfArchive> => {
  const fetchImpl = options.fetchImpl ?? fetch
  const throttle = options.throttle ?? createInvoicePdfThrottle()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const log = options.log ?? (() => undefined)
  const base = normalizedBaseUri(options.baseUri)
  const requestedIds = new Set(options.invoices.map((invoice) => String(invoice.id)))
  const records: Record<string, InvoicePdfRecord> = {}
  for (const [id, record] of Object.entries(options.prior?.records ?? {})) {
    if (requestedIds.has(id)) records[id] = record
  }
  const anomalies: InvoicePdfAnomaly[] = []
  let skipped = 0
  let unarchivable = 0

  const recordAnomaly = (invoiceId: number, reason: InvoicePdfAnomalyReason): void => {
    anomalies.push({ invoice_id: invoiceId, reason })
    log(`WARNING: invoice ${invoiceId} PDF archive failed — ${reason}`)
  }

  for (const invoice of options.invoices) {
    const id = String(invoice.id)
    const previous = records[id]
    if (previous && (await exists(join(options.snapshotDir, previous.path)))) {
      skipped += 1
      continue
    }
    delete records[id]

    if (!invoice.client_key) {
      unarchivable += 1
      recordAnomaly(invoice.id, 'missing_client_key')
      continue
    }
    if (!base) {
      recordAnomaly(invoice.id, 'invalid_base_uri')
      continue
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      await throttle()
      response = await fetchImpl(invoicePdfUrl(base, invoice.client_key), {
        redirect: 'follow',
        signal: controller.signal,
      })
    } catch {
      recordAnomaly(invoice.id, 'download_failed')
      clearTimeout(timer)
      continue
    }

    try {
      if (response.status !== 200) {
        recordAnomaly(invoice.id, 'http_status')
        continue
      }
      const contentType = response.headers.get('content-type')
      if (!contentType?.toLowerCase().startsWith('application/pdf')) {
        recordAnomaly(invoice.id, 'wrong_content_type')
        continue
      }
      let bytes: Uint8Array
      try {
        bytes = new Uint8Array(await response.arrayBuffer())
      } catch {
        recordAnomaly(invoice.id, 'download_failed')
        continue
      }
      if (!isPdf(bytes)) {
        recordAnomaly(invoice.id, 'invalid_pdf')
        continue
      }
      try {
        records[id] = await storePdf(options.snapshotDir, invoice.id, bytes)
      } catch {
        recordAnomaly(invoice.id, 'archive_write_failed')
      }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    records,
    anomalies,
    summary: {
      total: options.invoices.length,
      archived: Object.keys(records).length,
      skipped,
      failed: anomalies.length - unarchivable,
      unarchivable,
    },
  }
}
