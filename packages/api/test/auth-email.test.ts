import { expect, it, vi } from 'vitest'
import type { SenderBoundQueuedMailer } from '@ezacto/mailer'
import { createQueuedAuthMailer } from '../src/auth-email.js'

it.each(['password_reset', 'verify_email'] as const)('builds a private reset link while preserving the %s delivery contract', async kind => {
  const enqueue = vi.fn<SenderBoundQueuedMailer['enqueue']>()
  const mailer = createQueuedAuthMailer({ assertAvailable: async () => undefined, enqueue }, {
    getTemplate: async templateKind => ({ kind: templateKind, version: 1, subjectTemplate: 'Account access',
      textTemplate: '%action_url%', htmlTemplate: null, unknownVariablePolicy: 'error' }),
  }, async () => 'Example', 'https://workspace.example.test')
  const token = 'ezacto_reset_abcdefghijklmnop_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi1234567'
  await mailer.enqueue({ kind, token, to: 'member@example.test', expiresAt: '2026-10-08T20:00:00.000Z' })
  const message = enqueue.mock.calls[0]![0]
  const url = new URL(message.text)
  expect(url.origin).toBe('https://workspace.example.test')
  if (kind === 'password_reset') {
    expect(url.search).toBe('')
    expect(new URLSearchParams(url.hash.slice(1)).get('token')).toBe(token)
    expect(new URLSearchParams(url.hash.slice(1)).get('auth')).toBe('password-reset')
  } else {
    expect(url.hash).toBe('')
    expect(url.searchParams.get('auth')).toBe('verify-email')
    expect(url.searchParams.get('token')).toBe(token)
  }
})
