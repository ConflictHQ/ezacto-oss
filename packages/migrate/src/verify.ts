import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import type { HarvestEnv } from './env.js'
import type { HarvestClientConfig } from './harvest-client.js'
import { readManifest, type Manifest } from './manifest.js'
import { paginate, type PaginateDeps } from './paginator.js'
import { createRateLimiter, type RateLimiter } from './rate-limiter.js'
import { lineagePath, type ChildLineage } from './jsonl.js'
import { RESOURCES } from './resources.js'

export const REPORTS_RATE_LIMIT = 100
export const REPORTS_RATE_WINDOW_MS = 15 * 60 * 1000

export interface VerificationIssue {
  kind: 'count_mismatch' | 'dangling_fk' | 'invalid_row' | 'lineage_mismatch'
  path: string
  id: number | string | null
  message: string
}

export interface ChecksumReport {
  version: 1
  account_id: string
  generated_at: string
  periods: Array<{ year: number; from: string; to: string }>
  reports: Record<string, Array<Record<string, unknown>>>
  requests: number
  snapshot_sha256: string
  report_sha256: string
}

export type ChecksumReportPayload = Omit<ChecksumReport, 'report_sha256'>

/** Binds report/checksum evidence without introducing a self-referential digest. */
export const checksumReportDigest = (report: ChecksumReportPayload): string =>
  createHash('sha256').update(JSON.stringify(report)).digest('hex')

export interface VerifyResult {
  issues: VerificationIssue[]
  checksums: ChecksumReport
}

export interface RunVerifyOptions {
  env: HarvestEnv
  snapshotDir: string
  now?: () => Date
  nowMs?: () => number
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
  baseUrl?: string
  timeoutMs?: number
  limiter?: RateLimiter
}

interface StreamedRow {
  row: Record<string, unknown>
  line: number
}

