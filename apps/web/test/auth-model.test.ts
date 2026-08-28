import { EzactoClient } from '@ezacto/client'
import { describe, expect, it, vi } from 'vitest'
import { createShellApi } from '../src/index.js'

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

describe('browser authentication API composition', () => {
  it('[unit] uses request bodies and the current-session list/revoke contract', async () => {
    const requests: Request[] = []
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      requests.push(request)
      const path = new URL(request.url).pathname
      if (path === '/auth/sign-in') {
        return json({
          data: {
            status: 'authenticated',
            user_id: 7,
            profile: 'member',
            manager_grants: [],
          },
        })
      }
      if (path === '/api/v1/whoami') {
        return json({
          data: {
            user_id: 7,
            profile: 'member',
            manager_grants: [],
            authentication: { kind: 'session' },
          },
          links: { self: '/api/v1/whoami' },
        })
      }
      if (path === '/api/v1/sessions') {
        return json({
          data: [
            {
              id: 41,
              created_at: '2026-08-28T12:00:00.000Z',
              last_seen_at: '2026-08-28T12:00:00.000Z',
              idle_expires_at: '2026-08-29T12:00:00.000Z',
              absolute_expires_at: '2026-09-27T12:00:00.000Z',
              revoked_at: null,
              revocation_reason: null,
              current: true,
            },
          ],
          links: { self: '/api/v1/sessions' },
        })
      }
      if (path === '/api/v1/sessions/41') {
        return json({
          data: {
            id: 41,
            created_at: '2026-08-28T12:00:00.000Z',
            last_seen_at: '2026-08-28T12:00:00.000Z',
            idle_expires_at: '2026-08-29T12:00:00.000Z',
            absolute_expires_at: '2026-09-27T12:00:00.000Z',
            revoked_at: '2026-08-28T12:01:00.000Z',
            revocation_reason: 'user_revoked',
            current: false,
          },
        })
      }
      return new Response(null, { status: 404 })
    })
    const api = createShellApi(
      new EzactoClient({
        baseUrl: 'https://ezacto.test',
        fetch: fetchImplementation,
      }),
    )
    const controller = new AbortController()

    await api.signIn({
      email: 'owner@example.test',
      password: 'never put this in a URL',
    }, controller.signal)
    await expect(api.whoami(controller.signal)).resolves.toMatchObject({
      user_id: 7,
      authentication: { kind: 'session' },
    })
    await expect(api.logoutCurrentSession(controller.signal)).resolves.toMatchObject({
      id: 41,
      revocation_reason: 'user_revoked',
    })

    expect(
      requests.map((request) => [request.method, new URL(request.url).pathname]),
    ).toEqual([
      ['POST', '/auth/sign-in'],
      ['GET', '/api/v1/whoami'],
      ['GET', '/api/v1/sessions'],
      ['DELETE', '/api/v1/sessions/41'],
    ])
    expect(requests.every((request) => new URL(request.url).search === '')).toBe(true)
    expect(await requests[0]!.json()).toEqual({
      email: 'owner@example.test',
      password: 'never put this in a URL',
    })
    expect(requests.slice(1).every((request) => request.body === null)).toBe(true)
    expect(requests.every((request) => !request.signal.aborted)).toBe(true)
    controller.abort()
    expect(requests.every((request) => request.signal.aborted)).toBe(true)
  })
})
