import type { Page } from '@playwright/test'

/** These cases exercise manual command replay, not automatic HTTP replay.
 * Native API responses advertise support while endpoint mocks can omit it.
 * Override only the capability header, preserving native requests, cookies,
 * response bodies/status, aborts and the financial command assertions.
 */
export const withoutHttpReplaySupport = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const browserFetch = globalThis.fetch.bind(globalThis)
    globalThis.fetch = async (input, init) => {
      const response = await browserFetch(input, init)
      const url = new URL(input instanceof Request ? input.url : String(input), location.href)
      if (url.origin === location.origin && url.pathname.startsWith('/api/v1/')) {
        const headers = new Headers(response.headers)
        headers.set('Idempotency-Key-Lifetime', '0')
        Object.defineProperty(response, 'headers', { value: headers })
      }
      return response
    }
  })
}
