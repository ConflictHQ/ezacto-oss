/** Owned browser acceptance composition. Never shipped as an application entry. */
import { serve } from '@hono/node-server'
import { hashPassword } from '@ezacto/core'
import { createContainerRuntime } from '../../../../entries/container/src/runtime.js'
import { createContainerHandler } from '../../../../entries/container/src/handler.js'
import { createApp } from '../../../../entries/worker/src/app.js'
import { join } from 'node:path'
import { realpath } from 'node:fs/promises'
import process from 'node:process'
import { Buffer } from 'node:buffer'
import { webcrypto as crypto } from 'node:crypto'
import { URL } from 'node:url'

const root = await realpath(process.env['EZACTO_CSV_FIXTURE_DIRECTORY'])
const port = Number(process.env['EZACTO_CSV_FIXTURE_PORT'])
const password = process.env['EZACTO_CSV_FIXTURE_PASSWORD']
if (!password || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('CSV browser fixture configuration is invalid')
const origin = `http://localhost:${port}`
// No customer/provider calls are permitted from this owned local process.
const nativeFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof globalThis.Request ? input.url : String(input))
  if (url.origin !== origin) return Promise.reject(new Error('CSV browser fixture blocks external network'))
  return nativeFetch(input, init)
}
const config = {
  host: '127.0.0.1', port, trustedProxyHops: 0, dataDirectory: root,
  databasePath: join(root, 'db.sqlite'), attachmentDirectory: join(root, 'attachments'), brandDirectory: join(root, 'brand'),
  appBaseUrl: origin, cursorSigningKey: crypto.getRandomValues(new Uint8Array(32)), webhookEncryptionKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),
  smtp: { url: 'smtp://127.0.0.1:2525', from: 'csv-fixture@example.invalid' },
  appEnv: { ENVIRONMENT: 'test-container', RELEASE: 'owned-csv-browser-acceptance', APP_BASE_URL: origin },
}
const runtime = await createContainerRuntime(config, {
  emailProvider: { name: 'smtp', async send(_message, options) { return { messageId: `<${options.idempotencyKey}@owned.invalid>`, latencyMs: 0 } } },
  verifyEmailProvider: async () => undefined,
})
const auth = runtime.services.passwordAuth
if (!auth) throw new Error('Actual Container password service is absent')
const signup = await auth.signup({ organizationName: 'Owned CSV acceptance', firstName: 'Owned', lastName: 'Owner', email: 'csv-owner@example.invalid', password, clientKey: 'owned-csv-bootstrap' })
await auth.verifyEmail(signup.token, 'owned-csv-bootstrap')
const credential = await hashPassword(password), now = new Date().toISOString()
runtime.database.transaction(() => {
  runtime.database.prepare(`INSERT INTO users (id,first_name,last_name,timezone,is_contractor,is_active,has_access_to_all_future_projects,weekly_capacity,profile,manager_grants,is_owner,saml_exempt,created_at,updated_at) VALUES (2,'Import','Administrator','UTC',0,1,0,126000,'administrator','[]',0,0,?,?)`).run(now, now)
  runtime.database.prepare(`INSERT INTO user_emails (id,user_id,address,verified_at,is_primary,invalidated_at,created_at,updated_at) VALUES (2,2,'csv-admin@example.invalid',?,1,NULL,?,?)`).run(now, now, now)
  runtime.database.prepare(`INSERT INTO user_passwords (user_id,credential_version,algorithm,version,iterations,memory_kib,time_cost,parallelism,salt,password_hash,created_at,updated_at) VALUES (2,1,?,?,NULL,?,?,?,?,?,?,?)`).run(credential.algorithm, credential.version, credential.memoryKiB, credential.timeCost, credential.parallelism, credential.salt, credential.passwordHash, now, now)
})()
const app = createApp(runtime.services, runtime.brandAssets, runtime.instanceTheme)
const handle = createContainerHandler(runtime.services, app, config.appEnv)
const server = serve({ hostname: '127.0.0.1', port, fetch: request => handle(request) })
let stopping = null
const shutdown = () => {
  stopping ??= (async () => { await new Promise(resolve => { server.close(() => resolve()); server.closeIdleConnections() }); await runtime.close() })()
  void stopping.then(() => process.exit(0), () => process.exit(1))
}
process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown)
