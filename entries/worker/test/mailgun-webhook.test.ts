import { createHmac } from 'node:crypto'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type WorkerEnv } from '../src/app.js'
import { isServicePath } from '../src/data-request.js'
import { createRuntimeServices } from '../src/runtime.js'

// A made-up key for this file only.
const fixtureKey = 'fixture-mailgun-webhook-key-for-tests'

const signedPost = (key: string): string => {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const token = 'token-worker-test'
  return JSON.stringify({
    signature: {
      timestamp,
      token,
      signature: createHmac('sha256', key).update(timestamp + token).digest('hex'),
    },
    'event-data': {
      id: 'evt-worker-test',
      event: 'failed',
      severity: 'permanent',
      recipient: 'owner@example.test',
      message: { headers: { 'message-id': 'not-one-of-ours' } },
    },
  })
}

describe('Worker Mailgun feedback webhook', () => {
  let miniflare: Miniflare
  let env: WorkerEnv
  let unconfigured: ReturnType<typeof createApp>
  let configured: ReturnType<typeof createApp>

  beforeAll(async () => {
    miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: ['DB'],
    })
    env = {
      DB: await miniflare.getD1Database('DB'),
      API_CURSOR_SIGNING_KEY: 'A'.repeat(43),
      ENVIRONMENT: 'test',
      RELEASE: 'mailgun-webhook-test',
      APP_BASE_URL: 'https://app.example.test',
    }
    unconfigured = createApp(await createRuntimeServices(env))
    configured = createApp(
      await createRuntimeServices({ ...env, MAILGUN_WEBHOOK_SIGNING_KEY: fixtureKey }),
    )
  })

  afterAll(async () => miniflare.dispose())

  const post = (app: ReturnType<typeof createApp>, body: string) =>
    app.request(
      'https://app.example.test/webhooks/mailgun',
      { method: 'POST', body },
      env,
    )

  it('[security] is served by the services app, outside the session surface', () => {
    expect(isServicePath('/webhooks/mailgun')).toBe(true)
  })

  it('[security] is not mounted without a signing key, so a signed or unsigned post is a 404', async () => {
    expect((await post(unconfigured, signedPost(fixtureKey))).status).toBe(404)
    expect((await post(unconfigured, '{}')).status).toBe(404)
  })

  it('[security] refuses a post signed with another key and accepts one signed with ours', async () => {
    expect((await post(configured, signedPost('some-other-key'))).status).toBe(401)
    expect((await post(configured, '{"event-data":{"event":"failed"}}')).status).toBe(401)
    // Ours, for a message that is not: acknowledged so Mailgun stops retrying.
    expect((await post(configured, signedPost(fixtureKey))).status).toBe(200)
  })
})
