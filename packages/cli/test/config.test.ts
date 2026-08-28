import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CLI_CONFIG_VERSION,
  normalizeBaseUrl,
  parseConfig,
  readConfig,
  resolveConfigPath,
  tokenHint,
  writeConfig,
} from '../src/config.js'

const token = `ezacto_abcdefghijklmnop_${'A'.repeat(43)}`

describe('ez config', () => {
  let directory: string
  let path: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ezacto-cli-config-'))
    path = join(directory, 'nested', 'config.json')
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('[unit] writes canonical config atomically with private permissions', async () => {
    await writeConfig(path, {
      version: CLI_CONFIG_VERSION,
      active_organization: 'conflict',
      organizations: {
        conflict: {
          base_url: 'https://time.example.test/',
          token,
          user_id: 7,
          profile: 'administrator',
          scopes: ['time_entries:read'],
        },
      },
    })

    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(join(directory, 'nested'))).mode & 0o777).toBe(0o700)
    expect(await readConfig(path)).toMatchObject({
      active_organization: 'conflict',
      organizations: { conflict: { base_url: 'https://time.example.test' } },
    })
    expect((await readFile(path, 'utf8')).endsWith('\n')).toBe(true)
  })

  it('[security] never changes permissions on an existing custom config directory', async () => {
    await chmod(directory, 0o755)
    const customPath = join(directory, 'config.json')
    await writeConfig(customPath, {
      version: CLI_CONFIG_VERSION,
      active_organization: 'default',
      organizations: {
        default: {
          base_url: 'https://ezacto.io',
          token,
          user_id: 1,
          profile: 'member',
          scopes: ['projects:read'],
        },
      },
    })

    expect((await stat(directory)).mode & 0o777).toBe(0o755)
    expect((await stat(customPath)).mode & 0o777).toBe(0o600)
  })

  it('[unit] rejects malformed, insecure, and dangling organization config', () => {
    expect(() => normalizeBaseUrl('http://example.com')).toThrow(/https/)
    expect(() => normalizeBaseUrl('file:///tmp/api')).toThrow(/https/)
    expect(() =>
      parseConfig({
        version: 1,
        active_organization: 'missing',
        organizations: {},
      }),
    ).toThrow(/active organization/)
    expect(() =>
      parseConfig({
        version: 1,
        active_organization: 'default',
        organizations: {
          default: {
            base_url: 'https://ezacto.io',
            token: 'plaintext',
            user_id: 1,
            profile: 'member',
            scopes: [],
          },
        },
      }),
    ).toThrow(/canonical ezacto token/)
  })

  it('[unit] permits plain HTTP only for local development servers', () => {
    expect(normalizeBaseUrl('http://127.0.0.1:8787/')).toBe(
      'http://127.0.0.1:8787',
    )
    expect(normalizeBaseUrl('http://localhost:3000/api/')).toBe(
      'http://localhost:3000/api',
    )
  })

  it('[unit] resolves XDG and explicit config locations without exposing tokens', () => {
    expect(resolveConfigPath({ XDG_CONFIG_HOME: '/tmp/xdg' }, '/home/test')).toBe(
      '/tmp/xdg/ezacto/config.json',
    )
    expect(
      resolveConfigPath({ EZACTO_CONFIG: './custom.json' }, '/home/test'),
    ).toBe(join(process.cwd(), 'custom.json'))
    expect(tokenHint(token)).toBe('ezacto_abcdefghijklmnop_…')
    expect(tokenHint(token)).not.toContain('A'.repeat(10))
  })
})
