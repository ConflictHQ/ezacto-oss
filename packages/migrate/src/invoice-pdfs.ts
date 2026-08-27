import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

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
  /** Account-domain witness captured from Harvest's authenticated company response. */
  expectedFullDomain?: string
  /** Explicit loopback-only seam. Production callers must never derive this from manifest data. */
  testBaseUri?: string
  invoices: InvoicePdfInput[]
  prior?: InvoicePdfArchive
  timeoutMs?: number
  fetchImpl?: typeof fetch
  throttle?: InvoicePdfThrottle
  log?: (line: string) => void
  /** Checkpoint-safe archive state after each invoice outcome. */
  onProgress?: (archive: InvoicePdfArchive) => Promise<void>
}

const PDF_PREFIX = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MINIMUM_DELAY_MS = 250

const isPdf = (bytes: Uint8Array): boolean =>
  bytes.length >= PDF_PREFIX.length && PDF_PREFIX.every((byte, index) => bytes[index] === byte)

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

const isStrictDescendant = (root: string, candidate: string): boolean => {
  const fromRoot = relative(root, candidate)
  return (
    fromRoot !== '' &&
    fromRoot !== '..' &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  )
}

const archiveRoot = async (snapshotDir: string, create: boolean): Promise<string | null> => {
  try {
    const snapshotRoot = await realpath(snapshotDir)
    const archivePath = resolve(snapshotRoot, 'invoice-pdfs')
    if (create) await mkdir(archivePath, { recursive: true })
    const archiveStat = await lstat(archivePath)
    if (!archiveStat.isDirectory() || archiveStat.isSymbolicLink()) return null
    const resolvedArchive = await realpath(archivePath)
    return isStrictDescendant(snapshotRoot, resolvedArchive) ? resolvedArchive : null
  } catch {
    return null
  }
}

const validatedPriorRecord = async (
  snapshotDir: string,
  invoiceId: number,
  value: unknown,
): Promise<InvoicePdfRecord | null> => {
  if (!isPlainObject(value)) return null
  if (value.source_id !== invoiceId || typeof value.sha256 !== 'string') return null
  const sha256 = value.sha256
  if (!/^[a-f0-9]{64}$/.test(sha256)) return null
  const posixPath = `invoice-pdfs/${sha256}.pdf`
  const windowsPath = `invoice-pdfs\\${sha256}.pdf`
  if (value.path !== posixPath && value.path !== windowsPath) return null
  if (!Number.isSafeInteger(value.bytes) || (value.bytes as number) < PDF_PREFIX.length) return null
  if (value.content_type !== 'application/pdf') return null
  try {
    const root = await archiveRoot(snapshotDir, false)
    if (!root) return null
    // The manifest path is only a format witness. The validated digest derives
    // the path we inspect, so neither slash style can steer filesystem access.
    const candidate = resolve(root, `${sha256}.pdf`)
    if (!isStrictDescendant(root, candidate)) return null
    const fileStat = await lstat(candidate)
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) return null
    const resolvedCandidate = await realpath(candidate)
    if (!isStrictDescendant(root, resolvedCandidate)) return null
    const bytes = new Uint8Array(await readFile(resolvedCandidate))
    if (
      bytes.byteLength !== value.bytes ||
      !isPdf(bytes) ||
      createHash('sha256').update(bytes).digest('hex') !== sha256
    ) {
      return null
    }
    // Rebuild from validated scalars. Unknown input fields (including a
    // reflected client_key) can never survive into a manifest checkpoint.
    return {
      source_id: invoiceId,
      sha256,
      path: posixPath,
      bytes: value.bytes as number,
      content_type: 'application/pdf',
    }
  } catch {
    return null
  }
}

const OFFICIAL_ACCOUNT_DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.harvestapp\.com$/i

const strictOrigin = (value: string): URL | null => {
  try {
    if (value !== value.trim() || value.includes('?') || value.includes('#')) return null
    const base = new URL(value)
    if (base.username || base.password || base.pathname !== '/' || base.search || base.hash) return null
    return base
  } catch {
    return null
  }
}

