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
const combine = (parts: string[], operator: string): string => {
  if (parts.length === 1) return parts[0]!
  const middle = Math.floor(parts.length / 2)
  return `(${combine(parts.slice(0, middle), operator)} ${operator} ${combine(parts.slice(middle), operator)})`
}
const schemaSql = `SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type,name`
const internalTables = new Set([
  'worker_backup_snapshots',
  'worker_backup_rows',
  'worker_backup_cleanup',
])
const maxObject = 16 * 1024 * 1024
const pageBytes = 1024 * 1024
const encode = new TextEncoder()
const hash = async (bytes: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))))
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('')
const decode = ([type, value]: WorkerBackupCell) =>
  type === 'null'
    ? null
    : type === 'text'
      ? new TextDecoder('utf-8', { fatal: true }).decode(
          Uint8Array.from(value!.match(/../gu) ?? [], (h) => parseInt(h, 16)),
        )
      : value
export const expireWorkerSnapshots = async (database: D1Database) => {
  await database
    .prepare(
      `DELETE FROM worker_backup_snapshots WHERE julianday(created_at)<=julianday('now','-1 hour')`,
    )
    .run()
}
export const discardWorkerSnapshot = async (database: D1Database, id: string, prefix: string) => {
  await database.batch([
    database
      .prepare(
        "DELETE FROM worker_backup_snapshots WHERE id=? AND NOT EXISTS(SELECT 1 FROM backup_runs WHERE status='completed' AND r2_prefix=?)",
      )
      .bind(id, prefix),
    database
      .prepare(
        "INSERT INTO worker_backup_cleanup(prefix,available_at) SELECT ?,strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour') WHERE NOT EXISTS(SELECT 1 FROM backup_runs WHERE status='completed' AND r2_prefix=?) ON CONFLICT(prefix) DO UPDATE SET available_at=max(available_at,excluded.available_at),generation=generation+1",
      )
      .bind(prefix, prefix),
  ])
}
/** All source rows freeze atomically in D1, then bounded pages cross into Worker memory. */
export async function captureWorkerSnapshot(
  database: D1Database,
  store: BackupObjectStore,
  prefix: string,
  csvRow: (values: unknown[]) => string,
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
  if (!tables.some((t) => t.name === 'worker_backup_snapshots'))
    throw new Error('Worker backup requires migration 0176.')
  const id = crypto.randomUUID(),
    createdAt = new Date().toISOString()
  try {
    const statements = [
      database.prepare(schemaSql),
      database
        .prepare(
          "INSERT INTO worker_backup_snapshots(id,prefix,created_at,state) VALUES(?,?,?,'capturing')",
        )
        .bind(id, prefix, createdAt),
    ]
    for (const table of tables) {
      if (internalTables.has(table.name)) continue
      if (!table.columns.length)
        throw new Error('Worker backup cannot capture a table without writable columns.')
      const cells = table.columns.map((name) => {
        const q = quote(name)
        return `json_array(typeof(${q}),CASE typeof(${q}) WHEN 'null' THEN NULL WHEN 'text' THEN hex(CAST(${q} AS BLOB)) WHEN 'blob' THEN hex(${q}) WHEN 'integer' THEN printf('%lld',${q}) WHEN 'real' THEN printf('%!.17g',${q}) END)`
      })
      statements.push(
        database
          .prepare(
            `INSERT INTO worker_backup_rows(snapshot_id,table_name,ordinal,encoded) SELECT ?,?,row_number() OVER (), '[' || ${combine(cells, "|| ',' ||")} || ']' FROM ${quote(table.name)}`,
          )
          .bind(id, table.name),
      )
    }
    statements.push(
      database.prepare(
        sequenceExists!.results.length
          ? `SELECT name,CAST(seq AS TEXT) AS seq FROM sqlite_sequence ORDER BY name`
          : `SELECT '' AS name,'' AS seq WHERE 0`,
      ),
    )
    statements.push(
      database.prepare(`UPDATE worker_backup_snapshots SET state='ready' WHERE id=?`).bind(id),
    )
    const captured = await database.batch(statements)
    if (JSON.stringify(captured[0]!.results) !== JSON.stringify(objects))
      throw new Error('The database schema changed during backup; retry the export.')
    const files: Record<string, WorkerBackupFile> = {}
    const put = async (name: string, text: string) => {
      const bytes = encode.encode(text)
      if (bytes.length > maxObject)
        throw new Error('A Worker backup object exceeds 16 MiB; use an operator SQL export.')
      await store.put(prefix + name, text)
      files[name] = { sha256: await hash(bytes), byte_size: bytes.length }
    }
    const schema: WorkerSnapshotSchema = {
      format: 'ezacto-worker-snapshot-1',
      objects,
      tables: [],
      sequences: captured.at(-2)!.results as unknown as WorkerSnapshotSchema['sequences'],
      attachments: [],
    }
    const csvTables: Record<string, { row_count: number; sha256: string }> = {}
    const fileRows: Array<Record<string, unknown>> = []
    let totalRows = 0
    for (const table of tables) {
      let ordinal = 0,
        count = 0,
        csv = csvRow(table.columns) + '\n'
      let csvBytes = encode.encode(csv).length
      const chunks: string[] = []
      if (!internalTables.has(table.name))
        for (;;) {
          const page = await database.batch([
            database
              .prepare(`SELECT state FROM worker_backup_snapshots WHERE id=? AND state='ready'`)
              .bind(id),
            database
              .prepare(
                `WITH next AS (SELECT ordinal,encoded FROM worker_backup_rows WHERE snapshot_id=? AND table_name=? AND ordinal>? ORDER BY ordinal LIMIT 500), sized AS (SELECT ordinal,encoded,sum(length(CAST(encoded AS BLOB))+1) OVER(ORDER BY ordinal) AS bytes FROM next) SELECT ordinal,encoded FROM sized WHERE bytes<=? OR ordinal=(SELECT min(ordinal) FROM next) ORDER BY ordinal`,
              )
              .bind(id, table.name, ordinal, pageBytes),
          ])
          if (!page[0]!.results.length)
            throw new Error('Worker backup was invalidated by privacy erasure or expired.')
          const rows = page[1]!.results as unknown as Array<{ ordinal: number; encoded: string }>
          if (!rows.length) break
          const name = `rows/${table.name}/${String(chunks.length).padStart(6, '0')}.json`
          await put(name, '[' + rows.map((r) => r.encoded).join(',') + ']')
          chunks.push(name)
          for (const row of rows) {
            const values = (JSON.parse(row.encoded) as WorkerBackupCell[]).map(decode)
            const line = csvRow(values) + '\n'
            csvBytes += encode.encode(line).length
            csv += line
            count++
            ordinal = row.ordinal
            if (['file_objects', 'brand_assets'].includes(table.name))
              fileRows.push(Object.fromEntries(table.columns.map((c, j) => [c, values[j]])))
          }
          if (csvBytes > maxObject)
            throw new Error('A Worker backup CSV exceeds 16 MiB; use an operator SQL export.')
        }
      if (!chunks.length) {
        const name = `rows/${table.name}/000000.json`
        await put(name, '[]')
        chunks.push(name)
      }
      schema.tables.push({ ...table, chunks, row_count: count })
      totalRows += count
      await store.put(`${prefix}tables/${table.name}.csv`, csv)
      csvTables[table.name] = { row_count: count, sha256: await hash(encode.encode(csv)) }
    }
    const seen = new Set<string>(),
      mappedKeys = new Map<string, string>()
    for (const row of fileRows) {
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
      if (mappedKeys.has(key) && mappedKeys.get(key) !== contentHash)
        throw new Error('Worker attachment identities conflict.')
      if (!mappedKeys.has(key))
        schema.attachments.push({
          file_key: key,
          path: name,
          sha256: contentHash,
          byte_size: length,
        })
      mappedKeys.set(key, contentHash)
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
    if (
      !(await database
        .prepare(`SELECT 1 FROM worker_backup_snapshots WHERE id=? AND state='ready'`)
        .bind(id)
        .first())
    )
      throw new Error('Worker backup was invalidated by privacy erasure or expired.')
    return { files, tables: csvTables, totalRows, captureId: id }
  } catch (error) {
    await discardWorkerSnapshot(database, id, prefix)
    throw error
  }
}
