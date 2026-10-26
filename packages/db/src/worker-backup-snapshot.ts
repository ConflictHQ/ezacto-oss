import { workerBackupFiles, type WorkerBackupFileReceipt } from '@ezacto/core'
import type { BackupObjectStore } from './backup.js'

export type WorkerBackupFile = WorkerBackupFileReceipt

export type WorkerBackupCell = readonly [string, string | null]
interface SchemaObject {
  type: string
  name: string
  tbl_name: string
  sql: string
}
interface Column {
  table_name: string
  name: string
  hidden: number
  cid: number
}
export interface WorkerSnapshotSchema {
  format: 'ezacto-worker-snapshot-1'
  objects: SchemaObject[]
  tables: Array<{ name: string; columns: string[]; chunks: string[]; row_count: number }>
  sequences: Array<{ name: string; seq: string }>
  attachments: Array<{ file_key: string; path: string; sha256: string; byte_size: number }>
}
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"'
const schemaSql = `SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type,name`
const maxObject = 16 * 1024 * 1024
const maxSnapshot = 64 * 1024 * 1024
const encode = new TextEncoder()
const hash = async (bytes: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))))
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('')

/** One D1 transaction captures all rows. R2 publication follows only that frozen capture. */
export async function captureWorkerSnapshot(
  database: D1Database,
  store: BackupObjectStore,
  prefix: string,
) {
  const [discovered, columnResult, sequenceExists] = await database.batch([
    database.prepare(schemaSql),
    database.prepare(
      `SELECT m.name AS table_name,p.name,p.hidden,p.cid FROM sqlite_schema m JOIN pragma_table_xinfo(m.name) p WHERE m.type='table' AND m.name NOT LIKE 'sqlite_%' AND m.name NOT LIKE '_cf_%' ORDER BY m.name,p.cid`,
    ),
    database.prepare(`SELECT 1 AS present FROM sqlite_schema WHERE name='sqlite_sequence'`),
  ])
  const objects = discovered!.results as unknown as SchemaObject[]
  if (
    objects.some(
      (o) =>
        !['table', 'index', 'trigger', 'view'].includes(o.type) ||
        !/^[A-Za-z0-9_]+$/u.test(o.name) ||
        /CREATE\s+VIRTUAL\s+TABLE/iu.test(o.sql),
    )
  )
    throw new Error('Worker backup contains an unsupported schema object.')
  const columns = columnResult!.results as unknown as Column[]
  const tables = objects
    .filter((o) => o.type === 'table')
    .map((o) => ({
      name: o.name,
      columns: columns.filter((c) => c.table_name === o.name && c.hidden === 0).map((c) => c.name),
    }))
  const statements = [
    database.prepare(schemaSql),
    ...tables.map((table) => {
      if (!table.columns.length)
        throw new Error('Worker backup cannot capture a table without writable columns.')
      const cells = table.columns.map((name) => {
        const q = quote(name)
        return `json_array(typeof(${q}),CASE typeof(${q}) WHEN 'null' THEN NULL WHEN 'text' THEN hex(CAST(${q} AS BLOB)) WHEN 'blob' THEN hex(${q}) WHEN 'integer' THEN printf('%lld',${q}) WHEN 'real' THEN printf('%!.17g',${q}) END)`
      })
      return database.prepare(
        `SELECT json_array(${cells.join(',')}) AS encoded FROM ${quote(table.name)}`,
      )
    }),
    database.prepare(
      sequenceExists!.results.length
        ? `SELECT name,CAST(seq AS TEXT) AS seq FROM sqlite_sequence ORDER BY name`
        : `SELECT '' AS name,'' AS seq WHERE 0`,
    ),
  ]
  const captured = await database.batch(statements)
  if (JSON.stringify(captured[0]!.results) !== JSON.stringify(objects))
    throw new Error('The database schema changed during backup; retry the export.')
  const files: Record<string, WorkerBackupFile> = {}
  let totalBytes = 0
  const put = async (name: string, value: string) => {
    const bytes = encode.encode(value)
    if (bytes.length > maxObject)
      throw new Error('A Worker backup object exceeds 16 MiB; use an operator SQL export.')
    totalBytes += bytes.length
    if (totalBytes > maxSnapshot)
      throw new Error('The Worker database snapshot exceeds 64 MiB; use an operator SQL export.')
    await store.put(prefix + name, value)
    files[name] = { sha256: await hash(bytes), byte_size: bytes.length }
  }
  const schema: WorkerSnapshotSchema = {
    format: 'ezacto-worker-snapshot-1',
    objects,
    tables: [],
    sequences: captured.at(-1)!.results as unknown as WorkerSnapshotSchema['sequences'],
    attachments: [],
  }
  const csvTables: Array<{ name: string; columns: string[]; rows: unknown[][] }> = []
  const decodedByName = new Map<string, Array<Record<string, unknown>>>()
  for (const [i, table] of tables.entries()) {
    const encodedRows = captured[i + 1]!.results.map((row) =>
      String((row as { encoded: string }).encoded),
    )
    const chunks: string[] = []
    let chunk: string[] = [],
      size = 2
    const flush = async () => {
      const name = `rows/${table.name}/${String(chunks.length).padStart(6, '0')}.json`
      await put(name, '[' + chunk.join(',') + ']')
      chunks.push(name)
      chunk = []
      size = 2
    }
    for (const row of encodedRows) {
      const bytes = encode.encode(row).length + 1
      if (bytes > maxObject - 2)
        throw new Error('A Worker backup row exceeds 16 MiB; use an operator SQL export.')
      if (size + bytes > maxObject) await flush()
      chunk.push(row)
      size += bytes
    }
    await flush()
    schema.tables.push({ ...table, chunks, row_count: encodedRows.length })
    const rows = encodedRows.map((row) =>
      (JSON.parse(row) as WorkerBackupCell[]).map(([type, value]) =>
        type === 'null'
          ? null
          : type === 'text'
            ? new TextDecoder('utf-8', { fatal: true }).decode(
                Uint8Array.from(value!.match(/../gu) ?? [], (h) => parseInt(h, 16)),
              )
            : value,
      ),
    )
    csvTables.push({ ...table, rows })
    if (['file_objects', 'brand_assets'].includes(table.name))
      decodedByName.set(
        table.name,
        rows.map((row) => Object.fromEntries(table.columns.map((c, j) => [c, row[j]]))),
      )
  }
  const seen = new Set<string>()
  const mappedKeys = new Map<string, string>()
  for (const row of [
    ...(decodedByName.get('file_objects') ?? []),
    ...(decodedByName.get('brand_assets') ?? []),
  ]) {
    const contentHash = String(row.content_hash),
      key = String(row.file_key),
      length = Number(row.byte_size)
    if (
      !/^[0-9a-f]{64}$/u.test(contentHash) ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > maxObject
    )
      throw new Error('A Worker attachment exceeds the supported verified backup bounds.')
    const name = `attachments/sha256/${contentHash.slice(0, 2)}/${contentHash}`
    if (mappedKeys.has(key) && mappedKeys.get(key) !== contentHash) throw new Error('Worker attachment identities conflict.')
    if (!mappedKeys.has(key)) schema.attachments.push({ file_key: key, path: name, sha256: contentHash, byte_size: length })
    mappedKeys.set(key,contentHash)
    if (!store.get || !store.putBytes)
      throw new Error('Worker backup requires attachment read and binary-write access.')
    const bytes = await store.get(key)
    if (!bytes || bytes.length !== length || (await hash(bytes)) !== contentHash)
      throw new Error('A Worker backup attachment is missing or differs from its recorded bytes.')
    if (seen.has(name)) continue
    await store.putBytes(prefix + name, bytes)
    files[name] = { sha256: contentHash, byte_size: length }
    seen.add(name)
  }
  await put('schema.json', JSON.stringify(schema))
  workerBackupFiles(files)
  return { files, tables: csvTables }
}
