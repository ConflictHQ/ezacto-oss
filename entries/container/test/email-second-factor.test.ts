import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EmailMessage, HttpEmailProvider } from '@ezacto/mailer'
import { createApp } from '../../worker/src/app.js'
import type { ContainerConfig } from '../src/config.js'
import { createContainerRuntime } from '../src/runtime.js'
import {
  emailSecondFactorScenarios,
  type CodeMail,
  type Stack,
} from '../../worker/test/support/email-second-factor-scenarios.js'

const ownerEmail = 'owner@example.test'
const password = 'correct horse battery staple'
const origin = 'http://localhost:3000'

/**
 * The same scenarios the Worker runs against D1, here against the container's
 * better-sqlite3 file and the mail pipeline it ships: the code goes through the
 * real queued mailer to a capturing provider, so what is asserted about the
 * message is what an SMTP relay would have been handed.
 */
emailSecondFactorScenarios('container, SQLite', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ezacto-container-2fa-')))
  const config: ContainerConfig = {
    host: '127.0.0.1',
    port: 3000,
    trustedProxyHops: 0,
    dataDirectory: root,
    databasePath: join(root, 'db.sqlite'),
    attachmentDirectory: join(root, 'attachments'),
    brandDirectory: join(root, 'brand'),
    appBaseUrl: origin,
    cursorSigningKey: new Uint8Array(32).fill(0x43),
    quickBooks: { clientId: 'fixture-client-id', clientSecret: 'fixture-client-secret' },
    wise: { token: 'fixture-wise-token', webhookPublicKey: 'fixture-wise-key' },
    smtp: { url: 'smtp://127.0.0.1:2525', from: 'billing@example.test' },
    appEnv: { ENVIRONMENT: 'test-container', RELEASE: 'container-test', APP_BASE_URL: origin },
  }
  const captured: EmailMessage[] = []
  const provider: HttpEmailProvider = {
    name: 'smtp',
    async send(message, options) {
      captured.push(message)
      return { messageId: `<${options.idempotencyKey}@capture.test>`, latencyMs: 1 }
    },
  }
  const runtime = await createContainerRuntime(config, { emailProvider: provider })
  const app = createApp(runtime.services, runtime.brandAssets, runtime.instanceTheme)

  const request: Stack['request'] = (path, init = {}) => {
    const headers = new Headers(init.headers)
    if (init.method !== undefined && init.method !== 'GET') headers.set('origin', origin)
    return Promise.resolve(app.request(`${origin}${path}`, { ...init, headers }, config.appEnv))
  }
  // Delivery runs behind the queue, so settle before reading the provider.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60))

  const signup = await request('/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      organization_name: 'Container Studio',
      first_name: 'Avery',
      last_name: 'Ng',
      email: ownerEmail,
      password,
    }),
  })
  if (signup.status !== 202) throw new Error(`signup failed: ${signup.status}`)
  for (let attempt = 0; captured.length === 0 && attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const token = /ezacto_verify_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{43}/u.exec(captured[0]!.text)?.[0]
  const verified = await request('/auth/verify-email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  if (verified.status !== 200) throw new Error(`verify failed: ${verified.status}`)

  const stack: Stack = {
    ownerEmail,
    ownerPassword: password,
    request,
    codeMails: async () => {
      await settle()
      return captured
        .filter((message) => message.template === 'two_factor_email_code:v1')
        .map(
          (message): CodeMail => ({
            to: message.to[0]!.email,
            subject: message.subject,
            text: message.text,
            html: message.html ?? '',
          }),
        )
    },
    rows: async (sql, ...bindings) =>
      runtime.database.prepare(sql).all(...bindings) as Record<string, unknown>[],
    exec: async (sql, ...bindings) => {
      runtime.database.prepare(sql).run(...bindings)
    },
  }
  return {
    stack,
    close: async () => {
      await runtime.close()
      await rm(root, { recursive: true, force: true })
    },
  }
})
