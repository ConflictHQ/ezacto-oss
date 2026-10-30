import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { EzactoApiError } from '@conflict-hq/ezacto-client'
import { errorMessage, runCli, type CliRuntime } from '../src/cli.js'
import { writeConfig } from '../src/config.js'

const directories: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})
const runtime = (configPath: string) => {
  const output: string[] = []
  const io: CliRuntime = {
    environment: { EZACTO_CONFIG: configPath },
    stdout: (line) => output.push(line),
    stderr: () => {},
    readStdin: async () => '',
  }
  return { io, output }
}

it('qualifies offline help and report inventory without discovering remote capabilities', async () => {
  const fetch = vi.fn(() => { throw new Error('offline inventory must not fetch') })
  vi.stubGlobal('fetch', fetch)
  const { io, output } = runtime('/unused-module-inventory/config.json')
  expect(await runCli(['--help'], io)).toBe(0)
  expect(output.join('\n')).toContain('offline inventories, not the connected instance')
  expect(output.join('\n')).toContain('signing in again cannot enable it')
  expect(output.join('\n')).toContain('do not use the server backup module')
  output.length = 0
  expect(await runCli(['report', 'list', '--json'], io)).toBe(0)
  expect(JSON.parse(output[0]!)).toContain('invoiced')
  expect(fetch).not.toHaveBeenCalled()
})

it('preserves an operator refusal without retrying or suggesting reauthentication', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ez-module-refusal-'))
  directories.push(directory)
  const configPath = join(directory, 'config.json')
  await writeConfig(configPath, {
    version: 1,
    active_organization: 'fixture',
    organizations: { fixture: {
      base_url: 'https://fixture.invalid',
      token: `ezacto_abcdefghijklmnop_${'A'.repeat(43)}`,
      user_id: 1,
      profile: 'administrator',
      scopes: ['invoices:read'],
    } },
  })
  const message = 'The invoices module is switched off by the operator of this instance.'
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    expect(String(input)).toContain('/api/v1/invoices')
    return new Response(JSON.stringify({ error: { code: 'module_disabled', message } }), {
    status: 403,
    headers: { 'content-type': 'application/json', 'x-request-id': 'module-refusal-fixture' },
    })
  })
  vi.stubGlobal('fetch', fetch)
  const { io, output } = runtime(configPath)
  const error: unknown = await runCli(['invoice', 'list', '--json'], io).catch((failure: unknown) => failure)
  expect(error).toBeInstanceOf(EzactoApiError)
  expect(error).toMatchObject({ status: 403, requestId: 'module-refusal-fixture', body: { error: { code: 'module_disabled' } } })
  expect(errorMessage(error)).toContain(message)
  expect(errorMessage(error)).not.toMatch(/login|scope|connect/)
  expect(output).toEqual([])
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(String(fetch.mock.calls[0]![0])).toContain('/api/v1/invoices')
})