const isLoopback = (hostname: string): boolean =>
  ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(hostname)

const normalizedBaseUri = (
  value: string,
  expectedFullDomain: string | undefined,
  testBaseUri: string | undefined,
): URL | null => {
  const base = strictOrigin(value)
  if (!base) return null

  // The fake-server route exists only when the caller explicitly supplies the
  // same loopback origin as a test seam. A value read from manifest.json cannot
  // opt itself into this branch.
  if (testBaseUri !== undefined) {
    const testBase = strictOrigin(testBaseUri)
    if (
      testBase &&
      ['http:', 'https:'].includes(testBase.protocol) &&
      isLoopback(testBase.hostname) &&
      base.origin === testBase.origin
    ) {
      return base
    }
  }

  if (
    base.protocol !== 'https:' ||
    base.port ||
    !OFFICIAL_ACCOUNT_DOMAIN.test(base.hostname) ||
    typeof expectedFullDomain !== 'string' ||
    !OFFICIAL_ACCOUNT_DOMAIN.test(expectedFullDomain) ||
    base.hostname !== expectedFullDomain.toLowerCase()
  ) {
    return null
  }
  return base
}

const INVOICE_ANOMALY_REASONS = new Set<InvoicePdfAnomalyReason>([
  'missing_client_key',
  'invalid_base_uri',
  'http_status',
  'wrong_content_type',
  'invalid_pdf',
  'download_failed',
  'archive_write_failed',
])

const safePriorAnomaly = (raw: unknown): InvoicePdfAnomaly | null => {
  if (!isPlainObject(raw)) return null
  if (!Number.isSafeInteger(raw.invoice_id) || typeof raw.reason !== 'string') return null
  if (!INVOICE_ANOMALY_REASONS.has(raw.reason as InvoicePdfAnomalyReason)) return null
  return {
    invoice_id: raw.invoice_id as number,
    reason: raw.reason as InvoicePdfAnomalyReason,
  }
}

const safePriorSummary = (
  raw: unknown,
  anomalies: InvoicePdfAnomaly[],
  records: Record<string, InvoicePdfRecord>,
): InvoicePdfArchiveSummary => {
  const unarchivable = anomalies.filter((item) => item.reason === 'missing_client_key').length
  const failed = anomalies.length - unarchivable
  if (isPlainObject(raw)) {
    const values = ['total', 'archived', 'skipped', 'failed', 'unarchivable'] as const
    if (values.every((key) => Number.isSafeInteger(raw[key]) && (raw[key] as number) >= 0)) {
      const summary = raw as unknown as InvoicePdfArchiveSummary
      if (
        summary.archived <= summary.total &&
        summary.skipped <= summary.archived &&
        summary.archived <= Object.keys(records).length &&
        summary.archived + anomalies.length === summary.total
      ) {
        return {
          total: summary.total,
          archived: summary.archived,
          skipped: summary.skipped,
          failed,
          unarchivable,
        }
      }
    }
  }
  return {
    total: Object.keys(records).length + anomalies.length,
    archived: Object.keys(records).length,
    skipped: 0,
    failed,
    unarchivable,
  }
}

/**
 * Rebuilds a prior invoice index exclusively from verified on-disk objects and
 * stable scalar outcomes. It never issues a request and never reserializes an
 * unknown runtime field.
 */
