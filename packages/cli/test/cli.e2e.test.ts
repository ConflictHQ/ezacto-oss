import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve, type ServerType } from '@hono/node-server'
import { createApiApp, type ApiTokenService } from '@ezacto/api'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const token = `ezacto_abcdefghijklmnop_${'A'.repeat(43)}`
const packageDirectory = fileURLToPath(new URL('..', import.meta.url))
const cliPath = join(packageDirectory, 'dist', 'cli.js')

const tokens: ApiTokenService = {
  authenticate: async (presented) =>
    presented === token
      ? {
          tokenId: 9,
          userId: 42,
          profile: 'administrator',
          managerGrants: ['billable_rates_manager'],
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
}

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
    child.once('close', (code) =>
      resolve({ code: code ?? 1, stdout, stderr }),
    )
    child.stdin.end(stdin)
  })

describe('ez CLI dev-server round trip', () => {
  let server: ServerType
  let baseUrl: string
  let directory: string
  let configPath: string

  beforeAll(async () => {
    const app = createApiApp({ authentication: { tokens } })
    const port = await new Promise<number>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0 }, (info) => resolve(info.port))
    })
    baseUrl = `http://127.0.0.1:${port}`
    directory = await mkdtemp(join(tmpdir(), 'ezacto-cli-e2e-'))
    configPath = join(directory, 'config', 'config.json')
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)))
    })
    await rm(directory, { recursive: true, force: true })
  })

  it('[e2e:cli-log] login validates and stores a token, then whoami reuses it', async () => {
    const loggedIn = await runEz(
      ['login', '--token-stdin', '--base-url', baseUrl, '--org', 'conflict', '--json'],
      configPath,
      `${token}\n`,
    )
    expect(loggedIn.code, loggedIn.stderr).toBe(0)
    const loginOutput = JSON.parse(loggedIn.stdout) as Record<string, unknown>
    expect(loginOutput).toMatchObject({
      organization: 'conflict',
      base_url: baseUrl,
      user_id: 42,
      profile: 'administrator',
      authentication: {
        kind: 'token',
        token_id: 9,
        scopes: ['projects:read', 'time_entries:read', 'time_entries:write'],
      },
    })
    expect(loggedIn.stdout).not.toContain(token)
    expect((await stat(configPath)).mode & 0o777).toBe(0o600)
    expect(await readFile(configPath, 'utf8')).toContain(token)

    const identity = await runEz(['whoami', '--json'], configPath)
    expect(identity.code, identity.stderr).toBe(0)
    expect(JSON.parse(identity.stdout)).toEqual(loginOutput)
    expect(identity.stdout).not.toContain(token)

    const human = await runEz(['whoami'], configPath)
    expect(human.code, human.stderr).toBe(0)
    expect(human.stdout).toContain('organization: conflict')
    expect(human.stdout).toContain('user:         42')
    expect(human.stdout).toContain('time_entries:write')
    expect(human.stdout).not.toContain(token)

    const shown = await runEz(['config', '--json'], configPath)
    expect(shown.code, shown.stderr).toBe(0)
    expect(shown.stdout).toContain('ezacto_abcdefghijklmnop_…')
    expect(shown.stdout).not.toContain(token)
  })

  it('[e2e:cli-log] rejects a bad credential without overwriting config', async () => {
    const before = await readFile(configPath, 'utf8')
    const badToken = `ezacto_abcdefghijklmnop_${'B'.repeat(43)}`
    const rejected = await runEz(
      ['login', '--token-stdin', '--base-url', baseUrl, '--json'],
      configPath,
      badToken,
    )
    expect(rejected.code).toBe(1)
    expect(JSON.parse(rejected.stderr)).toEqual({
      error: {
        message: 'authentication failed: the API token is invalid or revoked',
      },
    })
    expect(rejected.stderr).not.toContain(badToken)
    expect(await readFile(configPath, 'utf8')).toBe(before)
  })

  it('[e2e:cli-log] logout removes the final organization credential', async () => {
    const result = await runEz(['logout', '--json'], configPath)
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      logged_out: true,
      organization: 'conflict',
    })
    await expect(readFile(configPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})
