import { createHash } from 'node:crypto'
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import type {
  ManifestBinaries,
  ManifestBinaryAnomaly,
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
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path)
    return true
  } catch {
    return false
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

const fetchBytes = async (
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<{ bytes: Uint8Array; contentType: string | null }> => {
  let last: unknown
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, { redirect: 'follow', signal: controller.signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        contentType: response.headers.get('content-type'),
      }
    } catch (error) {
      last = error
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error(last instanceof Error ? last.message : String(last))
}

export const downloadBinaries = async (
  options: DownloadBinariesOptions,
): Promise<ManifestBinaries> => {
  const { snapshotDir } = options
  const timeoutMs = options.timeoutMs ?? 15_000
  const fetchImpl = options.fetchImpl ?? fetch
  const log = options.log ?? (() => undefined)
  const result: ManifestBinaries = {
    receipts: { ...(options.prior?.receipts ?? {}) },
    avatars: { ...(options.prior?.avatars ?? {}) },
    anomalies: [...(options.prior?.anomalies ?? [])],
  }

  const anomalies = result.anomalies
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
    if (previous && (await exists(join(snapshotDir, previous.path)))) return

    // This source is being retried. Replace its old outcome with the result of
    // this attempt; anomalies for untouched, already-archived files remain.
    for (let index = anomalies.length - 1; index >= 0; index -= 1) {
      if (anomalies[index].resource === resource && anomalies[index].source_id === sourceId) {
        anomalies.splice(index, 1)
      }
    }

    try {
      const downloaded = await fetchBytes(url, timeoutMs, fetchImpl)
      const sha256 = createHash('sha256').update(downloaded.bytes).digest('hex')
      const directory = resource === 'receipt' ? 'receipts' : 'avatars'
      const destination = join(snapshotDir, directory, `${sha256}${safeExtension(fileName)}`)
      await mkdir(join(snapshotDir, directory), { recursive: true })
      const temporary = `${destination}.tmp`
      await writeFile(temporary, downloaded.bytes)
      await rename(temporary, destination).catch(async (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        await rm(temporary, { force: true })
      })
      const asset: ManifestBinaryAsset = {
        source_id: sourceId,
        sha256,
        path: relative(snapshotDir, destination),
        bytes: downloaded.bytes.byteLength,
        content_type: declaredType ?? downloaded.contentType,
      }
      assets[String(sourceId)] = asset
      if (expectedSize !== undefined && expectedSize !== downloaded.bytes.byteLength) {
        anomalies.push({
          kind: 'size_mismatch',
          resource,
          source_id: sourceId,
          message: `expected ${expectedSize} bytes, downloaded ${downloaded.bytes.byteLength}`,
        })
      }
    } catch (error) {
      const anomaly: ManifestBinaryAnomaly = {
        kind: 'download_failed',
        resource,
        source_id: sourceId,
        message: error instanceof Error ? error.message : String(error),
      }
      anomalies.push(anomaly)
      log(`WARNING: ${resource} ${sourceId} binary download failed — ${anomaly.message}`)
    }
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
  return result
}
