import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readContainerConfig } from '../src/config.js'

const key = Buffer.alloc(32, 0x42).toString('base64url')

const valid = (): NodeJS.ProcessEnv => ({
  APP_BASE_URL: 'https://time.example.test',
  API_CURSOR_SIGNING_KEY: key,
  SMTP_URL: 'smtps://operator:secret@smtp.example.test:465',
  SMTP_FROM: 'Ezacto <billing@example.test>',
})

describe('container configuration', () => {
  it('keeps GitHub App credentials separate from page configuration and validates complete custody', () => {
    const privateKey = '-----BEGIN PRIVATE KEY-----\nZmFrZQ==\n-----END PRIVATE KEY-----'
    const config = readContainerConfig({
      ...valid(),
      GITHUB_APP_ID: '123',
      GITHUB_APP_PRIVATE_KEY: privateKey,
      GITHUB_APP_WEBHOOK_SECRET: 'fixture-hook-secret',
      GITHUB_APP_ENCRYPTION_KEY: key,
    })
    expect(config.githubReader).toEqual({
      appId: '123',
      privateKey,
      webhookSecret: 'fixture-hook-secret',
    })
    expect(config.githubAppEncryptionKey).toBe(key)
    for (const field of [
      'GITHUB_APP_ID',
      'GITHUB_APP_PRIVATE_KEY',
      'GITHUB_APP_WEBHOOK_SECRET',
      'GITHUB_APP_ENCRYPTION_KEY',
    ])
      expect(config.appEnv).not.toHaveProperty(field)
    expect(() => readContainerConfig({ ...valid(), GITHUB_APP_ID: '123' })).toThrow(
      'configured together',
    )
    expect(() =>
      readContainerConfig({
        ...valid(),
        GITHUB_APP_PRIVATE_KEY: 'not a private key',
      }),
    ).toThrow('PEM private key')
  })
  it('[unit] resolves the stable volume contract without exposing SMTP credentials', () => {
    const config = readContainerConfig(valid())
    expect(config).toMatchObject({
      host: '0.0.0.0',
      port: 3000,
      dataDirectory: '/data',
      databasePath: '/data/db.sqlite',
      attachmentDirectory: '/data/attachments',
      appBaseUrl: 'https://time.example.test',
      appEnv: { ENVIRONMENT: 'container', RELEASE: 'container' },
    })
    expect(config.cursorSigningKey).toEqual(new Uint8Array(32).fill(0x42))
    expect(config.appEnv).not.toHaveProperty('SMTP_URL')
  })

  it('[unit] ACCOUNTING_ENABLED=false withholds QuickBooks and an invalid value refuses to start (#1217)', () => {
    const keys = { QUICKBOOKS_CLIENT_ID: 'id', QUICKBOOKS_CLIENT_SECRET: 'secret' }
    expect(readContainerConfig({ ...valid(), ...keys }).quickBooks).toBeDefined()
    const off = readContainerConfig({ ...valid(), ...keys, ACCOUNTING_ENABLED: 'false' })
    expect(off.quickBooks).toBeUndefined()
    expect(off.appEnv.ACCOUNTING_ENABLED).toBe('false')
    expect(() => readContainerConfig({ ...valid(), ...keys, ACCOUNTING_ENABLED: 'off' })).toThrow(
      /ACCOUNTING_ENABLED/,
    )
  })

  it('[unit] carries every operator module switch and refuses a bad one at start-up (issue 1254)', () => {
    const flags = { SSO_ENABLED: 'false', BACKUPS_ENABLED: 'false', INVOICES_ENABLED: 'false', ACCOUNTING_ENABLED: 'true',
    }
    expect(readContainerConfig({ ...valid(), ...flags }).appEnv).toMatchObject(flags)
    expect(readContainerConfig(valid()).appEnv).not.toHaveProperty('SSO_ENABLED')
    for (const name of Object.keys(flags)) {
      for (const bad of ['off', 'TRUE', '1']) {
        expect(() => readContainerConfig({ ...valid(), [name]: bad })).toThrow(new RegExp(name))
      }
    }
  })

  it('[unit] keeps Deel staging credentials private and independent of the QuickBooks switch', () => {
    const config = readContainerConfig({...valid(),DEEL_TOKEN:'owned-fixture-token',DEEL_SYNC_START_DATE:'2026-10-01',ACCOUNTING_ENABLED:'false',
    })
    expect(config.deel).toEqual({token:'owned-fixture-token',startDate:'2026-10-01'})
    expect(config.appEnv).not.toHaveProperty('DEEL_TOKEN')
    expect(config.appEnv).not.toHaveProperty('DEEL_SYNC_START_DATE')
    expect(readContainerConfig(valid()).deel).toBeUndefined()
  })

  it('[unit] reads how often a signed-in request records last-seen (#951)', () => {
    expect(readContainerConfig(valid()).lastSeenIntervalMs).toBe(300_000)
    expect(
      readContainerConfig({ ...valid(), LAST_SEEN_INTERVAL_SECONDS: '0' }).lastSeenIntervalMs,
    ).toBe(0)
    expect(
      readContainerConfig({ ...valid(), LAST_SEEN_INTERVAL_SECONDS: '900' }).lastSeenIntervalMs,
    ).toBe(900_000)
  })

  it('[unit] permits explicit localhost HTTP for a direct self-host development run', () => {
    const config = readContainerConfig({
      ...valid(),
      APP_BASE_URL: 'http://localhost:8787',
      EZACTO_DATA_DIR: '/tmp/ezacto-container-test',
      PORT: '8787',
    })
    expect(config.appBaseUrl).toBe('http://localhost:8787')
    expect(config.databasePath).toBe('/tmp/ezacto-container-test/db.sqlite')
    expect(config.port).toBe(8787)
  })

  it.each([
    ['missing cursor key', { API_CURSOR_SIGNING_KEY: undefined }],
    ['short cursor key', { API_CURSOR_SIGNING_KEY: 'AAAA' }],
    ['missing SMTP URL', { SMTP_URL: undefined }],
    ['missing SMTP sender', { SMTP_FROM: undefined }],
    ['public cleartext URL', { APP_BASE_URL: 'http://time.example.test' }],
    ['URL credentials', { APP_BASE_URL: 'https://user:secret@time.example.test' }],
    ['URL path', { APP_BASE_URL: 'https://time.example.test/app' }],
    ['relative data path', { EZACTO_DATA_DIR: 'data' }],
    ['root data path', { EZACTO_DATA_DIR: '/' }],
    ['invalid port', { PORT: '65536' }],
    ['malformed last-seen interval', { LAST_SEEN_INTERVAL_SECONDS: '5m' }],
    ['last-seen interval over an hour', { LAST_SEEN_INTERVAL_SECONDS: '3601' }],
  ])('[security] fails closed for %s', (_name, override) => {
    expect(() => readContainerConfig({ ...valid(), ...override })).toThrow()
  })
})

