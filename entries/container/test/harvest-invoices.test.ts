import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import {
  createContainerRuntime,
  type ContainerRuntime,
} from '../src/runtime.js'
import { createContainerHandler } from '../src/handler.js'
import { createApp } from '../../worker/src/app.js'

it('[api] reads a natively generated and edited invoice through the container Harvest shim', async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'ezacto-harvest-invoice-')),
  )
  let runtime: ContainerRuntime | undefined
  try {
    const config = {
      host: '127.0.0.1',
      port: 3000,
      trustedProxyHops: 0,
      dataDirectory: root,
      databasePath: join(root, 'db.sqlite'),
      attachmentDirectory: join(root, 'attachments'),
      brandDirectory: join(root, 'brand'),
      appBaseUrl: 'http://localhost:3000',
      cursorSigningKey: new Uint8Array(32).fill(0x35),
      smtp: { url: 'smtp://localhost:2525', from: 'fixture@example.test' },
      appEnv: { ENVIRONMENT: 'test', RELEASE: 'harvest-native-invoice' },
    }
    runtime = await createContainerRuntime(config, {
      emailProvider: {
        name: 'smtp',
        send: async () => ({ messageId: 'unused@example.test', latencyMs: 0 }),
      },
    })
    await runtime.services.bootstrap({
      organizationName: 'Sample Organization',
      ownerFirstName: 'Sample',
      ownerLastName: 'Owner',
      ownerEmail: 'fixture@example.test',
      token: `ezacto_abcdefghijklmnop_${'A'.repeat(43)}`,
    })
    const session = await runtime.services.sessions.issue(1),
      cookie = session.setCookie.split(';')[0]!
    const handle = createContainerHandler(
      runtime.services,
      createApp(runtime.services),
      config.appEnv,
    )
    let next = 0
    const post = (path: string, body: unknown) =>
      handle(
        new Request('http://localhost:3000/api/v1' + path, {
          method: 'POST',
          headers: {
            cookie,
            origin: config.appBaseUrl,
            'content-type': 'application/json',
            'idempotency-key': `fixture-invoice-${++next}`,
          },
          body: JSON.stringify(body),
        }),
      )
    const clientResponse = await post('/clients', {
      name: 'Sample Client',
      currency: 'USD',
    })
    expect(clientResponse.status, await clientResponse.clone().text()).toBe(201)
    const client = (await clientResponse.json()) as { data: { id: number } }
    const generated = await post('/invoice-generations', {
      kind: 'free_form',
      client_id: client.data.id,
    })
    expect(generated.status, await generated.clone().text()).toBe(201)
    const invoice = (await generated.json()) as {
      data: { id: number; version: number }
    }
    const edited = await post(`/invoices/${invoice.data.id}/line-items`, {
      expected_version: invoice.data.version,
      position: 0,
      kind: 'Sample Custom Service',
      description: 'Sample work',
      quantity: 2.5,
      unit_price_cents: 1234,
      taxed: false,
      taxed2: false,
    })
    expect(edited.status, await edited.clone().text()).toBe(201)
    const token = await runtime.services.tokens.issue({
      userId: 1,
      name: 'Read-only invoice compatibility',
      scopes: ['invoices:read'],
    })
    const read = await handle(
      new Request(
        `http://localhost:3000/harvest/v2/invoices/${invoice.data.id}`,
        { headers: { authorization: `Bearer ${token.token}` } },
      ),
    )
    expect(read.status).toBe(200)
    const result = await read.json()
    expect(result).toMatchObject({
      id: invoice.data.id,
      amount: 30.85,
      due_amount: 30.85,
      client: { id: client.data.id, name: 'Sample Client' },
      line_items: [
        {
          kind: 'Sample Custom Service',
          quantity: 2.5,
          unit_price: 12.34,
          amount: 30.85,
        },
      ],
    })
    expect(result).not.toHaveProperty('reference_token')
    expect(result).not.toHaveProperty('client_key')
    await runtime.services.tokens.revoke(1, token.id)
  } finally {
    await runtime?.close()
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
