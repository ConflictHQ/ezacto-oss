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
