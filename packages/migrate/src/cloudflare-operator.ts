import { createHash } from 'node:crypto'
import { isMigrationLoadId, QueuedMigrationError, type MigrationLoadMessage } from '@ezacto/core'

export interface CloudflareMigrationTarget {
  accountId: string
  apiToken: string
  databaseId: string
  bucket: string
  queueId: string
}
const invalid = (code = 'migration_cloudflare_request_failed'): never => {
  throw new QueuedMigrationError(code, 'target')
}
export const cloudflareMigrationOperator = (
  target: CloudflareMigrationTarget,
  fetcher: typeof fetch = fetch,
) => {
  if (
    !/^[a-f0-9]{32}$/.test(target.accountId) ||
    !isMigrationLoadId(target.databaseId) ||
    !/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(target.bucket) ||
    !/^[a-f0-9]{32}$/.test(target.queueId) ||
    !target.apiToken.trim()
  )
    invalid('invalid_migration_target')
  const base = `https://api.cloudflare.com/client/v4/accounts/${target.accountId}`
  const request = async (path: string, init: RequestInit = {}) => {
    try {
      return await fetcher(base + path, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(300000),
        headers: { ...init.headers, authorization: `Bearer ${target.apiToken}` },
      })
    } catch {
      return invalid()
    }
  }
  const json = async <T>(response: Response): Promise<T> => {
    if (!response.ok) {
      await response.body?.cancel()
      return invalid()
    }
    const payload = (await response.json().catch(() => invalid())) as {
      success?: boolean
      result?: T
    }
    if (payload.success !== true || payload.result === undefined) return invalid()
    return payload.result
  }
  const query = async (batch: readonly { sql: string; params: readonly unknown[] }[]) => {
    const results = await json<D1Result[]>(
      await request(`/d1/database/${target.databaseId}/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ batch }),
      }),
    )
    if (
      !Array.isArray(results) ||
      results.length !== batch.length ||
      results.some((result) => result.success !== true)
    )
      return invalid()
    return results
  }
  const prepared = new WeakMap<D1PreparedStatement, { sql: string; params: readonly unknown[] }>()
  const prepare = (sql: string, params: readonly unknown[] = []): D1PreparedStatement => {
    const statement = {
      bind: (...values: unknown[]) => prepare(sql, values),
      run: async () => (await query([{ sql, params }]))[0]!,
      all: async () => (await query([{ sql, params }]))[0]!,
      first: async (column?: string) => {
        const row = (await query([{ sql, params }]))[0]!.results[0] as
          Record<string, unknown> | undefined
        return column === undefined ? (row ?? null) : (row?.[column] ?? null)
      },
    } as unknown as D1PreparedStatement
    prepared.set(statement, { sql, params })
    return statement
  }
  const database = {
    prepare,
    batch: async (statements: readonly D1PreparedStatement[]) =>
      query(
        statements.map((statement) => {
          const value = prepared.get(statement)
          if (!value) return invalid()
          return value
        }),
      ),
  } as unknown as D1Database
  const objectPath = (key: string) =>
    `/r2/buckets/${target.bucket}/objects/${key.split('/').map(encodeURIComponent).join('/')}`
  const inspectObject = async (key: string, maximum: number) => {
    const response = await request(objectPath(key))
    if (response.status === 404) {
      await response.body?.cancel()
      return null
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      return invalid()
    }
    const hash = createHash('sha256'),
      reader = response.body.getReader()
    let bytes = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.length
        if (bytes > maximum) return invalid('migration_object_too_large')
        hash.update(chunk.value)
      }
    } finally {
      await reader.cancel()
      reader.releaseLock()
    }
    const etag = response.headers.get('etag')?.replace(/^"|"$/g, '')
    if (!etag || !/^[A-Za-z0-9._-]{1,128}$/.test(etag)) return invalid('invalid_migration_etag')
    return { bytes, sha256: hash.digest('hex'), etag }
  }
  const putObject = async (key: string, body: BodyInit, bytes: number) => {
    const response = await request(objectPath(key), {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(bytes),
        'if-none-match': '*',
      },
      body,
      // Node fetch requires this for streaming request bodies; browsers never use this operator adapter.
      ...({ duplex: 'half' } as object),
    })
    const value = await json<{ key?: string; size?: string; etag?: string }>(response)
    if (value.key !== key || Number(value.size) !== bytes || typeof value.etag !== 'string')
      return invalid('migration_upload_mismatch')
  }
  const send = async (message: MigrationLoadMessage) => {
    await json<unknown>(
      await request(`/queues/${target.queueId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: message, content_type: 'json' }),
      }),
    )
  }
  return { databaseId: target.databaseId, database, inspectObject, putObject, send }
}