describe('the operator guide and the config it describes', () => {
  it('[unit] documents exactly the environment the container refuses to start without', async () => {
    // A self-hoster has the README and nothing else. A variable the container
    // requires and the README omits is a container that will not start for a
    // reason the operator cannot see; one the README requires and the container
    // ignores is a false demand, and either way the document is wrong.
    //
    // This is the same failure that shipped in RESTORE.md, where the documented
    // restore command named a flag the CLI rejects: the guide was asserted to
    // exist and never compared against the thing it describes (issue 99).
    const root = fileURLToPath(new URL('..', import.meta.url))
    const [source, readme] = await Promise.all([
      readFile(`${root}src/config.ts`, 'utf8'),
      readFile(`${root}README.md`, 'utf8'),
    ])

    const enforced = new Set(
      [...source.matchAll(/required\(environment, '([A-Z_]+)'/gu)].map((match) => match[1]!),
    )
    const documented = new Set(
      [...readme.matchAll(/^([A-Z_]+)=/gmu)].map((match) => match[1]!))

    // Counted before they are compared, so two empty sets cannot agree.
    expect(enforced.size).toBeGreaterThan(0)
    expect([...documented].sort()).toEqual([...enforced].sort())
  })

  it('[unit] the links the README offers an operator resolve', async () => {
    // Both are the guide's answer to "what do I do when this goes wrong", and a
    // dead link is that answer missing.
    const root = fileURLToPath(new URL('../../../', import.meta.url))
    const readme = await readFile(
      fileURLToPath(new URL('../README.md', import.meta.url)),
      'utf8')
    const targets = [...readme.matchAll(/\]\((\.\.[^)]+\.md)\)/gu)].map((match) => match[1]!)
    expect(targets.length).toBeGreaterThan(0)
    for (const target of targets) {
      const resolved = `${root}${target.replace(/^\.\.\/\.\.\//u, '')}`
      await expect(readFile(resolved, 'utf8')).resolves.toBeTruthy()
    }
  })
})
