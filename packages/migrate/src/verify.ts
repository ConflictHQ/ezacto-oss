import { open, mkdir, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { HarvestEnv } from './env.js'
import type { HarvestClientConfig } from './harvest-client.js'
import { readManifest, type Manifest } from './manifest.js'
import { paginate, type PaginateDeps } from './paginator.js'
import { createRateLimiter, type RateLimiter } from './rate-limiter.js'

export const REPORTS_RATE_LIMIT = 100
export const REPORTS_RATE_WINDOW_MS = 15 * 60 * 1000

export interface VerificationIssue {
  kind: 'count_mismatch' | 'dangling_fk' | 'invalid_row'
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
}

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

const readRows = async (snapshotDir: string, resource: string): Promise<Record<string, unknown>[]> => {
  const path = join(snapshotDir, 'raw', `${resource}.jsonl`)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      try {
        const parsed = JSON.parse(line) as unknown
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error()
        return parsed as Record<string, unknown>
      } catch {
        throw new Error(`${path}:${index + 1} is not a JSON object`)
      }
    })
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

export const verifySnapshot = async (
  snapshotDir: string,
  manifest: Manifest,
): Promise<VerificationIssue[]> => {
  const issues: VerificationIssue[] = []
  const rows = new Map<string, Record<string, unknown>[]>()
  const ids = new Map<string, Set<number>>()

  for (const [resource, progress] of Object.entries(manifest.resources)) {
    const current = await readRows(snapshotDir, resource)
    rows.set(resource, current)
    ids.set(
      resource,
      new Set(
        current
          .map((row) => row.id)
          .filter((id): id is number => typeof id === 'number' && Number.isSafeInteger(id)),
      ),
    )
    if (current.length !== progress.count) {
      issues.push({
        kind: 'count_mismatch',
        path: `raw/${resource}.jsonl`,
        id: null,
        message: `manifest claims ${progress.count} rows; file contains ${current.length}`,
      })
    }
  }

  for (const [resource, rules] of Object.entries(FK_RULES)) {
    for (const [index, row] of (rows.get(resource) ?? []).entries()) {
      const sourceId = typeof row.id === 'number' ? row.id : null
      for (const rule of rules) {
        const foreignId = nestedId(row, rule.field)
        if (foreignId === null) continue
        if (!ids.get(rule.target)?.has(foreignId)) {
          issues.push({
            kind: 'dangling_fk',
            path: `raw/${resource}.jsonl:${index + 1}.${rule.field}.id`,
            id: foreignId,
            message: `${resource} ${String(sourceId)} references missing ${rule.target} id ${foreignId}`,
          })
        }
      }
    }
  }
  return issues
}

const reportPeriods = async (
  snapshotDir: string,
  now: Date,
): Promise<Array<{ year: number; from: string; to: string }>> => {
  const dates: string[] = []
  for (const resource of ['time_entries', 'expenses']) {
    for (const row of await readRows(snapshotDir, resource)) {
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
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
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

  const collect = async (key: string, path: string, params: Record<string, string>): Promise<void> => {
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

  const checksums: ChecksumReport = {
    version: 1,
    account_id: manifest.account.id,
    generated_at: now().toISOString(),
    periods,
    reports,
    requests: limiter.granted,
  }
  await writeChecksums(options.snapshotDir, checksums)
  return { issues, checksums }
}
