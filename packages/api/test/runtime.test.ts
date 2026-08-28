import { serve } from '@hono/node-server'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runtimeApp } from './fixtures/runtime-app.js'

const runtimeBearer =
  'ezacto_runtimeauthseed_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi1234567'

interface RuntimeResponse {
  status: number
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
}

type RuntimeRequest = (
  path: string,
  init?: RequestInit,
) => Promise<RuntimeResponse>

let nodeServer: ReturnType<typeof serve>
let nodeOrigin: string
let miniflare: Miniflare

beforeAll(async () => {
  nodeOrigin = await new Promise<string>((resolve) => {
    nodeServer = serve({ fetch: runtimeApp.fetch, port: 0 }, ({ port }) => {
      resolve(`http://127.0.0.1:${port}`)
    })
  })

  const bundled = await build({
    entryPoints: [
      new URL('./fixtures/runtime-app.ts', import.meta.url).pathname,
    ],
    bundle: true,
    conditions: ['development'],
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
  })
  miniflare = new Miniflare({
    // Latest compatibility date supported by the pinned stable workerd binary.
    compatibilityDate: '2026-08-06',
    modules: true,
    script: bundled.outputFiles[0]!.text,
  })
})

afterAll(async () => {
  const cleanup: Promise<void>[] = []
  if (nodeServer !== undefined) {
    cleanup.push(
      new Promise<void>((resolve, reject) => {
        nodeServer.close((error) => (error ? reject(error) : resolve()))
      }),
    )
  }
  if (miniflare !== undefined) cleanup.push(miniflare.dispose())
  await Promise.all(cleanup)
})

const runtimes: readonly [string, RuntimeRequest][] = [
  [
    'Node HTTP',
    (path, init) => {
      const headers = new Headers(init?.headers)
      if (!headers.has('origin')) headers.set('origin', nodeOrigin)
      return fetch(`${nodeOrigin}${path}`, { ...init, headers })
    },
  ],
  [
    'workerd',
    (path, init) => {
      const headers = new Headers(init?.headers)
      if (!headers.has('origin')) headers.set('origin', 'https://worker.test')
      return miniflare.dispatchFetch(`https://worker.test${path}`, {
        ...init,
        headers,
      } as never) as unknown as Promise<RuntimeResponse>
    },
  ],
]

describe.each(runtimes)('%s runtime', (runtime, request) => {
  it('[unit] executes the shared success handler over the real adapter', async () => {
    const response = await request('/api/v1/runtime/echo/portable', {
      headers: { cookie: 'session=runtime-user' },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('x-request-id')).toBeTruthy()
    expect(await response.json()).toEqual({ data: { value: 'portable' } })
  })

  it('[api] executes the shared validation/error handler over the real adapter', async () => {
    const response = await request('/api/v1/runtime/validate', {
      method: 'POST',
      headers: {
        cookie: 'session=runtime-user',
        'content-type': 'application/json',
      },
      body: '{}',
    })
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      error: {
        code: 'validation_failed',
        message: 'The request contains invalid fields.',
        fields: [
          {
            field: 'value',
            code: 'required',
            message: 'value must be a non-empty string',
          },
        ],
      },
      request_id: response.headers.get('x-request-id'),
    })
  })

  it('[security] enforces the portable JSON byte boundary over the real adapter', async () => {
    const response = await request('/api/v1/runtime/validate', {
      method: 'POST',
      headers: {
        cookie: 'session=runtime-user',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ value: 'x'.repeat(256) }),
    })
    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({
      error: { code: 'payload_too_large', fields: [] },
    })
  })

  it('[security] rejects a valid cookie mutation from a different origin', async () => {
    const attackerOrigin = (() => {
      if (runtime === 'workerd') return 'https://evil.worker.test'
      const url = new URL(nodeOrigin)
      url.port = url.port === '1' ? '2' : '1'
      return url.origin
    })()
    const response = await request('/api/v1/runtime/bodyless', {
      method: 'POST',
      headers: {
        cookie: 'session=runtime-user',
        origin: attackerOrigin,
      },
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      error: { code: 'csrf_origin_mismatch', fields: [] },
    })
  })

  it('[api] signs and consumes cursor pages over the real adapter', async () => {
    const firstResponse = await request('/api/v1/runtime/items?per_page=2', {
      headers: { cookie: 'session=runtime-user' },
    })
    const first = (await firstResponse.json()) as {
      data: { id: number; label: string }[]
      links: { next: string | null }
    }
    expect(first.data).toEqual([
      { id: 1, label: 'row-1' },
      { id: 2, label: 'row-2' },
    ])
    expect(first.links.next).not.toBeNull()

    const secondResponse = await request(first.links.next!, {
      headers: { cookie: 'session=runtime-user' },
    })
    expect(await secondResponse.json()).toMatchObject({
      data: [{ id: 3, label: 'row-3' }],
      links: { next: null },
    })
  })

  it('[security] enforces bearer precedence and authenticates a valid token', async () => {
    const malformed = await request('/api/v1/runtime/reports', {
      headers: {
        authorization: 'Basic attacker',
        cookie: 'session=runtime-user',
      },
    })
    expect(malformed.status).toBe(401)

    const bearer = await request('/api/v1/runtime/reports', {
      headers: { authorization: `bEaReR ${runtimeBearer}` },
    })
    expect(bearer.status).toBe(200)
    expect(await bearer.json()).toEqual({ data: { visible: true } })
  })

  it('[security] rejects contact sessions before installed or unknown API routes', async () => {
    for (const path of [
      '/api/v1/runtime/installer-bypass',
      '/api/v1/runtime/not-found',
    ]) {
      const response = await request(path, {
        headers: { cookie: 'session=runtime-contact' },
      })
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({
        error: { code: 'contact_api_forbidden', fields: [] },
      })
    }
  })

  it('[api] carries token issue, list, revoke, and immediate rejection over the adapter', async () => {
    const issuedResponse = await request('/api/v1/api-tokens', {
      method: 'POST',
      headers: {
        cookie: 'session=runtime-user',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Runtime lifecycle',
        scopes: ['reports:read'],
      }),
    })
    expect(issuedResponse.status).toBe(201)
    const issued = (await issuedResponse.json()) as {
      data: { id: number; token: string }
    }

    const listResponse = await request('/api/v1/api-tokens', {
      headers: { cookie: 'session=runtime-user' },
    })
    expect(listResponse.status).toBe(200)
    const listedWire = JSON.stringify(await listResponse.json())
    expect(listedWire).not.toContain(issued.data.token)
    expect(JSON.parse(listedWire)).toMatchObject({
      data: expect.arrayContaining([
        expect.objectContaining({
          id: issued.data.id,
          name: 'Runtime lifecycle',
        }),
      ]),
    })

    const revokeResponse = await request(
      `/api/v1/api-tokens/${issued.data.id}`,
      {
        method: 'DELETE',
        headers: { cookie: 'session=runtime-user' },
      },
    )
    expect(revokeResponse.status).toBe(200)

    const rejected = await request('/api/v1/runtime/reports', {
      headers: { authorization: `Bearer ${issued.data.token}` },
    })
    expect(rejected.status).toBe(401)
  })
})
