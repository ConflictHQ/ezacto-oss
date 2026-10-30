/** Owned loopback-only native Stripe/UI acceptance; never a production entry. */
import { serve } from '@hono/node-server'
import { createContainerDatabase, executeInvoiceLifecycleCommand } from '@ezacto/db'
import { createContainerRuntime } from '../../../../entries/container/src/runtime.js'
import { createContainerHandler } from '../../../../entries/container/src/handler.js'
import { createApp } from '../../../../entries/worker/src/app.js'
import { join } from 'node:path'
import { realpath } from 'node:fs/promises'
import { webcrypto as crypto } from 'node:crypto'
import process from 'node:process'
import { URL } from 'node:url'

const root = await realpath(process.env.EZACTO_STRIPE_FIXTURE_DIRECTORY)
const port = Number(process.env.EZACTO_STRIPE_FIXTURE_PORT)
const password = process.env.EZACTO_STRIPE_FIXTURE_PASSWORD
const webhookSecret = process.env.EZACTO_STRIPE_FIXTURE_WEBHOOK_SECRET
if (!password || !webhookSecret || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Stripe fixture configuration invalid')
const origin = `http://localhost:${port}`
const nativeFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof globalThis.Request ? input.url : String(input))
  if (url.origin !== origin) return Promise.reject(new Error('Owned Stripe fixture blocks external network'))
  return nativeFetch(input, init)
}
const config = {
  host: '127.0.0.1', port, trustedProxyHops: 0, dataDirectory: root,
  databasePath: join(root, 'db.sqlite'), attachmentDirectory: join(root, 'attachments'), brandDirectory: join(root, 'brand'),
  appBaseUrl: origin, cursorSigningKey: crypto.getRandomValues(new Uint8Array(32)),
  smtp: { url: 'smtp://127.0.0.1:2525', from: 'stripe-fixture@example.invalid' },
  stripe: { apiKey: ['sk', 'test', 'owned-fixture'].join('_'), webhookSecret },
  appEnv: { ENVIRONMENT: 'test-container', RELEASE: 'owned-stripe-browser-acceptance', APP_BASE_URL: origin },
}
const runtime = await createContainerRuntime(config, {
  // Prevent delivery outside the fixture. SMTP transport itself is not under test.
  emailProvider: { name: 'smtp', async send(_message, options) { return { messageId: `<${options.idempotencyKey}@owned.invalid>`, latencyMs: 0 } } },
  verifyEmailProvider: async () => undefined,
})
const auth = runtime.services.passwordAuth
if (!auth) throw new Error('Actual Container password service absent')
const signup = await auth.signup({ organizationName: 'Owned Stripe acceptance', firstName: 'Owned', lastName: 'Administrator', email: 'stripe-owner@example.invalid', password, clientKey: 'owned-stripe-bootstrap' })
await auth.verifyEmail(signup.token, 'owned-stripe-bootstrap')
const now = new Date().toISOString()
runtime.database.transaction(() => {
  runtime.database.prepare("INSERT INTO clients(id,name,currency,created_at,updated_at) VALUES(1,'Owned Stripe client','USD',?,?)").run(now, now)
  runtime.database.prepare("INSERT INTO invoices(id,client_id,number,currency,issue_date,due_date,payment_options,created_at,updated_at) VALUES(1,1,'STRIPE-OWNED-1','USD','2026-10-01','2026-11-01','[\"stripe_checkout\"]',?,?)").run(now, now)
  runtime.database.prepare("INSERT INTO invoice_line_items(invoice_id,position,kind,description,quantity,unit_price_cents,amount_cents,created_at,updated_at) VALUES(1,0,'Service','Owned test service',1,10000,10000,?,?)").run(now, now)
})()
await executeInvoiceLifecycleCommand(createContainerDatabase(runtime.database), { invoiceId: 1, commandId: 'owned-stripe-send', command: 'send', actor: { type: 'user', id: 1 }, authorize: async () => true, expectedVersion: 0, occurredAt: now, messageId: 301, eventId: 'owned-stripe-send-event' })
const app = createApp(runtime.services, runtime.brandAssets, runtime.instanceTheme)
const handle = createContainerHandler(runtime.services, app, config.appEnv)
const server = serve({ hostname: '127.0.0.1', port, fetch: request => handle(request) })
let stopping
const stop = () => { stopping ??= (async () => { await new Promise(resolve => { server.close(() => resolve()); server.closeIdleConnections() }); await runtime.close() })(); void stopping.then(() => process.exit(0), () => process.exit(1)) }
process.once('SIGTERM', stop); process.once('SIGINT', stop)
