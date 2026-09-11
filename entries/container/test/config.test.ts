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
      [...readme.matchAll(/^([A-Z_]+)=/gmu)].map((match) => match[1]!),
    )

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
      'utf8',
    )
    const targets = [...readme.matchAll(/\]\((\.\.[^)]+\.md)\)/gu)].map((match) => match[1]!)
    expect(targets.length).toBeGreaterThan(0)
    for (const target of targets) {
      const resolved = `${root}${target.replace(/^\.\.\/\.\.\//u, '')}`
      await expect(readFile(resolved, 'utf8')).resolves.toBeTruthy()
    }
  })
})