export const sanitizePriorInvoicePdfArchive = async (
  snapshotDir: string,
  raw: unknown,
): Promise<InvoicePdfArchive | undefined> => {
  if (!isPlainObject(raw)) return undefined
  try {
    const records: Record<string, InvoicePdfRecord> = {}
    const priorRecords = isPlainObject(raw.records) ? raw.records : {}
    for (const [id, candidate] of Object.entries(priorRecords)) {
      const invoiceId = Number(id)
      if (!Number.isSafeInteger(invoiceId) || String(invoiceId) !== id) continue
      const validated = await validatedPriorRecord(snapshotDir, invoiceId, candidate)
      if (validated) records[id] = validated
    }
    const anomalies: InvoicePdfAnomaly[] = []
    const anomalyIds = new Set<number>()
    if (Array.isArray(raw.anomalies)) {
      for (const candidate of raw.anomalies) {
        const safe = safePriorAnomaly(candidate)
        if (
          safe &&
          records[String(safe.invoice_id)] === undefined &&
          !anomalyIds.has(safe.invoice_id)
        ) {
          anomalyIds.add(safe.invoice_id)
          anomalies.push(safe)
        }
      }
    }
    return {
      records,
      anomalies,
      summary: safePriorSummary(raw.summary, anomalies, records),
    }
  } catch {
    return undefined
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
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        'raw/invoices.jsonl is missing — extract cannot prove which invoice PDFs belong in this snapshot',
      )
    }
    throw error
  }

  const inputs: InvoicePdfInput[] = []
  const ids = new Set<number>()
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
    if (ids.has(record.id as number)) {
      throw validationError(index + 1, 'duplicate_invoice_id')
    }
    ids.add(record.id as number)
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
    // Sleep may overshoot. Anchor the next slot to the actual grant time, not
    // the stale pre-sleep clock, or the following request can bunch up behind it.
    nextRequestAt = Math.max(nextRequestAt, now()) + minimumDelayMs
  }
}

