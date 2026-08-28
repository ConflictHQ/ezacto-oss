import { serve } from '@hono/node-server'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runtimeApp } from './fixtures/runtime-app.js'

interface RuntimeResponse {
  status: number
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
}

type RuntimeRequest = (path: string, init?: RequestInit) => Promise<RuntimeResponse>

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
    entryPoints: [new URL('./fixtures/runtime-app.ts', import.meta.url).pathname],
    bundle: true,
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
  await Promise.all([
    new Promise<void>((resolve, reject) => {
      nodeServer.close((error) => (error ? reject(error) : resolve()))
    }),
    miniflare.dispose(),
  ])
})

const runtimes: readonly [string, RuntimeRequest][] = [
  ['Node HTTP', (path, init) => fetch(`${nodeOrigin}${path}`, init)],
  [
    'workerd',
    (path, init) =>
      miniflare.dispatchFetch(
        `https://worker.test${path}`,
        init as never,
      ) as unknown as Promise<RuntimeResponse>,
  ],
]

describe.each(runtimes)('%s runtime', (_runtime, request) => {
  it('[unit] executes the shared success handler over the real adapter', async () => {
    const response = await request('/api/v1/runtime/echo/portable')
    expect(response.status).toBe(200)
    expect(response.headers.get('x-request-id')).toBeTruthy()
    expect(await response.json()).toEqual({ data: { value: 'portable' } })
  })

  it('[api] executes the shared validation/error handler over the real adapter', async () => {
    const response = await request('/api/v1/runtime/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'x'.repeat(256) }),
    })
    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({
      error: { code: 'payload_too_large', fields: [] },
    })
  })

  it('[api] signs and consumes cursor pages over the real adapter', async () => {
    const firstResponse = await request('/api/v1/runtime/items?per_page=2')
    const first = (await firstResponse.json()) as {
      data: { id: number; label: string }[]
      links: { next: string | null }
    }
    expect(first.data).toEqual([
      { id: 1, label: 'row-1' },
      { id: 2, label: 'row-2' },
    ])
    expect(first.links.next).not.toBeNull()

    const secondResponse = await request(first.links.next!)
    expect(await secondResponse.json()).toMatchObject({
      data: [{ id: 3, label: 'row-3' }],
      links: { next: null },
    })
  })
})
