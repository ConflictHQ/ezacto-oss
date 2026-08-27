import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type {
  ManifestBinaries,
  ManifestBinaryAnomaly,
  ManifestBinaryAnomalyReason,
  ManifestBinaryAsset,
} from './manifest.js'

interface ReceiptRecord {
  id: number
  receipt?: { url?: string; file_name?: string; file_size?: number; content_type?: string } | null
}

interface UserRecord {
  id: number
  avatar_url?: string | null
}

export interface DownloadBinariesOptions {
  snapshotDir: string
  prior?: ManifestBinaries
  timeoutMs?: number
  fetchImpl?: typeof fetch
  log?: (line: string) => void
  /** Persist a secret-free archive checkpoint after every receipt/avatar outcome. */
  onProgress?: (binaries: ManifestBinaries) => Promise<void>
  /** PAT headers permitted only on this exact Harvest account-web origin. */
  webAuth?: {
    origin: string
    pat: string
    accountId: string
    userAgentEmail: string
  }
  /**
   * Unit-test-only seam: permit webAuth on this exact loopback origin when an
   * injected fetch implementation is also present. It can never authorize an
   * external or production origin, and runExtract does not expose or set it.
   */
  testWebAuthOrigin?: string
}

type BinaryRequestFailureReason = 'request_failed' | 'http_status' | 'redirect_refused'

class BinaryRequestFailure extends Error {
  constructor(readonly reason: BinaryRequestFailureReason) {
    super(reason)
  }
}

interface ReceiptWebAuth {
  origin: string
  headers: Record<string, string>
}

const parsedUrl = (value: string): URL | null => {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

const officialHarvestAccountOrigin = (value: string): string | null => {
  const url = parsedUrl(value)
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.port) return null
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.harvestapp\.com$/i.test(url.hostname)) return null
  return url.origin
}

const loopbackTestOrigin = (value: string | undefined, fetchInjected: boolean): string | null => {
  if (!fetchInjected || value === undefined) return null
  const url = parsedUrl(value)
  if (!url || url.username || url.password) return null
  if (!['http:', 'https:'].includes(url.protocol)) return null
  if (!['127.0.0.1', '::1', '[::1]', 'localhost'].includes(url.hostname)) return null
  return url.origin
}

const receiptWebAuth = (options: DownloadBinariesOptions): ReceiptWebAuth | undefined => {
  const configured = options.webAuth
  if (!configured) return undefined
  const configuredUrl = parsedUrl(configured.origin)
  if (!configuredUrl) return undefined
  const trustedOrigin =
    officialHarvestAccountOrigin(configured.origin) ??
    (() => {
      const testOrigin = loopbackTestOrigin(
        options.testWebAuthOrigin,
        options.fetchImpl !== undefined,
      )
      return testOrigin === configuredUrl.origin ? testOrigin : null
    })()
  if (!trustedOrigin) return undefined
  return {
    origin: trustedOrigin,
    headers: {
      Authorization: `Bearer ${configured.pat}`,
      'Harvest-Account-Id': configured.accountId,
      'User-Agent': `ezacto-migrate (${configured.userAgentEmail})`,
    },
  }
}

const jsonl = async <T>(path: string): Promise<T[]> => {
  try {
    const raw = await readFile(path, 'utf8')
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

const safeExtension = (fileName: string | undefined): string => {
  const ext = extname(fileName ?? '').toLowerCase()
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : ''
}

const canonicalContentType = (value: unknown): string | null | undefined => {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') return undefined
  const type = value.split(';', 1)[0].trim().toLowerCase()
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type) ? type : undefined
}

const canonicalAssetPath = (
  resource: 'receipt' | 'avatar',
  sha256: string,
  extension?: string,
): string => (resource === 'receipt' ? `receipts/${sha256}${extension ?? ''}` : `avatars/${sha256}`)

const validPriorAsset = async (
  snapshotDir: string,
  resource: 'receipt' | 'avatar',
  sourceId: number,
  raw: unknown,
  expectedExtension?: string,
  expectedContentType?: string,
): Promise<ManifestBinaryAsset | null> => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  if (record.source_id !== sourceId) return null
  if (typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256)) return null
  if (!Number.isSafeInteger(record.bytes) || (record.bytes as number) < 0) return null
  const contentType = canonicalContentType(record.content_type)
  if (contentType === undefined) return null
  const expectedType = canonicalContentType(expectedContentType)
  if (expectedType && contentType !== expectedType) return null

  const canonical =
    expectedExtension === undefined
      ? resource === 'receipt'
        ? new RegExp(`^receipts/${record.sha256}(?:\\.[a-z0-9]{1,10})?$`).test(String(record.path))
        : record.path === canonicalAssetPath(resource, record.sha256)
      : record.path === canonicalAssetPath(resource, record.sha256, expectedExtension)
  if (!canonical) return null

  try {
    const bytes = new Uint8Array(await readFile(join(snapshotDir, record.path as string)))
    if (bytes.byteLength !== record.bytes) return null
    if (createHash('sha256').update(bytes).digest('hex') !== record.sha256) return null
  } catch {
    return null
  }
  return {
    source_id: sourceId,
    sha256: record.sha256,
    path: record.path as string,
    bytes: record.bytes as number,
    content_type: contentType,
  }
}