const streamRows = async function* (
  snapshotDir: string,
  resource: string,
): AsyncGenerator<StreamedRow> {
  const path = join(snapshotDir, 'raw', `${resource}.jsonl`)
  const input = createReadStream(path)
  const lines = createInterface({ input, crlfDelay: Infinity })
  let line = 0
  try {
    for await (const raw of lines) {
      line += 1
      if (!raw.trim()) continue
      try {
        const parsed = JSON.parse(raw) as unknown
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
          throw new Error()
        yield { row: parsed as Record<string, unknown>, line }
      } catch {
        throw new Error(`${path}:${line} is not a JSON object`)
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  } finally {
    lines.close()
  }
}

const streamLineage = async function* (
  snapshotDir: string,
  resource: string,
): AsyncGenerator<{ row: ChildLineage; line: number }> {
  const path = lineagePath(snapshotDir, resource)
  const input = createReadStream(path)
  const lines = createInterface({ input, crlfDelay: Infinity })
  let line = 0
  try {
    for await (const raw of lines) {
      line += 1
      if (!raw.trim()) continue
      const value = JSON.parse(raw) as Partial<ChildLineage>
      if (
        !Number.isSafeInteger(value.source_id) ||
        (value.source_id ?? 0) < 1 ||
        !Number.isSafeInteger(value.parent_id) ||
        (value.parent_id ?? 0) < 1
      ) {
        throw new Error(`${path}:${line} is not valid child lineage`)
      }
      yield { row: value as ChildLineage, line }
    }
  } finally {
    lines.close()
  }
}

const nestedId = (row: Record<string, unknown>, field: string): number | null => {
  const value = row[field]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const id = (value as Record<string, unknown>).id
  return typeof id === 'number' && Number.isSafeInteger(id) ? id : null
}

const FK_RULES: Record<string, Array<{ field: string; target: string }>> = {
  contacts: [{ field: 'client', target: 'clients' }],
  projects: [{ field: 'client', target: 'clients' }],
  task_assignments: [
    { field: 'project', target: 'projects' },
    { field: 'task', target: 'tasks' },
  ],
  user_assignments: [
    { field: 'project', target: 'projects' },
    { field: 'user', target: 'users' },
  ],
  time_entries: [
    { field: 'project', target: 'projects' },
    { field: 'task', target: 'tasks' },
    { field: 'user', target: 'users' },
    { field: 'task_assignment', target: 'task_assignments' },
    { field: 'user_assignment', target: 'user_assignments' },
  ],
  expenses: [
    { field: 'project', target: 'projects' },
    { field: 'user', target: 'users' },
    { field: 'expense_category', target: 'expense_categories' },
  ],
  invoices: [{ field: 'client', target: 'clients' }],
  estimates: [{ field: 'client', target: 'clients' }],
}

const IDENTITY_TARGETS = new Set([
  ...Object.values(FK_RULES).flatMap((rules) => rules.map((rule) => rule.target)),
  ...RESOURCES.flatMap((step) => (step.kind === 'child' ? [step.parent] : [])),
])

export const verifySnapshot = async (
  snapshotDir: string,
  manifest: Manifest,
): Promise<VerificationIssue[]> => {
  const issues: VerificationIssue[] = []
  const addIssue = (issue: VerificationIssue): void => {
    if (issues.length < 1000) issues.push(issue)
  }
  const indexDir = await mkdtemp(join(tmpdir(), 'ezacto-verify-index-'))
  const identities = new BetterSqlite3(join(indexDir, 'identities.sqlite'))
  identities.exec(`CREATE TABLE identities (
    resource TEXT NOT NULL,
    id INTEGER NOT NULL,
    PRIMARY KEY (resource, id)
  ) WITHOUT ROWID`)
  const insertIdentity = identities.prepare(
    'INSERT OR IGNORE INTO identities (resource, id) VALUES (?, ?)',
  )
  const hasIdentity = identities.prepare('SELECT 1 FROM identities WHERE resource = ? AND id = ?')
  const insertBatch = identities.transaction((batch: Array<[string, number]>) => {
    for (const identity of batch) insertIdentity.run(...identity)
  })
  try {
    let pending: Array<[string, number]> = []
    for (const [resource, progress] of Object.entries(manifest.resources)) {
      let count = 0
      for await (const { row } of streamRows(snapshotDir, resource)) {
        count += 1
        if (
          IDENTITY_TARGETS.has(resource) &&
          typeof row.id === 'number' &&
          Number.isSafeInteger(row.id)
        ) {
          pending.push([resource, row.id])
          if (pending.length === 1000) {
            insertBatch(pending)
            pending = []
          }
        }
      }
      if (count !== progress.count)
        addIssue({
          kind: 'count_mismatch',
          path: `raw/${resource}.jsonl`,
          id: null,
          message: `manifest claims ${progress.count} rows; file contains ${count}`,
        })
    }
    if (pending.length > 0) insertBatch(pending)

    for (const [resource, rules] of Object.entries(FK_RULES)) {
      for await (const { row, line } of streamRows(snapshotDir, resource)) {
        const sourceId = typeof row.id === 'number' ? row.id : null
        for (const rule of rules) {
          const foreignId = nestedId(row, rule.field)
          if (foreignId === null || hasIdentity.get(rule.target, foreignId)) continue
          addIssue({
            kind: 'dangling_fk',
            path: `raw/${resource}.jsonl:${line}.${rule.field}.id`,
            id: foreignId,
            message: `${resource} ${String(sourceId)} references missing ${rule.target} id ${foreignId}`,
          })
        }
      }
    }

    for (const step of RESOURCES) {
      if (step.kind !== 'child' || manifest.resources[step.name] === undefined) continue
      const lineage = streamLineage(snapshotDir, step.name)[Symbol.asyncIterator]()
      let rawCount = 0
      let lineageCount = 0
      try {
        for await (const { row } of streamRows(snapshotDir, step.name)) {
          rawCount += 1
          const witness = await lineage.next()
          if (witness.done) continue
          lineageCount += 1
          const sourceId = row.id
          if (sourceId !== witness.value.row.source_id)
            addIssue({
              kind: 'lineage_mismatch',
              path: `raw/${step.name}.lineage.jsonl:${witness.value.line}.source_id`,
              id: witness.value.row.source_id,
              message: `lineage source id ${witness.value.row.source_id} does not match aligned raw id ${String(sourceId)}`,
            })
          if (!hasIdentity.get(step.parent, witness.value.row.parent_id))
            addIssue({
              kind: 'dangling_fk',
              path: `raw/${step.name}.lineage.jsonl:${witness.value.line}.parent_id`,
              id: witness.value.row.parent_id,
              message: `${step.name} ${witness.value.row.source_id} references missing ${step.parent} id ${witness.value.row.parent_id}`,
            })
        }
        for (;;) {
          const extra = await lineage.next()
          if (extra.done) break
          lineageCount += 1
        }
      } catch (error) {
        addIssue({
          kind: 'lineage_mismatch',
          path: `raw/${step.name}.lineage.jsonl`,
          id: null,
          message:
            (error as NodeJS.ErrnoException).code === 'ENOENT'
              ? 'child lineage is missing; re-extract this resource before verify/load'
              : error instanceof Error
                ? error.message
                : String(error),
        })
        continue
      }
      if (lineageCount !== rawCount)
        addIssue({
          kind: 'lineage_mismatch',
          path: `raw/${step.name}.lineage.jsonl`,
          id: null,
          message: `lineage contains ${lineageCount} rows; raw/${step.name}.jsonl contains ${rawCount}`,
        })
    }
    return issues
  } finally {
    identities.close()
    await rm(indexDir, { recursive: true, force: true })
  }
}

const hashFile = async (hash: ReturnType<typeof createHash>, path: string): Promise<void> => {
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/** Stable transform input identity; child lineage is deliberately part of it. */
export const snapshotDigest = async (snapshotDir: string, manifest: Manifest): Promise<string> => {
  const hash = createHash('sha256')
  hash.update(
    JSON.stringify({
      account: manifest.account,
      company_name: manifest.company_name,
      started_at: manifest.started_at,
      finished_at: manifest.finished_at,
      preflight: manifest.preflight,
      resources: Object.fromEntries(
        Object.entries(manifest.resources)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([name, resource]) => [name, { count: resource.count }]),
      ),
    }),
  )
  hash.update('\0')
  for (const resource of Object.keys(manifest.resources).sort()) {
    hash.update(`${resource}\0`)
    await hashFile(hash, join(snapshotDir, 'raw', `${resource}.jsonl`))
    const child = RESOURCES.find((step) => step.name === resource)?.kind === 'child'
    if (child) {
      hash.update(`${resource}.lineage\0`)
      await hashFile(hash, lineagePath(snapshotDir, resource))
    }
  }
  hash.update(JSON.stringify(manifest.binaries ?? null))
  return hash.digest('hex')
}

const reportPeriods = async (
  snapshotDir: string,
  now: Date,
): Promise<Array<{ year: number; from: string; to: string }>> => {
  const dates: string[] = []
  for (const resource of ['time_entries', 'expenses']) {
    for await (const { row } of streamRows(snapshotDir, resource)) {
      if (typeof row.spent_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.spent_date)) {
        dates.push(row.spent_date)
      }
    }
  }
  const final = now.toISOString().slice(0, 10)
  const first = dates.filter((date) => date <= final).sort()[0] ?? `${final.slice(0, 4)}-01-01`
  const periods: Array<{ year: number; from: string; to: string }> = []
  for (let year = Number(first.slice(0, 4)); year <= Number(final.slice(0, 4)); year += 1) {
    periods.push({
      year,
      from: year === Number(first.slice(0, 4)) ? first : `${year}-01-01`,
      to: year === Number(final.slice(0, 4)) ? final : `${year}-12-31`,
    })
  }
  return periods
}

const writeChecksums = async (snapshotDir: string, report: ChecksumReport): Promise<void> => {
  await mkdir(snapshotDir, { recursive: true })
  const target = join(snapshotDir, 'checksums.json')
  const temporary = `${target}.tmp`
  const handle = await open(temporary, 'w')
  try {
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, target)
}

export const runVerify = async (options: RunVerifyOptions): Promise<VerifyResult> => {
  const manifest = await readManifest(options.snapshotDir)
  const issues = await verifySnapshot(options.snapshotDir, manifest)
  const now = options.now ?? (() => new Date())
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const limiter =
    options.limiter ??
    createRateLimiter({
      limit: REPORTS_RATE_LIMIT,
      windowMs: REPORTS_RATE_WINDOW_MS,
      now: options.nowMs,
      sleep,
    })
  const deps: PaginateDeps = { limiter, sleep, log: options.log ?? console.log }
  const config: HarvestClientConfig = {
    pat: options.env.pat,
    accountId: manifest.account.id,
    userAgentEmail: options.env.userAgentEmail,
    baseUrl: options.baseUrl,
    timeoutMs: options.timeoutMs,
  }
  const periods = await reportPeriods(options.snapshotDir, now())
  const reports: Record<string, Array<Record<string, unknown>>> = {}

  const collect = async (
    key: string,
    path: string,
    params: Record<string, string>,
  ): Promise<void> => {
    const collected: Array<Record<string, unknown>> = []
    for await (const page of paginate(
      { resource: key, path, collection: 'results', params },
      config,
      deps,
    )) {
      for (const result of page.objects) {
        if (typeof result !== 'object' || result === null || Array.isArray(result)) {
          throw new Error(`${key} returned a non-object result row`)
        }
        collected.push(result as Record<string, unknown>)
      }
    }
    reports[key] = collected
  }

  for (const period of periods) {
    for (const grain of ['clients', 'projects', 'tasks', 'team']) {
      await collect(`time/${grain}/${period.year}`, `/v2/reports/time/${grain}`, {
        from: period.from,
        to: period.to,
        include_fixed_fee: 'true',
      })
    }
    for (const grain of ['clients', 'projects', 'categories', 'team']) {
      await collect(`expenses/${grain}/${period.year}`, `/v2/reports/expenses/${grain}`, {
        from: period.from,
        to: period.to,
      })
    }
  }
  const wholeRange = { from: periods[0].from, to: periods[periods.length - 1].to }
  await collect('uninvoiced', '/v2/reports/uninvoiced', {
    ...wholeRange,
    include_fixed_fee: 'true',
  })
  await collect('project_budget/active', '/v2/reports/project_budget', { is_active: 'true' })
  await collect('project_budget/inactive', '/v2/reports/project_budget', { is_active: 'false' })

  const checksumPayload: ChecksumReportPayload = {
    version: 1,
    account_id: manifest.account.id,
    generated_at: now().toISOString(),
    periods,
    reports,
    requests: limiter.granted,
    snapshot_sha256: await snapshotDigest(options.snapshotDir, manifest),
  }
  const checksums: ChecksumReport = {
    ...checksumPayload,
    report_sha256: checksumReportDigest(checksumPayload),
  }
  await writeChecksums(options.snapshotDir, checksums)
  return { issues, checksums }
}
