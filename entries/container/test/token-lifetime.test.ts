import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { EmailMessage, HttpEmailProvider } from '@ezacto/mailer'
import { createApp } from '../../worker/src/app.js'
import type { ContainerConfig } from '../src/config.js'
import { createContainerRuntime } from '../src/runtime.js'

/**
 * Issue 599: the one-year maximum on self-service API tokens, over the
 * container runtime and a real migrated SQLite file. The Worker has the twin.
 */

const day = 86_400_000
const password = 'correct horse battery staple'
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const config = async (): Promise<ContainerConfig> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ezacto-token-lifetime-')))
  roots.push(root)
  return {
    host: '127.0.0.1',
    port: 3000,
    trustedProxyHops: 0,
    dataDirectory: root,
    databasePath: join(root, 'db.sqlite'),
    attachmentDirectory: join(root, 'attachments'),
    brandDirectory: join(root, 'brand'),
    appBaseUrl: 'http://localhost:3000',
    cursorSigningKey: new Uint8Array(32).fill(0x43),
    smtp: { url: 'smtp://127.0.0.1:2525', from: 'billing@example.test' },
    appEnv: {
      ENVIRONMENT: 'test-container',
      RELEASE: 'container-token-lifetime',
      APP_BASE_URL: 'http://localhost:3000',
    },
  }
}

describe('container API token maximum lifetime', () => {
  it('[e2e] defaults to a year, lets an administrator go beyond it, and refuses anyone else', async () => {
    const configuration = await config()
    const captured: EmailMessage[] = []
    const provider: HttpEmailProvider = {
      name: 'smtp',
      async send(message, options) {
        captured.push(message)
        return { messageId: `<${options.idempotencyKey}@capture.test>`, latencyMs: 1 }
      },
    }
    const runtime = await createContainerRuntime(configuration, { emailProvider: provider })
    const app = createApp(runtime.services, runtime.brandAssets, runtime.instanceTheme)
    const post = (path: string, payload: unknown, headers: Record<string, string> = {}) =>
      app.request(
        `${configuration.appBaseUrl}${path}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: configuration.appBaseUrl,
            ...headers,
          },
          body: JSON.stringify(payload),
        },
        configuration.appEnv,
      )

    expect(
      (
        await post('/auth/signup', {
          organization_name: 'Container Studio',
          first_name: 'Avery',
          last_name: 'Ng',
          email: 'owner@example.test',
          password,
        })
      ).status,
    ).toBe(202)
    for (let attempt = 0; captured.length === 0 && attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const verify = /ezacto_verify_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{43}/u.exec(captured[0]!.text)![0]
    expect((await post('/auth/verify-email', { token: verify })).status).toBe(200)
    const signIn = async () => {
      const response = await post('/auth/sign-in', { email: 'owner@example.test', password })
      expect(response.status).toBe(200)
      return response.headers.get('set-cookie')!.split(';', 1)[0]!
    }
    let cookie = await signIn()
    const mint = async (extra: object) => {
      const response = await post(
        '/api/v1/api-tokens',
        { name: 'Phone', scopes: ['time_entries:read'], ...extra },
        { cookie },
      )
      return {
        status: response.status,
        body: (await response.json()) as {
          data?: { expires_at: string | null; token: string }
          error?: { fields: Array<{ field: string; code: string }> }
        },
      }
    }

    const omitted = await mint({})
    expect(omitted.status).toBe(201)
    const days = (Date.parse(omitted.body.data!.expires_at!) - Date.now()) / day
    expect(days).toBeGreaterThan(364)
    expect(days).toBeLessThanOrEqual(366)

    const never = await mint({ expires_at: null })
    expect(never.status).toBe(201)
    expect(never.body.data!.expires_at).toBeNull()

    // The organization must keep an administrator, so hand ownership to a
    // second one before demoting the signed-in user.
    const now = new Date().toISOString()
    runtime.database
      .prepare(
        `INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
         VALUES (900, 'Second', 'Admin', 'administrator', '[]', ?, ?)`,
      )
      .run(now, now)
    runtime.database.prepare(`UPDATE organization_owner SET user_id = 900 WHERE id = 1`).run()
    runtime.database.prepare(`UPDATE users SET profile = 'member' WHERE id <> 900`).run()
    cookie = await signIn()
    for (const extra of [
      { expires_at: null },
      { expires_at: new Date(Date.now() + 400 * day).toISOString() },
    ]) {
      const refused = await mint(extra)
      expect(refused.status).toBe(422)
      expect(refused.body.error!.fields).toMatchObject([{ field: 'expires_at', code: 'too_long' }])
    }
    const sooner = await mint({ expires_at: new Date(Date.now() + 30 * day).toISOString() })
    expect(sooner.status).toBe(201)

    // A no-expiry token issued before the rule keeps working after it.
    const whoami = await app.request(
      `${configuration.appBaseUrl}/api/v1/whoami`,
      { headers: { authorization: `Bearer ${never.body.data!.token}` } },
      configuration.appEnv,
    )
    expect(whoami.status).toBe(200)
  })
})
