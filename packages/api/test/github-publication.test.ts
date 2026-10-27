import { describe, expect, it, vi } from 'vitest'
import { createApiApp } from '../src/app.js'
import { installGithubPublicationRoutes } from '../src/github-publication.js'
import { GithubPublicationError, type GithubPublicationPort } from '@ezacto/integrations'
const setup = () => {
  const port = {
    list: vi.fn(async () => ({ policies: [], publications: [], candidates: [] })),
    preview: vi.fn(async () => ({
      link_id: 1,
      connection_id: '1:2:3',
      destination: 'https://github.com/owned/test/issues/5',
      spent_date: '2026-10-01',
      seconds: 3600,
      source_version: 'a'.repeat(64),
      policy_enabled: true,
    })),
    policy: vi.fn(async () => {}),
    consent: vi.fn(async () => {}),
    act: vi.fn(async () => {}),
  } satisfies GithubPublicationPort
  const app = createApiApp({
    authentication: {
      sessions: {
        resolve: async (request: Request) =>
          request.headers.get('cookie')
            ? {
                type: 'user' as const,
                userId: 2,
                profile:
                  request.headers.get('cookie') === 'session=admin'
                    ? ('administrator' as const)
                    : ('member' as const),
                authentication: { kind: 'session' as const, sessionId: '7' },
              }
            : null,
      },
    },
    installApi: (api) => installGithubPublicationRoutes(api, port),
  })
  const post = (path: string, body: unknown) =>
    app.request(`/api/v1/work-items/github/publication/${path}`, {
      method: 'POST',
      headers: {
        cookie: 'session=admin',
        origin: 'http://localhost',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  return { app, port, post }
}
describe('GitHub publication native boundary', () => {
  it('requires a native administrator and rejects anonymous/member reads', async () => {
    const { app, port } = setup()
    expect((await app.request('/api/v1/work-items/github/publication')).status).toBe(401)
    expect(
      (
        await app.request('/api/v1/work-items/github/publication', {
          headers: { cookie: 'session=member' },
        })
      ).status,
    ).toBe(403)
    expect(port.list).not.toHaveBeenCalled()
    expect(
      (
        await app.request('/api/v1/work-items/github/publication', {
          headers: { cookie: 'session=admin' },
        })
      ).status,
    ).toBe(200)
    expect(port.list).toHaveBeenCalledWith({ userId: 2, sessionId: 7 })
  })
  it('passes exact reviewed consent and rejects unknown/private fields', async () => {
    const { post, port } = setup(),
      body = { link_id: 1, source_version: 'a'.repeat(64), command_id: crypto.randomUUID() }
    expect((await post('consent', { ...body, notes: 'private' })).status).toBe(422)
    expect(port.consent).not.toHaveBeenCalled()
    expect((await post('consent', body)).status).toBe(204)
    expect(port.consent).toHaveBeenCalledWith({ userId: 2, sessionId: 7 }, body)
  })
  it('requires explicit confirmation and preserves typed conflict/invalid errors', async () => {
    const { post, port } = setup(),
      body = {
        expected_version: 1,
        action: 'restore',
        confirm: false,
        command_id: crypto.randomUUID(),
      }
    expect((await post('1/actions', body)).status).toBe(422)
    port.act.mockRejectedValueOnce(new GithubPublicationError('conflict'))
    expect((await post('1/actions', { ...body, confirm: true })).status).toBe(409)
    port.act.mockRejectedValueOnce(new GithubPublicationError('invalid'))
    expect((await post('1/actions', { ...body, confirm: true })).status).toBe(422)
  })
})
