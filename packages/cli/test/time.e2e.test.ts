import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import type { ServerType } from '@hono/node-server'
import { serve } from '@hono/node-server'
import BetterSqlite3 from 'better-sqlite3'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApiApp, installGeneralResourceRoutes, installTrackedResourceRoutes } from '@ezacto/api'
import {
  createContainerDatabase,
  createGeneralResourceRepository,
  DrizzleTrackedResourceRepository,
  migrateContainer,
} from '../../db/src/index.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const token = `ezacto_abcdefghijklmnop_${'A'.repeat(43)}`
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

describe('ez time commands against the native API', () => {
  let server: ServerType
  let sqlite: BetterSqlite3.Database
  let directory: string
  let configPath: string
  let baseUrl: string
  let instant = `${spentDate}T08:00:00.000Z`

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
      ) VALUES (1, 'CLI', 'User', 'member', '[]', '${now}', '${now}');
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
    `)
    const database = createContainerDatabase(sqlite)
    const general = createGeneralResourceRepository(database)
    const tracked = new DrizzleTrackedResourceRepository(database, {
      isLocked: async () => false,
    })
    const app = createApiApp({
      authentication: {
        tokens: {
          authenticate: async (presented) =>
            presented === token
              ? {
                  tokenId: 1,
                  userId: 1,
                  profile: 'member',
                  scopes: [
                    'projects:read',
                    'time_entries:read',
                    'time_entries:write',
                  ],
                }
              : null,
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
        })
      },
    })
    const port = await new Promise<number>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0 }, (info) => resolve(info.port))
    })
    baseUrl = `http://127.0.0.1:${port}`
    directory = await mkdtemp(join(tmpdir(), 'ezacto-cli-time-e2e-'))
    configPath = join(directory, 'config', 'config.json')
    const login = await runEz(
      ['login', '--token-stdin', '--base-url', baseUrl, '--json'],
      configPath,
      token,
    )
    expect(login.code, login.stderr).toBe(0)
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)))
    })
    sqlite.close()
    await rm(directory, { recursive: true, force: true })
  })

  it('[e2e:cli-log] ez log writes an entry visible through the same native API', async () => {
    const logged = await runEz(
      [
        'log',
        '2h',
        'northpeak',
        'devops',
        '-m',
        'release work',
        '--date',
        spentDate,
        '--json',
      ],
      configPath,
    )
    expect(logged.code, logged.stderr).toBe(0)
    expect(JSON.parse(logged.stdout)).toMatchObject({
      project: 'North Peak',
      task: 'DevOps',
      seconds: 7200,
      notes: 'release work',
    })

    const response = await fetch(`${baseUrl}/api/v1/time-entries?spent_date=${spentDate}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      data: [{ seconds: 7200, notes: 'release work' }],
    })
  })

  it('[unit] timer start implicitly stops the previous timer and stop closes the current one', async () => {
    instant = `${spentDate}T09:00:00.000Z`
    const first = await runEz(
      ['timer', 'start', 'northpeak', 'devops', '-m', 'first', '--date', spentDate, '--json'],
      configPath,
    )
    expect(first.code, first.stderr).toBe(0)
    expect(JSON.parse(first.stdout)).toMatchObject({ is_running: true, notes: 'first' })

    instant = `${spentDate}T10:00:00.000Z`
    const second = await runEz(
      ['timer', 'start', 'northpeak', 'devops', '-m', 'second', '--date', spentDate, '--json'],
      configPath,
    )
    expect(second.code, second.stderr).toBe(0)
    expect(JSON.parse(second.stdout)).toMatchObject({ is_running: true, notes: 'second' })

    const status = await runEz(['timer', 'status', '--json'], configPath)
    expect(status.code, status.stderr).toBe(0)
    expect(JSON.parse(status.stdout)).toMatchObject({
      running: true,
      entry: { notes: 'second', project: 'North Peak', task: 'DevOps' },
    })

    const rows = sqlite
      .prepare('SELECT notes, seconds, timer_started_at FROM time_entries ORDER BY id')
      .all() as Array<{ notes: string; seconds: number; timer_started_at: string | null }>
    expect(rows).toEqual([
      { notes: 'release work', seconds: 7200, timer_started_at: null },
      { notes: 'first', seconds: 3600, timer_started_at: null },
      { notes: 'second', seconds: 0, timer_started_at: `${spentDate}T10:00:00.000Z` },
    ])

    instant = `${spentDate}T10:30:00.000Z`
    const stopped = await runEz(['timer', 'stop', '--json'], configPath)
    expect(stopped.code, stopped.stderr).toBe(0)
    expect(JSON.parse(stopped.stdout)).toMatchObject({
      is_running: false,
      notes: 'second',
      seconds: 1800,
    })
    const stoppedStatus = await runEz(['timer', 'status', '--json'], configPath)
    expect(JSON.parse(stoppedStatus.stdout)).toEqual({ running: false })
  })

  it('[e2e:cli-log] ez week renders the API entries as a terminal grid and JSON', async () => {
    const human = await runEz(['week', '--week', spentDate], configPath)
    expect(human.code, human.stderr).toBe(0)
    expect(human.stdout).toContain('week 2026-08-24 — 2026-08-30')
    expect(human.stdout).toContain('North Peak / DevOps')
    expect(human.stdout).toContain('Fri 28')
    expect(human.stdout).toContain('3:30')

    const machine = await runEz(['week', '--week', spentDate, '--json'], configPath)
    expect(machine.code, machine.stderr).toBe(0)
    expect(JSON.parse(machine.stdout)).toMatchObject({
      from: '2026-08-24',
      to: '2026-08-30',
      total_seconds: 12_600,
      rows: [{ project: 'North Peak', task: 'DevOps', total: 12_600 }],
    })
  })
})
