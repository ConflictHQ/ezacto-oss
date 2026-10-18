import { createServer } from 'node:http'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { describe, expect, it } from 'vitest'

const worker = `
import { ensureRuntimeDatabaseReady } from './src/runtime.js'
import { migrateD1 } from '@ezacto/db/d1'
let database
let executions = 0
let opened
const gateOpened = new Promise(resolve => { opened = resolve })
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname
    if (path === '/seed') {
      await migrateD1(env.DB)
      return new Response('seeded')
    }
    if (path === '/state') return Response.json({ executions })
    database ??= {
      prepare: env.DB.prepare.bind(env.DB),
      batch: env.DB.batch.bind(env.DB),
      exec: async statement => {
        executions++
        if (executions === 1 && env.GATE) {
          const response = await fetch(env.GATE)
          opened()
          await response.text()
        }
        if (executions === 1 && env.FAIL_FIRST) throw new Error('readiness failed')
        return env.DB.exec(statement)
      },
    }
    const pending = ensureRuntimeDatabaseReady(database)
    if (path === '/end') {
      // Explicitly end the initiating invocation with its I/O still pending.
      // Aborting an outer Miniflare fetch does not cancel workerd's invocation,
      // so that would not exercise the production request-lifetime boundary.
      void pending.catch(() => {})
      await gateOpened
      return new Response('ended')
    }
    try {
      await pending
      return new Response('ready')
    } catch {
      return new Response('unavailable', { status: 503 })
    }
  },
}
`

const harness = async (bindings: Record<string, string | boolean>) => {
  const bundle = await build({
    stdin: { contents: worker, resolveDir: new URL('..', import.meta.url).pathname },
    bundle: true,
    conditions: ['development'],
    format: 'esm',
    platform: 'browser',
    external: ['node:async_hooks'],
    target: 'es2022',
    write: false,
  })
  const miniflare = new Miniflare({
    modules: true,
    compatibilityDate: '2026-08-06',
    compatibilityFlags: ['nodejs_als'],
    d1Databases: ['DB'],
    bindings,
    script: bundle.outputFiles[0]!.text,
  })
  const origin = await miniflare.ready
  const request = (path: string) => fetch(new URL(path, origin), {
    signal: AbortSignal.timeout(5_000),
  })
  return { miniflare, request }
}

describe('Worker readiness request ownership', () => {
  it('does not inherit pending I/O from an invocation that ended, then caches completed readiness', async () => {
    let release = () => {}
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.write('pending')
      release = () => response.end('finished')
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const address = upstream.address()
    if (address === null || typeof address === 'string') throw new Error('missing test address')
    const { miniflare, request } = await harness({ GATE: `http://127.0.0.1:${address.port}` })
    try {
      expect(await (await request('/seed')).text()).toBe('seeded')
      expect(await (await request('/end')).text()).toBe('ended')
      release()

      // The old shared promise never resolves here, even after the upstream
      // body is released: its creating invocation has already ended.
      expect(await (await request('/ready')).text()).toBe('ready')
      expect(await (await request('/state')).json()).toEqual({ executions: 2 })
      expect(await (await request('/ready')).text()).toBe('ready')
      expect(await (await request('/state')).json()).toEqual({ executions: 2 })
    } finally {
      release()
      await miniflare.dispose()
      upstream.closeAllConnections()
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
  })

  it('retries failed readiness without marking the database ready', async () => {
    const { miniflare, request } = await harness({ FAIL_FIRST: true })
    try {
      expect(await (await request('/seed')).text()).toBe('seeded')
      expect((await request('/ready')).status).toBe(503)
      expect(await (await request('/ready')).text()).toBe('ready')
      expect(await (await request('/state')).json()).toEqual({ executions: 2 })
      expect(await (await request('/ready')).text()).toBe('ready')
      expect(await (await request('/state')).json()).toEqual({ executions: 2 })
    } finally {
      await miniflare.dispose()
    }
  })
})
