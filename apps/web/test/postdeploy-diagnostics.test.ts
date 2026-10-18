import { EventEmitter } from 'node:events'
import type { Page, Request, TestInfo } from '@playwright/test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanupClient, requestDiagnostics } from '../e2e/postdeploy/diagnostics.js'

describe('deployed acceptance diagnostics', () => {
  afterEach(() => vi.unstubAllGlobals())
  const browserPage = () => {
    vi.stubGlobal('location', { origin: 'https://ezacto.io' })
    return { evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg) } as unknown as Page
  }
  it('retains request timing and a correlation ray without credentials, queries or response headers', async () => {
    const page = new EventEmitter()
    const attach = requestDiagnostics(page as unknown as Page)
    const request = {
      url: () => 'https://ezacto.io/auth/apple/callback?code=private-provider-code',
      method: () => 'POST',
    } as Request
    page.emit('request', request)
    page.emit('response', {
      request: () => request,
      status: () => 503,
      headers: () => ({
        'cf-ray': 'abc123-MIA',
        'set-cookie': 'private-session-cookie',
        authorization: 'private-bearer',
      }),
    })
    page.emit('requestfailed', request)
    const attachment = vi.fn()
    await attach({ attach: attachment } as unknown as TestInfo, [])
    const text = attachment.mock.calls[0]![1].body.toString() as string
    expect(text).not.toMatch(/private-|\?code|set-cookie|authorization/)
    expect(JSON.parse(text)).toMatchObject({
      requests: [{
        method: 'POST',
        path: '/auth/apple/callback',
        status: 503,
        ray: 'abc123-MIA',
        failed: true,
        startedMs: expect.any(Number),
        responseMs: expect.any(Number),
        finishedMs: expect.any(Number),
      }],
    })
  })

  it('never deletes a client whose current name differs from this run’s unique marker', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ data: { name: 'Unrelated client' } }))
    vi.stubGlobal('fetch', fetch)
    const record = vi.fn()
    expect(await cleanupClient(browserPage(), 123, 'Deployment E2E unique-marker', record)).toEqual({
      read: 200, deleted: 0,
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]).toEqual(['/api/v1/clients/123', {
      credentials: 'same-origin', redirect: 'error', signal: expect.any(AbortSignal),
    }])
    expect(record.mock.calls.map(([event]) => event.stage)).toEqual(['read_started', 'read_completed'])
  })

  it('deletes the verified run fixture using the current same-origin browser session', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: { name: 'Deployment E2E unique-marker' } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetch)
    const record = vi.fn()
    expect(await cleanupClient(browserPage(), 123, 'Deployment E2E unique-marker', record))
      .toEqual({ read: 200, deleted: 204 })
    expect(fetch.mock.calls[1]).toEqual(['/api/v1/clients/123', {
      method: 'DELETE', credentials: 'same-origin', redirect: 'error', signal: expect.any(AbortSignal),
    }])
    expect(record.mock.calls.map(([event]) => event.stage)).toEqual([
      'read_started', 'read_completed', 'marker_verified', 'delete_started', 'delete_completed',
    ])
  })

  it('refuses cleanup from another site before making a request', async () => {
    const page = browserPage()
    vi.stubGlobal('location', { origin: 'https://other.example' })
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(cleanupClient(page, 123, 'Deployment E2E unique-marker', () => {}))
      .rejects.toThrow('refused an unexpected origin')
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['lookup', 'deletion'] as const)('redacts transport credentials when cleanup fails during %s', async (phase) => {
    const secret = 'private-session-cookie-from-transport-call-log'
    const transportError = new Error(`Request failed\nCall log:\n - cookie: ${secret}`)
    const fetch = vi.fn()
    if (phase === 'deletion') fetch.mockResolvedValueOnce(Response.json({ data: { name: 'Deployment E2E unique-marker' } }))
    fetch.mockRejectedValueOnce(transportError)
    vi.stubGlobal('fetch', fetch)
    const error: unknown = await cleanupClient(browserPage(), 123, 'Deployment E2E unique-marker', () => {})
      .catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(`Deployment test cleanup could not finish client ${phase}.`)
    expect((error as Error).stack).not.toContain(secret)
    expect((error as Error).cause).toBeUndefined()
  })
})