const safePriorAnomaly = (raw: unknown): ManifestBinaryAnomaly | null => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const anomaly = raw as Record<string, unknown>
  if (!['download_failed', 'size_mismatch', 'invalid_record'].includes(String(anomaly.kind))) {
    return null
  }
  if (!['receipt', 'avatar'].includes(String(anomaly.resource))) return null
  if (anomaly.source_id !== null && !Number.isSafeInteger(anomaly.source_id)) return null
  const kind = anomaly.kind as ManifestBinaryAnomaly['kind']
  const allowedDownloadReasons = new Set<ManifestBinaryAnomalyReason>([
    'request_failed',
    'http_status',
    'redirect_refused',
    'archive_write_failed',
  ])
  const message: ManifestBinaryAnomalyReason =
    kind === 'size_mismatch'
      ? 'size_mismatch'
      : kind === 'invalid_record'
        ? 'invalid_record'
        : allowedDownloadReasons.has(anomaly.message as ManifestBinaryAnomalyReason)
          ? (anomaly.message as ManifestBinaryAnomalyReason)
          : 'request_failed'
  return {
    kind,
    resource: anomaly.resource as ManifestBinaryAnomaly['resource'],
    source_id: anomaly.source_id as number | null,
    message,
  }
}

const fetchBytes = async (
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  webAuth: ReceiptWebAuth | undefined,
): Promise<{ bytes: Uint8Array; contentType: string | null }> => {
  const target = parsedUrl(url)
  const authenticated = Boolean(
    webAuth && target && !target.username && !target.password && target.origin === webAuth.origin,
  )
  const headers = authenticated ? webAuth?.headers : undefined
  let lastReason: BinaryRequestFailureReason = 'request_failed'
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, {
        // Never let a response redirect Harvest credentials to another origin.
        redirect: authenticated ? 'manual' : 'follow',
        signal: controller.signal,
        ...(headers ? { headers } : {}),
      })
      if (
        authenticated &&
        (response.redirected || (response.status >= 300 && response.status < 400))
      ) {
        throw new BinaryRequestFailure('redirect_refused')
      }
      if (!response.ok) throw new BinaryRequestFailure('http_status')
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        contentType: canonicalContentType(response.headers.get('content-type')) ?? null,
      }
    } catch (error) {
      lastReason = error instanceof BinaryRequestFailure ? error.reason : 'request_failed'
    } finally {
      clearTimeout(timer)
    }
  }
  throw new BinaryRequestFailure(lastReason)
}

