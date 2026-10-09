import type { Page, Request, TestInfo } from '@playwright/test'

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

/** Bounded same-origin cleanup; APIRequestContext embeds cookies in failed report steps. */
export const cleanupClient = async (
  page: Page,
  id: number,
  name: string,
  record: (timing: CleanupTiming) => void,
) => {
  const result = await page.evaluate(async ({ id, name }) => {
    const timings: CleanupTiming[] = []
    const start = Date.now()
    let phase = 'client lookup'
    try {
      if (location.origin !== 'https://ezacto.io' || !Number.isSafeInteger(id) || id <= 0) {
        return { timings, error: 'Deployment test cleanup refused an unexpected origin or client id.' }
      }
      timings.push({ stage: 'read_started', elapsedMs: 0 })
      const current = await fetch(`/api/v1/clients/${id}`, {
        credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(10_000),
      })
      timings.push({ stage: 'read_completed', elapsedMs: Date.now() - start, status: current.status })
      if (!current.ok) return { timings, cleanup: { read: current.status, deleted: 0 } }
      phase = 'client marker verification'
      const body = await current.json() as { data: { name: string } }
      if (body.data.name !== name) return { timings, cleanup: { read: current.status, deleted: 0 } }
      timings.push({ stage: 'marker_verified', elapsedMs: Date.now() - start })
      phase = 'client deletion'
      timings.push({ stage: 'delete_started', elapsedMs: Date.now() - start })
      const deleted = await fetch(`/api/v1/clients/${id}`, {
        method: 'DELETE', credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(10_000),
      })
      timings.push({ stage: 'delete_completed', elapsedMs: Date.now() - start, status: deleted.status })
      return { timings, cleanup: { read: current.status, deleted: deleted.status } }
    } catch {
      // Never return browser errors, response bodies or credentials to the reporter.
      return { timings, error: `Deployment test cleanup could not finish ${phase}.` }
    }
  }, { id, name }).catch(() => ({
    timings: [] as CleanupTiming[],
    error: 'Deployment test cleanup could not access the current browser session.',
  }))
  result.timings.forEach(record)
  if (result.error !== undefined) throw new Error(result.error)
  return result.cleanup
}
