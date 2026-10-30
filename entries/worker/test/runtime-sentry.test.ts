import { build } from 'esbuild'
import { Miniflare, Request as MfRequest, Response as MfResponse } from 'miniflare'
import { expect, it, vi } from 'vitest'

it('scrubs real default-wrapper bootstrap, readiness and automatic scheduled captures without duplicates', async () => {
  const bundle = await build({
    stdin: { resolveDir: new URL('..', import.meta.url).pathname, contents: `
      import worker from './src/index.ts';
      import * as Sentry from '@sentry/cloudflare';
      const failure = () => {
        Sentry.setUser({email:'SECRET@example.test'}); Sentry.setContext('private',{token:'SECRET'});
        Sentry.setTag('request_id','11111111-1111-4111-8111-111111111111');
        Sentry.addBreadcrumb({message:'SECRET'});
        throw new TypeError('SECRET provider SQL response');
      };
      export default {async fetch(request,env,ctx) {
        const bindings={...env,DB:{prepare:failure,exec:failure,batch:failure},API_CURSOR_SIGNING_KEY:'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE'};
        if(new URL(request.url).pathname==='/scheduled') {
          try {await worker.scheduled({cron:'* * * * *',scheduledTime:Date.now()},bindings,ctx);}
          catch {return new Response('scheduled retry remains required',{status:503});}
        }
        return worker.fetch(request,bindings,ctx);
      }};
    ` },
    bundle: true, conditions: ['development'], format: 'esm', platform: 'browser', external: ['node:async_hooks'], target: 'es2022', write: false,
  })
  const envelopes: string[] = []
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate: '2026-08-06', compatibilityFlags: ['nodejs_als'],
    bindings: { SENTRY_DSN: 'https://fixture@sentry.example.com/567', ENVIRONMENT: 'test', RELEASE: 'a'.repeat(40) },
    outboundService: async (request: MfRequest) => { expect(new URL(request.url).pathname).toBe('/api/567/envelope/'); envelopes.push(await request.text()); return new MfResponse('{}') },
  })
  try {
    const bootstrap = await mf.dispatchFetch('https://fixture.invalid/api/v1/profile?secret=SECRET', { headers: { authorization: 'Bearer SECRET', cookie: 'SECRET=SECRET' } })
    expect(bootstrap.status).toBe(503)
    const body = await bootstrap.json() as { request_id: string }
    const readiness = await mf.dispatchFetch('https://fixture.invalid/readyz')
    expect(readiness.status).toBe(503); expect(await readiness.json()).toEqual({ status: 'unavailable' })
    const scheduled = await mf.dispatchFetch('https://fixture.invalid/scheduled')
    expect(scheduled.status).toBe(503)
    await vi.waitFor(() => expect(envelopes.length).toBe(3))
    const events = envelopes.flatMap(envelope => envelope.split('\n').flatMap(line => {
      try { const value = JSON.parse(line); return value.exception ? [value] : [] } catch { return [] }
    }))
    expect(events).toHaveLength(3)
    expect(envelopes.join('\n')).not.toContain('SECRET')
    expect(events.map(event => event.tags.phase).sort()).toEqual(['bootstrap', 'readiness', 'uncaught'])
    expect(events.find(event => event.tags.phase === 'bootstrap').tags.request_id).toBe(body.request_id)
    expect(new Set(events.map(event => event.contexts.trace.trace_id)).size).toBe(3)
    for (const event of events) {
      expect(event.release).toBe('a'.repeat(40))
      expect(event.exception.values[0].value).toBe('eZacto runtime failure')
      expect(event.exception.values[0].stacktrace.frames.length).toBeGreaterThan(0)
      expect(event).not.toHaveProperty('request')
      expect(event).not.toHaveProperty('user')
    }
  } finally { await mf.dispose() }
}, 30_000)
