import { Miniflare } from 'miniflare'
import type { SenderBoundQueuedMailer } from '@ezacto/mailer'
import { createQueuedTwoFactorEmailCodeMailer, type AuthDelivery } from '@ezacto/api'
import { createApp, type WorkerEnv } from '../src/app.js'
import { createRuntimeServices } from '../src/runtime.js'
import {
  emailSecondFactorScenarios,
  type CodeMail,
  type Stack,
} from './support/email-second-factor-scenarios.js'

const cursorKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const password = 'correct horse battery staple 🙂'
const ownerEmail = 'owner@example.test'

emailSecondFactorScenarios('Worker, D1', async () => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const database = await miniflare.getD1Database('DB')
  const env = {
    DB: database,
    API_CURSOR_SIGNING_KEY: cursorKey,
    ENVIRONMENT: 'test',
    RELEASE: 'email-second-factor-test',
  } satisfies WorkerEnv
  const services = await createRuntimeServices(env)
  const deliveries: AuthDelivery[] = []
  const mails: CodeMail[] = []
  // The real composer, behind a mailer that captures instead of queueing.
  const capture = {
    enqueue: async (message: Parameters<SenderBoundQueuedMailer['enqueue']>[0]) => {
      mails.push({
        to: message.to[0]!.email,
        subject: message.subject,
        text: message.text,
        html: message.html ?? '',
      })
      return undefined as never
    },
  } as unknown as SenderBoundQueuedMailer
  const app = createApp({
    ...services,
    deploymentAuthMailer: {
      assertAvailable: async () => undefined,
      enqueue: async (delivery) => void deliveries.push(delivery),
    },
    twoFactorEmailCodes: createQueuedTwoFactorEmailCodeMailer(capture, async () => 'Halcyon Studio'),
  })

  const request: Stack['request'] = (path, init = {}) => {
    const headers = new Headers(init.headers)
    headers.set('cf-connecting-ip', '198.51.100.20')
    // The same-origin header the session routes require on a mutation.
    if (init.method !== undefined && init.method !== 'GET') headers.set('origin', 'http://localhost')
    return Promise.resolve(app.request(path, { ...init, headers }, env))
  }

  const signup = await request('/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      organization_name: 'Halcyon Studio',
      first_name: 'Avery',
      last_name: 'Ng',
      email: ownerEmail,
      password,
    }),
  })
  if (signup.status !== 202) throw new Error(`signup failed: ${signup.status}`)
  const verified = await request('/auth/verify-email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: deliveries[0]!.token }),
  })
  if (verified.status !== 200) throw new Error(`verify failed: ${verified.status}`)

  const stack: Stack = {
    ownerEmail,
    ownerPassword: password,
    request,
    codeMails: async () => [...mails],
    rows: async (sql, ...bindings) =>
      (
        await database
          .prepare(sql)
          .bind(...bindings)
          .all<Record<string, unknown>>()
      ).results,
    exec: async (sql, ...bindings) => {
      await database
        .prepare(sql)
        .bind(...bindings)
        .run()
    },
  }
  return { stack, close: () => miniflare.dispose() }
})
