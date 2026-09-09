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
  createTeamRepository,
  DrizzleTrackedResourceRepository,
  migrateContainer,
} from '../../db/src/index.js'
import { withoutConfidentialFields } from '../src/money.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const fullToken = `ezacto_abcdefghijklmnop_${'A'.repeat(43)}`
const noMoneyToken = `ezacto_abcdefghijklmnop_${'C'.repeat(43)}`
const packageDirectory = fileURLToPath(new URL('..', import.meta.url))
const cliPath = join(packageDirectory, 'dist', 'cli.js')
const spentDate = '2026-08-28'
// The seeded entry is priced on both axes so the redaction tests have something
// real to leak: an administrator token gets both rates back from the API.
const billableRateCents = 18500
const costRateCents = 7300
// 2h at the seeded cost rate. The same number is the client-rollup's cost_cents
// and budget_burn_cents and the project-budget grain's spent_cents, so one
// string proves whether our cost base reached any of those renderings.
const costBaseCents = (7200 / 3600) * costRateCents
const costBudgetCents = 500000

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
      INSERT INTO projects (
        id, client_id, name, code, budget_by, cost_budget_cents,
        created_at, updated_at
      ) VALUES (
        1, 1, 'North Peak', 'northpeak', 'project_cost', ${costBudgetCents},
        '${now}', '${now}'
      );
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
        budgeted, approval_status, billable_rate_cents, cost_rate_cents,
        created_at, updated_at
      ) VALUES (
        1, 1, 1, 1, 1, 1,
        '${spentDate}', 7200, 7200, 7200, 1,
        1, 'unsubmitted', ${billableRateCents}, ${costRateCents}, '${now}', '${now}'
      );
    `)
    const database = createContainerDatabase(sqlite)
    const general = createGeneralResourceRepository(database)
    const team = createTeamRepository(database)
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
          teamRepository: team,
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

  it('[e2e:money-redaction] the rates the API returns never reach the export', async () => {
    // The premise first: for this token the rates really are in the payload the
    // CLI reads, so their absence downstream is redaction and not an empty seed.
    const apiResponse = await fetch(
      `${baseUrl}/api/v1/time-entries?from=2026-08-01&to=2026-08-31`,
      { headers: { authorization: `Bearer ${fullToken}` } },
    )
    expect(apiResponse.status).toBe(200)
    const apiPage = (await apiResponse.json()) as {
      data: Array<Record<string, unknown>>
    }
    expect(apiPage.data[0]?.cost_rate_cents).toBe(costRateCents)
    expect(apiPage.data[0]?.billable_rate_cents).toBe(billableRateCents)

    for (const flag of ['--json', '--csv']) {
      const result = await runEz(
        ['export', 'time', '--from', '2026-08-01', '--to', '2026-08-31', flag],
        fullConfigPath,
      )
      expect(result.code, result.stderr).toBe(0)
      expect(result.stdout).not.toContain('cost_rate_cents')
      expect(result.stdout).not.toContain('billable_rate_cents')
      expect(result.stdout).not.toContain(String(costRateCents))
      expect(result.stdout).not.toContain(String(billableRateCents))
    }

    const jsonResult = await runEz(
      ['export', 'time', '--from', '2026-08-01', '--to', '2026-08-31', '--json'],
      fullConfigPath,
    )
    const rows = JSON.parse(jsonResult.stdout) as Array<Record<string, unknown>>
    expect(rows.length).toBeGreaterThan(0)
    expect(Object.keys(rows[0]!)).toEqual([
      'id', 'user_id', 'project_id', 'task_id', 'spent_date',
      'seconds', 'billable', 'notes',
    ])
  })

  it('[e2e:money-redaction] ez report run client-rollup never prints our cost base', async () => {
    // The premise: this token really does get the cost fields back, so their
    // absence downstream is the filter and not an empty report.
    const apiResponse = await fetch(
      `${baseUrl}/api/v1/reports/client-rollups/1?from=2026-08-01&to=2026-08-31`,
      { headers: { authorization: `Bearer ${fullToken}` } },
    )
    expect(apiResponse.status).toBe(200)
    const apiReport = (await apiResponse.json()) as {
      data: {
        nodes: Array<{
          budget_burn_cents?: number
          rollup: { currencies: Array<{ cost_cents?: number }> }
        }>
      }
    }
    expect(apiReport.data.nodes[0]?.budget_burn_cents).toBe(costBaseCents)
    expect(apiReport.data.nodes[0]?.rollup.currencies[0]?.cost_cents).toBe(costBaseCents)

    for (const flag of ['--json', '--csv', '--human']) {
      const result = await runEz(
        [
          'report', 'run', 'client-rollup', '--client', '1',
          '--from', '2026-08-01', '--to', '2026-08-31',
          ...(flag === '--human' ? [] : [flag]),
        ],
        fullConfigPath,
      )
      expect(result.code, result.stderr).toBe(0)
      // The report still says something — an empty stdout would pass the
      // absence checks below for the wrong reason.
      expect(result.stdout.length).toBeGreaterThan(0)
      expect(result.stdout).not.toContain('cost_cents')
      expect(result.stdout).not.toContain('budget_burn_cents')
      expect(result.stdout).not.toContain(String(costBaseCents))
    }

    const jsonResult = await runEz(
      [
        'report', 'run', 'client-rollup', '--client', '1',
        '--from', '2026-08-01', '--to', '2026-08-31', '--json',
      ],
      fullConfigPath,
    )
    const report = JSON.parse(jsonResult.stdout) as {
      nodes: Array<Record<string, unknown> & {
        rollup: { currencies: Array<Record<string, unknown>> }
      }>
    }
    // The node survives with its non-confidential shape intact: this is a
    // filter, not a refusal to run the report.
    expect(report.nodes.length).toBeGreaterThan(0)
    expect(report.nodes[0]!['client_id']).toBe(1)
    expect(Object.keys(report.nodes[0]!)).not.toContain('budget_burn_cents')
    expect(report.nodes[0]!.rollup.currencies.length).toBeGreaterThan(0)
    expect(Object.keys(report.nodes[0]!.rollup.currencies[0]!)).not.toContain('cost_cents')
  })

  it('[e2e:money-redaction] ez report run project-budget withholds a cost spend rather than zeroing it', async () => {
    const apiResponse = await fetch(
      `${baseUrl}/api/v1/reports/project-budget/1?from=2026-08-01&to=2026-08-31`,
      { headers: { authorization: `Bearer ${fullToken}` } },
    )
    expect(apiResponse.status).toBe(200)
    const apiReport = (await apiResponse.json()) as {
      data: {
        grains: Array<{
          calculation: string
          budget_cents?: number
          spent_cents?: number
          remaining_cents?: number | null
        }>
      }
    }
    // A cost-calculated grain: spent_cents here is hours x our cost rate, and
    // remaining_cents gives it back by subtraction from a budget we do print.
    expect(apiReport.data.grains[0]?.calculation).toBe('cost')
    expect(apiReport.data.grains[0]?.spent_cents).toBe(costBaseCents)
    expect(apiReport.data.grains[0]?.remaining_cents).toBe(costBudgetCents - costBaseCents)

    for (const flag of ['--json', '--csv', '--human']) {
      const result = await runEz(
        [
          'report', 'run', 'project-budget', '--project', 'northpeak',
          '--from', '2026-08-01', '--to', '2026-08-31',
          ...(flag === '--human' ? [] : [flag]),
        ],
        fullConfigPath,
      )
      expect(result.code, result.stderr).toBe(0)
      expect(result.stdout.length).toBeGreaterThan(0)
      expect(result.stdout).not.toContain(String(costBaseCents))
      expect(result.stdout).not.toContain(String(costBudgetCents - costBaseCents))
      expect(result.stdout).not.toContain('146.00')
    }

    // Withheld, not zeroed: a 0 in the spent column is a number we are
    // refusing to state, and a reader cannot tell it from a project nobody
    // has worked on.
    const csvResult = await runEz(
      [
        'report', 'run', 'project-budget', '--project', 'northpeak',
        '--from', '2026-08-01', '--to', '2026-08-31', '--csv',
      ],
      fullConfigPath,
    )
    const csvLines = csvResult.stdout.trim().split('\n')
    expect(csvLines[0]).toBe(
      'source,source_id,unit,calculation,budget,spent,remaining,unpriced_entry_count',
    )
    expect(csvLines[1]).toBe(`project,1,cents,cost,${costBudgetCents},,,0`)
  })

  it('[e2e:money-redaction] the budget summary beside that report is filtered too', async () => {
    // No CLI verb reads this endpoint yet. The filter sits on the client's
    // fetch rather than in a verb's output precisely so the answer is already
    // decided when somebody writes one, so it is asserted against the payload
    // the serializer really emits. The premise first: this row carries the same
    // cost base as the grain, and names no `calculation` to read it off.
    const apiResponse = await fetch(
      `${baseUrl}/api/v1/reports/project-budgets?from=2026-08-01&to=2026-08-31`,
      { headers: { authorization: `Bearer ${fullToken}` } },
    )
    expect(apiResponse.status).toBe(200)
    const apiReport = (await apiResponse.json()) as {
      data: Array<Record<string, unknown>>
    }
    const summary = apiReport.data[0]!
    expect(summary['project_id']).toBe(1)
    expect(summary['budget_by']).toBe('project_cost')
    expect(Object.keys(summary)).not.toContain('calculation')
    expect(summary['spent_cents']).toBe(costBaseCents)
    expect(summary['remaining_cents']).toBe(costBudgetCents - costBaseCents)

    const filtered = withoutConfidentialFields(apiReport) as {
      data: Array<Record<string, unknown>>
    }
    // The row survives with its non-confidential shape intact: a filter, not a
    // refusal to report the project.
    expect(filtered.data.length).toBe(apiReport.data.length)
    expect(filtered.data[0]!['project_id']).toBe(1)
    expect(filtered.data[0]!['budget_cents']).toBe(costBudgetCents)
    for (const withheld of ['spent_cents', 'remaining_cents', 'cost_cents']) {
      expect(Object.keys(filtered.data[0]!)).not.toContain(withheld)
    }
  })

  it('[e2e:money-redaction] ez week hides the rates every other time verb carries too', async () => {
    const apiResponse = await fetch(
      `${baseUrl}/api/v1/time-entries?from=2026-08-24&to=2026-08-30`,
      { headers: { authorization: `Bearer ${fullToken}` } },
    )
    expect(apiResponse.status).toBe(200)
    const apiPage = (await apiResponse.json()) as {
      data: Array<Record<string, unknown>>
    }
    expect(apiPage.data[0]?.cost_rate_cents).toBe(costRateCents)
    expect(apiPage.data[0]?.billable_rate_cents).toBe(billableRateCents)

    const result = await runEz(
      ['week', '--week', spentDate, '--json'],
      fullConfigPath,
    )
    expect(result.code, result.stderr).toBe(0)
    const week = JSON.parse(result.stdout) as {
      entries: Array<Record<string, unknown>>
      total_seconds: number
    }
    // The grid is populated, so the entry really did pass through the CLI.
    expect(week.entries.length).toBeGreaterThan(0)
    expect(week.total_seconds).toBe(7200)
    expect(week.entries[0]!['id']).toBe(1)
    expect(Object.keys(week.entries[0]!)).not.toContain('cost_rate_cents')
    expect(Object.keys(week.entries[0]!)).not.toContain('billable_rate_cents')
    expect(result.stdout).not.toContain(String(costRateCents))
    expect(result.stdout).not.toContain(String(billableRateCents))
  })

  it('[unit] an unknown --columns name is refused, not dropped', async () => {
    const result = await runEz(
      [
        'export', 'time', '--from', '2026-08-01', '--to', '2026-08-31',
        '--csv', '--columns', 'id,bogus,notes',
      ],
      fullConfigPath,
    )
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('unknown time export column: bogus')
    // Refused, so nothing was exported at all — not "exported without bogus".
    expect(result.stdout).toBe('')
  })

  it('[unit] a confidential column is refused for being confidential', async () => {
    const result = await runEz(
      [
        'export', 'time', '--from', '2026-08-01', '--to', '2026-08-31',
        '--csv', '--columns', 'id,cost_rate_cents',
      ],
      fullConfigPath,
    )
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(
      'time export column is confidential and cannot be exported: cost_rate_cents',
    )
    expect(result.stderr).not.toContain('unknown')
    expect(result.stdout).toBe('')
  })

  it('[unit] --columns chooses the columns and their order', async () => {
    const result = await runEz(
      [
        'export', 'time', '--from', '2026-08-01', '--to', '2026-08-31',
        '--csv', '--columns', 'notes,spent_date,id',
      ],
      fullConfigPath,
    )
    expect(result.code, result.stderr).toBe(0)
    const lines = result.stdout.trim().split('\n')
    expect(lines[0]).toBe('notes,spent_date,id')
    expect(lines[1]).toBe(`,${spentDate},1`)
  })

  it('[unit] a repeated --columns name is refused', async () => {
    const result = await runEz(
      [
        'export', 'time', '--from', '2026-08-01', '--to', '2026-08-31',
        '--csv', '--columns', 'id,id',
      ],
      fullConfigPath,
    )
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('duplicate time export column: id')
  })

  it('[unit] --columns is rejected outside ez export', async () => {
    const result = await runEz(
      ['uninvoiced', '--from', '2026-08-01', '--to', '2026-08-31', '--columns', 'id'],
      fullConfigPath,
    )
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('--columns is valid only with ez export')
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
