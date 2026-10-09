import type { APIRequestContext, Page, Request, TestInfo } from '@playwright/test'

type Timing = {
  method: string
  path: string
  startedMs: number
  responseMs?: number
  finishedMs?: number
  status?: number
  ray?: string
  failed?: boolean
}

export type CleanupTiming = {
  stage: 'read_started' | 'read_completed' | 'marker_verified' | 'delete_started' | 'delete_completed'
  elapsedMs: number
  status?: number
}

/** Correlate slow requests without recording cookies, queries, bodies or headers. */
export const requestDiagnostics = (page: Page) => {
  const start = Date.now()
  const timings = new Map<Request, Timing>()
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== 'https://ezacto.io' || timings.size >= 300) return
    timings.set(request, {
      method: request.method(),
      path: url.pathname,
      startedMs: Date.now() - start,
    })
  })
  page.on('response', response => {
    const timing = timings.get(response.request())
    if (timing === undefined) return
    timing.responseMs = Date.now() - start
    timing.status = response.status()
    const ray = response.headers()['cf-ray']
    if (ray !== undefined && /^[a-z0-9-]{1,64}$/i.test(ray)) timing.ray = ray
  })
  page.on('requestfinished', request => {
    const timing = timings.get(request)
    if (timing !== undefined) timing.finishedMs = Date.now() - start
  })
  page.on('requestfailed', request => {
    const timing = timings.get(request)
    if (timing === undefined) return
    timing.finishedMs = Date.now() - start
    timing.failed = true
  })
  return async (testInfo: TestInfo, cleanup: readonly CleanupTiming[]) => {
    await testInfo.attach('request-timing.json', {
      body: Buffer.from(JSON.stringify({ elapsedMs: Date.now() - start, requests: [...timings.values()], cleanup })),
      contentType: 'application/json',
    })
  }
}

/** Use the browser's cookie jar, with a bounded request independent of page JS. */
export const cleanupClient = async (
  request: APIRequestContext,
  id: number,
  name: string,
  record: (timing: CleanupTiming) => void,
) => {
  const start = Date.now()
  record({ stage: 'read_started', elapsedMs: 0 })
  const current = await request.get(`/api/v1/clients/${id}`, { timeout: 10_000 })
  record({ stage: 'read_completed', elapsedMs: Date.now() - start, status: current.status() })
  if (!current.ok()) return { read: current.status(), deleted: 0 }
  const body = await current.json() as { data: { name: string } }
  if (body.data.name !== name) return { read: current.status(), deleted: 0 }
  record({ stage: 'marker_verified', elapsedMs: Date.now() - start })
  record({ stage: 'delete_started', elapsedMs: Date.now() - start })
  const deleted = await request.delete(`/api/v1/clients/${id}`, {
    timeout: 10_000,
    headers: { origin: 'https://ezacto.io' },
  })
  record({ stage: 'delete_completed', elapsedMs: Date.now() - start, status: deleted.status() })
  return { read: current.status(), deleted: deleted.status() }
}
