import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import type { ServerType } from '@hono/node-server'
import { serve } from '@hono/node-server'
import BetterSqlite3 from 'better-sqlite3'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createApiApp,
  installGeneralResourceRoutes,
  installReportRoutes,
  installTrackedResourceRoutes,
} from '@ezacto/api'
import {
  createContainerDatabase,
  createGeneralResourceRepository,
  createReportRepository,
  DrizzleTrackedResourceRepository,
  migrateContainer,
} from '../../db/src/index.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const fullToken = `ezacto_abcdefghijklmnop_${'A'.repeat(43)}`
const noMoneyToken = `ezacto_abcdefghijklmnop_${'C'.repeat(43)}`
const packageDirectory = fileURLToPath(new URL('..', import.meta.url))
const cliPath = join(packageDirectory, 'dist', 'cli.js')
const spentDate = '2026-08-28'

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

const runEz = (
  args: readonly string[],
  configPath: string,
  stdin = '',
): Promise<RunResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: packageDirectory,
      env: { ...process.env, EZACTO_CONFIG: configPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
    })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
    child.stdin.end(stdin)
  })

describe('ez money commands against the native API', () => {
  let server: ServerType
  let sqlite: BetterSqlite3.Database
  let directory: string
  let fullConfigPath: string
  let noMoneyConfigPath: string
  let baseUrl: string
  const instant = `${spentDate}T08:00:00.000Z`

  beforeAll(async () => {
    sqlite = new BetterSqlite3(':memory:')
    migrateContainer(sqlite)
    const now = `${spentDate}T08:00:00.000Z`
    sqlite.exec(`
      INSERT INTO organizations (
        name, time_entry_mode, time_rounding, modules, created_at, updated_at
      ) VALUES ('Test organization', 'duration', 'nearest_6', '{}', '${now}', '${now}');
      INSERT INTO users (
        id, first_name, last_name, profile, manager_grants, created_at, updated_at
      ) VALUES (1, 'CLI', 'User', 'administrator', '["billable_rates_manager"]', '${now}', '${now}');
      INSERT INTO clients (id, name, currency, created_at, updated_at)
      VALUES (1, 'North Peak', 'USD', '${now}', '${now}');
      INSERT INTO projects (id, client_id, name, code, created_at, updated_at)
      VALUES (1, 1, 'North Peak', 'northpeak', '${now}', '${now}');
      INSERT INTO tasks (id, name, created_at, updated_at)
      VALUES (1, 'DevOps', '${now}', '${now}');
      INSERT INTO user_assignments (id, project_id, user_id, created_at, updated_at)
      VALUES (1, 1, 1, '${now}', '${now}');
      INSERT INTO task_assignments (
        id, project_id, task_id, billable, created_at, updated_at
      ) VALUES (1, 1, 1, 1, '${now}', '${now}');
      INSERT INTO time_entries (
        id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
        spent_date, seconds, seconds_without_timer, rounded_seconds, billable,
        approval_status, created_at, updated_at
      ) VALUES (
        1, 1, 1, 1, 1, 1,
        '${spentDate}', 7200, 0, 7200, 1,
        'unsubmitted', '${now}', '${now}'
      );
    `)
    const database = createContainerDatabase(sqlite)
    const general = createGeneralResourceRepository(database)
    const tracked = new DrizzleTrackedResourceRepository(database, {
      isLocked: async () => false,
    })
    const reports = createReportRepository(database)
    const app = createApiApp({
      authentication: {
        tokens: {
          authenticate: async (presented) => {
            if (presented === fullToken) {
              return {
                tokenId: 1,
                userId: 1,
                profile: 'administrator',
                managerGrants: ['billable_rates_manager'],
                scopes: [
                  'projects:read',
                  'clients:read',
                  'time_entries:read',
                  'time_entries:write',
                  'invoices:read',
                  'invoices:write',
                  'expenses:read',
                  'expenses:write',
                  'reports:read',
                ],
              }
            }
            if (presented === noMoneyToken) {
              return {
                tokenId: 3,
                userId: 1,
                profile: 'member',
                scopes: [
                  'projects:read',
                  'time_entries:read',
                  'time_entries:write',
                ],
              }
            }
            return null
          },
          issue: async () => {
            throw new Error('not used')
          },
          list: async () => [],
          revoke: async () => null,
        },
      },
      installApi(api) {
        installGeneralResourceRoutes(api, {
          repository: general,
          cursorSigningKey: new Uint8Array(32).fill(7),
          clock: () => instant,
          isExpensesModuleEnabled: async () => true,
        })
        installTrackedResourceRoutes(api, {
          repository: tracked,
          cursorSigningKey: new Uint8Array(32).fill(7),
          clock: {
            now: () => ({
              instant,
              date: instant.slice(0, 10),
              time: instant.slice(11, 16),
            }),
          },
          isExpensesModuleEnabled: async () => true,
        })
        installReportRoutes(api, reports)
      },
    })
    const port = await new Promise<number>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0 }, (info) => resolve(info.port))
    })
    baseUrl = `http://127.0.0.1:${port}`
    directory = await mkdtemp(join(tmpdir(), 'ezacto-cli-money-e2e-'))

    fullConfigPath = join(directory, 'full', 'config.json')
    const fullLogin = await runEz(
      ['login', '--token-stdin', '--base-url', baseUrl, '--json'],
      fullConfigPath,
      fullToken,
    )
    expect(fullLogin.code, fullLogin.stderr).toBe(0)

    noMoneyConfigPath = join(directory, 'nomoney', 'config.json')
    const noMoneyLogin = await runEz(
      ['login', '--token-stdin', '--base-url', baseUrl, '--json'],
      noMoneyConfigPath,
      noMoneyToken,
    )
    expect(noMoneyLogin.code, noMoneyLogin.stderr).toBe(0)
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)))
    })
    sqlite.close()
    await rm(directory, { recursive: true, force: true })
  })

  it('[api] ez uninvoiced equals the API report to the cent', async () => {
    const apiResponse = await fetch(
      `${baseUrl}/api/v1/reports/uninvoiced?from=2026-08-01&to=2026-08-31`,
      { headers: { authorization: `Bearer ${fullToken}` } },
    )
    expect(apiResponse.status).toBe(200)
    const apiReport = (await apiResponse.json()) as { data: unknown }

    const cliResult = await runEz(
      ['uninvoiced', '--from', '2026-08-01', '--to', '2026-08-31', '--json'],
      fullConfigPath,
    )
    expect(cliResult.code, cliResult.stderr).toBe(0)
    const cliReport = JSON.parse(cliResult.stdout) as Record<string, unknown>

    expect(cliReport).toEqual(apiReport.data)
  })

  it('[unit] money verbs respect token scopes — reports:read required for uninvoiced', async () => {
    const result = await runEz(
      ['uninvoiced', '--from', '2026-08-01', '--to', '2026-08-31', '--json'],
      noMoneyConfigPath,
    )
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('API request failed')
  })

  it('[unit] ez uninvoiced shows human-readable output', async () => {
    const result = await runEz(
      ['uninvoiced', '--from', '2026-08-01', '--to', '2026-08-31'],
      fullConfigPath,
    )
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('uninvoiced 2026-08-01')
    expect(result.stdout).toContain('2026-08-31')
  })

  it('[unit] ez export time produces CSV output', async () => {
    const result = await runEz(
      ['export', 'time', '--from', '2026-08-01', '--to', '2026-08-31', '--csv'],
      fullConfigPath,
    )
    expect(result.code, result.stderr).toBe(0)
    const lines = result.stdout.trim().split('\n')
    expect(lines.length).toBeGreaterThanOrEqual(2)
    expect(lines[0]).toContain('id,user_id,project_id,task_id')
  })

  it('[unit] ez export expenses produces CSV header', async () => {
    const result = await runEz(
      ['export', 'expenses', '--from', '2026-08-01', '--to', '2026-08-31', '--csv'],
      fullConfigPath,
    )
    expect(result.code, result.stderr).toBe(0)
    const lines = result.stdout.trim().split('\n')
    expect(lines[0]).toContain('id,user_id,project_id')
  })

  it('[unit] unknown report definition is rejected', async () => {
    const result = await runEz(
      ['report', 'run', 'bogus', '--from', '2026-08-01', '--to', '2026-08-31'],
      fullConfigPath,
    )
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('unknown report: bogus')
  })

  it('[unit] missing --from/--to is rejected', async () => {
    const result = await runEz(
      ['uninvoiced'],
      fullConfigPath,
    )
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('--from and --to are required')
  })

  it('[unit] ez export requires a kind argument', async () => {
    const result = await runEz(
      ['export', '--from', '2026-08-01', '--to', '2026-08-31'],
      fullConfigPath,
    )
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('usage: ez export')
  })
})