const storePdf = async (
  snapshotDir: string,
  invoiceId: number,
  bytes: Uint8Array,
): Promise<InvoicePdfRecord> => {
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const root = await archiveRoot(snapshotDir, true)
  if (!root) throw new Error('invoice PDF archive root is not a safe directory')
  const destination = resolve(root, `${sha256}.pdf`)
  if (!isStrictDescendant(root, destination)) {
    throw new Error('invoice PDF destination escapes the archive root')
  }
  const manifestPath = `invoice-pdfs/${sha256}.pdf`
  let alreadyStored = false
  try {
    const destinationStat = await lstat(destination)
    if (!destinationStat.isFile() || destinationStat.isSymbolicLink()) {
      throw new Error('invoice PDF destination is not a regular file')
    }
    const resolvedDestination = await realpath(destination)
    if (!isStrictDescendant(root, resolvedDestination)) {
      throw new Error('invoice PDF destination escapes the archive root')
    }
    alreadyStored = Buffer.from(await readFile(resolvedDestination)).equals(Buffer.from(bytes))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (!alreadyStored) {
    const temporary = resolve(root, `.${sha256}.tmp-${process.pid}-${invoiceId}-${randomUUID()}`)
    if (!isStrictDescendant(root, temporary)) {
      throw new Error('invoice PDF temporary path escapes the archive root')
    }
    await writeFile(temporary, bytes, { flag: 'wx' })
    await rename(temporary, destination).catch(async (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        await rm(temporary, { force: true })
        throw error
      }
      // Windows does not replace an existing destination with rename. The
      // temporary file is fully written before this fallback removes a corrupt
      // object, so the next operation restores the canonical hash path.
      await rm(destination, { force: true })
      await rename(temporary, destination)
    })
  }
  return {
    source_id: invoiceId,
    sha256,
    // Snapshot manifests use `/` on every host so a copied archive remains
    // valid when it moves between POSIX and Windows.
    path: manifestPath,
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
  const base = normalizedBaseUri(
    options.baseUri,
    options.expectedFullDomain,
    options.testBaseUri,
  )
  const requestedIds = new Set<string>()
  for (const invoice of options.invoices) {
    const id = String(invoice.id)
    if (requestedIds.has(id)) {
      throw new Error(`invoice PDF input contains duplicate invoice id ${id}`)
    }
    requestedIds.add(id)
  }
  // Keep valid records outside the current input set. A temporarily-disabled
  // invoice feature must not orphan an already-built archive, but historical
  // records are still untrusted manifest input: never reserialize a stale path,
  // mismatched id, corrupt object, or reflected content type just because its
  // invoice is not part of this sweep.
  const records: Record<string, InvoicePdfRecord> = {}
  const pendingCurrentRecords: Record<string, unknown> = {}
  const priorRecords = isPlainObject(options.prior?.records) ? options.prior.records : {}
  for (const [id, record] of Object.entries(priorRecords)) {
    const invoiceId = Number(id)
    if (!Number.isSafeInteger(invoiceId) || String(invoiceId) !== id) continue
    // Validate every retained record before the first progress checkpoint.
    // Otherwise checkpointing invoice one would either reserialize an untrusted
    // future record or drop every not-yet-visited success, making a crash retry
    // fetch the rest of a previously complete archive again.
    const validated = await validatedPriorRecord(options.snapshotDir, invoiceId, record)
    if (validated) {
      records[id] = validated
    } else if (requestedIds.has(id)) {
      // Do not serialize an invalid record, but let a later invoice revalidate
      // it: two invoices can share one content-addressed object, and repairing
      // the first can make the second record valid without another request.
      pendingCurrentRecords[id] = record
    }
  }
  const anomalies: InvoicePdfAnomaly[] = []
  let skipped = 0
  let unarchivable = 0

  const recordAnomaly = (invoiceId: number, reason: InvoicePdfAnomalyReason): void => {
    anomalies.push({ invoice_id: invoiceId, reason })
    log(`WARNING: invoice ${invoiceId} PDF archive failed — ${reason}`)
  }

  const current = (): InvoicePdfArchive => ({
    records: { ...records },
    anomalies: [...anomalies],
    summary: {
      total: options.invoices.length,
      archived: [...requestedIds].filter((id) => records[id] !== undefined).length,
      skipped,
      failed: anomalies.length - unarchivable,
      unarchivable,
    },
  })
  const checkpoint = async (): Promise<void> => {
    if (options.onProgress) await options.onProgress(current())
  }

  for (const invoice of options.invoices) {
    const id = String(invoice.id)
    let previous = records[id]
    const pending = pendingCurrentRecords[id]
    const validated = await validatedPriorRecord(options.snapshotDir, invoice.id, pending)
    if (!previous && validated) {
      records[id] = validated
      previous = validated
    }
    if (previous) {
      skipped += 1
      await checkpoint()
      continue
    }
    delete records[id]

    if (!invoice.client_key) {
      unarchivable += 1
      recordAnomaly(invoice.id, 'missing_client_key')
      await checkpoint()
      continue
    }
    if (!base) {
      recordAnomaly(invoice.id, 'invalid_base_uri')
      await checkpoint()
      continue
    }

    // Waiting for our own courtesy throttle is not network time. Start the
    // request/body timeout only after a slot has been granted, otherwise a
    // deliberately slow sweep can hand fetch an already-aborted signal.
    try {
      await throttle()
    } catch {
      recordAnomaly(invoice.id, 'download_failed')
      await checkpoint()
      continue
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await fetchImpl(invoicePdfUrl(base, invoice.client_key), {
        // The client key is a bearer secret in the path. Do not allow a
        // response to redirect that key to another origin.
        redirect: 'manual',
        signal: controller.signal,
      })
    } catch {
      recordAnomaly(invoice.id, 'download_failed')
      clearTimeout(timer)
      await checkpoint()
      continue
    }

    try {
      if (response.status !== 200) {
        recordAnomaly(invoice.id, 'http_status')
        await checkpoint()
        continue
      }
      const contentType = response.headers.get('content-type')
      if (contentType?.split(';', 1)[0].trim().toLowerCase() !== 'application/pdf') {
        recordAnomaly(invoice.id, 'wrong_content_type')
        await checkpoint()
        continue
      }
      let bytes: Uint8Array
      try {
        bytes = new Uint8Array(await response.arrayBuffer())
      } catch {
        recordAnomaly(invoice.id, 'download_failed')
        await checkpoint()
        continue
      }
      if (!isPdf(bytes)) {
        recordAnomaly(invoice.id, 'invalid_pdf')
        await checkpoint()
        continue
      }
      try {
        records[id] = await storePdf(options.snapshotDir, invoice.id, bytes)
      } catch {
        recordAnomaly(invoice.id, 'archive_write_failed')
      }
      await checkpoint()
    } finally {
      clearTimeout(timer)
    }
  }

  return current()
}