const storeAsset = async (
  snapshotDir: string,
  resource: 'receipt' | 'avatar',
  sourceId: number,
  bytes: Uint8Array,
  extension: string,
  contentType: string | null,
): Promise<ManifestBinaryAsset> => {
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const directory = resource === 'receipt' ? 'receipts' : 'avatars'
  const manifestPath = canonicalAssetPath(
    resource,
    sha256,
    resource === 'receipt' ? extension : undefined,
  )
  const destination = join(snapshotDir, manifestPath)
  await mkdir(join(snapshotDir, directory), { recursive: true })
  let alreadyStored = false
  try {
    alreadyStored = Buffer.from(await readFile(destination)).equals(Buffer.from(bytes))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (!alreadyStored) {
    const temporary = `${destination}.tmp-${process.pid}-${resource}-${sourceId}`
    await writeFile(temporary, bytes)
    try {
      await rename(temporary, destination).catch(async (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        await rm(destination, { force: true })
        await rename(temporary, destination)
      })
    } finally {
      await rm(temporary, { force: true })
    }
  }
  return {
    source_id: sourceId,
    sha256,
    path: manifestPath,
    bytes: bytes.byteLength,
    content_type: contentType,
  }
}

export const downloadBinaries = async (
  options: DownloadBinariesOptions,
): Promise<ManifestBinaries> => {
  const { snapshotDir } = options
  const timeoutMs = options.timeoutMs ?? 15_000
  const fetchImpl = options.fetchImpl ?? fetch
  const log = options.log ?? (() => undefined)
  const auth = receiptWebAuth(options)
  const result: ManifestBinaries = {
    receipts: {},
    avatars: {},
    anomalies: (options.prior?.anomalies ?? []).flatMap((anomaly) => {
      const safe = safePriorAnomaly(anomaly)
      return safe ? [safe] : []
    }),
    ...(options.prior?.invoice_pdfs ? { invoice_pdfs: options.prior.invoice_pdfs } : {}),
  }

  const anomalies = result.anomalies
  const addInvalidRecord = (resource: 'receipt' | 'avatar', sourceId: number | null): void => {
    anomalies.push({
      kind: 'invalid_record',
      resource,
      source_id: sourceId,
      message: 'invalid_record',
    })
  }
  for (const resource of ['receipt', 'avatar'] as const) {
    const priorAssets = resource === 'receipt' ? options.prior?.receipts : options.prior?.avatars
    const assets = resource === 'receipt' ? result.receipts : result.avatars
    for (const [id, raw] of Object.entries(priorAssets ?? {})) {
      const sourceId = Number(id)
      if (!Number.isSafeInteger(sourceId) || String(sourceId) !== id) {
        addInvalidRecord(resource, null)
        continue
      }
      const valid = await validPriorAsset(snapshotDir, resource, sourceId, raw)
      if (valid) assets[id] = valid
      else addInvalidRecord(resource, sourceId)
    }
  }

  const current = (): ManifestBinaries => ({
    receipts: { ...result.receipts },
    avatars: { ...result.avatars },
    anomalies: [...result.anomalies],
    ...(result.invoice_pdfs ? { invoice_pdfs: result.invoice_pdfs } : {}),
  })
  const checkpoint = async (): Promise<void> => {
    if (options.onProgress) await options.onProgress(current())
  }

  const archive = async (
    resource: 'receipt' | 'avatar',
    sourceId: number,
    url: string,
    expectedSize: number | undefined,
    fileName: string | undefined,
    declaredType: string | undefined,
  ): Promise<void> => {
    const assets = resource === 'receipt' ? result.receipts : result.avatars
    const previous = assets[String(sourceId)]
    const extension = resource === 'receipt' ? safeExtension(fileName) : ''
    const expectedType = canonicalContentType(declaredType)
    if (
      previous &&
      (await validPriorAsset(
        snapshotDir,
        resource,
        sourceId,
        previous,
        resource === 'receipt' ? extension : undefined,
        typeof expectedType === 'string' ? expectedType : undefined,
      ))
    ) {
      await checkpoint()
      return
    }
    delete assets[String(sourceId)]

    // This source is being retried. Replace its old outcome with the result of
    // this attempt; anomalies for untouched, already-archived files remain.
    for (let index = anomalies.length - 1; index >= 0; index -= 1) {
      if (anomalies[index].resource === resource && anomalies[index].source_id === sourceId) {
        anomalies.splice(index, 1)
      }
    }

    let downloaded: Awaited<ReturnType<typeof fetchBytes>>
    try {
      downloaded = await fetchBytes(
        url,
        timeoutMs,
        fetchImpl,
        resource === 'receipt' ? auth : undefined,
      )
    } catch (error) {
      const reason = error instanceof BinaryRequestFailure ? error.reason : 'request_failed'
      const anomaly: ManifestBinaryAnomaly = {
        kind: 'download_failed',
        resource,
        source_id: sourceId,
        message: reason,
      }
      anomalies.push(anomaly)
      log(`WARNING: ${resource} ${sourceId} binary download failed — ${anomaly.message}`)
      await checkpoint()
      return
    }

    try {
      assets[String(sourceId)] = await storeAsset(
        snapshotDir,
        resource,
        sourceId,
        downloaded.bytes,
        extension,
        typeof expectedType === 'string' ? expectedType : downloaded.contentType,
      )
      if (expectedSize !== undefined && expectedSize !== downloaded.bytes.byteLength) {
        anomalies.push({
          kind: 'size_mismatch',
          resource,
          source_id: sourceId,
          message: 'size_mismatch',
        })
      }
    } catch {
      anomalies.push({
        kind: 'download_failed',
        resource,
        source_id: sourceId,
        message: 'archive_write_failed',
      })
      log(`WARNING: ${resource} ${sourceId} binary download failed — archive_write_failed`)
    }
    await checkpoint()
  }

  const expenses = await jsonl<ReceiptRecord>(join(snapshotDir, 'raw', 'expenses.jsonl'))
  for (const expense of expenses) {
    const receipt = expense.receipt
    if (!Number.isSafeInteger(expense.id) || !receipt?.url) continue
    await archive(
      'receipt',
      expense.id,
      receipt.url,
      receipt.file_size,
      receipt.file_name,
      receipt.content_type,
    )
  }

  const users = await jsonl<UserRecord>(join(snapshotDir, 'raw', 'users.jsonl'))
  for (const user of users) {
    if (!Number.isSafeInteger(user.id) || !user.avatar_url) continue
    await archive('avatar', user.id, user.avatar_url, undefined, undefined, undefined)
  }
  return current()
}
