import { EventEmitter } from 'node:events'
import type { APIRequestContext, Page, Request, TestInfo } from '@playwright/test'
import { describe, expect, it, vi } from 'vitest'
import { cleanupClient, requestDiagnostics } from '../e2e/postdeploy/diagnostics.js'

describe('deployed acceptance diagnostics', () => {
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
    const remove = vi.fn()
    const request = {
      get: vi.fn(async () => ({
        ok: () => true,
        status: () => 200,
        json: async () => ({ data: { name: 'Unrelated client' } }),
      })),
      delete: remove,
    } as unknown as APIRequestContext
    const record = vi.fn()
    expect(await cleanupClient(request, 123, 'Deployment E2E unique-marker', record)).toEqual({
      read: 200,
      deleted: 0,
    })
    expect(remove).not.toHaveBeenCalled()
    expect(record.mock.calls.map(([event]) => event.stage)).toEqual(['read_started', 'read_completed'])
  })

  it.each(['lookup', 'deletion'] as const)('redacts transport credentials when cleanup fails during %s', async (phase) => {
    const secret = 'private-session-cookie-from-transport-call-log'
    const transportError = new Error(`Request failed\nCall log:\n - cookie: ${secret}`)
    const request = {
      get: phase === 'lookup'
        ? vi.fn().mockRejectedValue(transportError)
        : vi.fn(async () => ({
            ok: () => true,
            status: () => 200,
            json: async () => ({ data: { name: 'Deployment E2E unique-marker' } }),
          })),
      delete: vi.fn().mockRejectedValue(transportError),
    } as unknown as APIRequestContext
    const error: unknown = await cleanupClient(request, 123, 'Deployment E2E unique-marker', () => {})
      .catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(`Deployment test cleanup could not finish client ${phase}.`)
    expect((error as Error).stack).not.toContain(secret)
    expect((error as Error).cause).toBeUndefined()
  })
})
