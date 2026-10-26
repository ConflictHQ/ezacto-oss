import { describe, expect, it, vi } from 'vitest'
import { createApiApp } from '../src/app.js'
import {
  installGithubReaderRoutes,
  installGithubReaderWebhookRoute,
  GithubReaderApiError,
  type GithubReaderApiPort,
  type GithubReaderWebhookPort,
} from '../src/github-reader.js'

const mapping = {
  command_id: 'a1234567-1234-4123-8123-123456789012',
  expected_generation: 0,
  installation_id: '11',
  repository_id: '22',
  project_id: 1,
  task_id: 2,
}
const fixture = () => {
  const port = {
    installations: vi.fn(async () => ({ items: [], next_page: null })),
    repositories: vi.fn(async () => ({ items: [], next_page: null })),
    beginSetup: vi.fn(async () => ({
      registration_url: 'https://github.com/settings/apps/new?state=fixture',
      manifest: '{}',
    })),
    completeSetup: vi.fn(async () => undefined),
    status: vi.fn(async () => ({
      app: null,
      configured: false,
      setup_supported: true,
      available: false,
      owned_acceptance_required: true as const,
      connections: [],
    })),
    map: vi.fn(async () => ({ connection_id: '1:11:3', generation: 1 })),
    disconnect: vi.fn(async () => ({ generation: 2 })),
    reconcile: vi.fn(async () => {}),
    linkedItem: vi.fn<GithubReaderApiPort['linkedItem']>().mockResolvedValue(null),
  } satisfies GithubReaderApiPort
  const receive = vi.fn<GithubReaderWebhookPort['receive']>(async () => 'applied' as const)
  const app = createApiApp({
    authentication: {
      tokens: {
        authenticate: async (token) =>
          token === 'token'
            ? {
                tokenId: 1,
                userId: 2,
                profile: 'administrator' as const,
                scopes: ['time_entries:read' as const],
              }
            : null,
        issue: vi.fn(),
        list: vi.fn(),
        revoke: vi.fn(),
      },
      sessions: {
        resolve: async (request: Request) =>
          request.headers.get('cookie')?.startsWith('session=')
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
    installApi: (api) => installGithubReaderRoutes(api, port),
    installApp: (app) => installGithubReaderWebhookRoute(app, { receive }),
  })
  const post = (path: string, body: unknown, headers = {}) =>
    app.request(`/api/v1/work-items/github/${path}`, {
      method: 'POST',
      headers: {
        cookie: 'session=admin',
        origin: 'http://localhost',
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
    })
  return { app, port, receive, post }
}
describe('native GitHub reader boundary', () => {
  it('limits installation and repository discovery to native administrators and valid pages', async () => {
    const { app, port } = fixture()
    expect(
      (
        await app.request('/api/v1/work-items/github/installations', {
          headers: { authorization: 'Bearer token' },
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await app.request('/api/v1/work-items/github/repositories?installation_id=22&page=101', {
          headers: { cookie: 'session=admin' },
        })
      ).status,
    ).toBe(422)
    expect(port.repositories).not.toHaveBeenCalled()
    expect(
      (
        await app.request('/api/v1/work-items/github/installations?page=2', {
          headers: { cookie: 'session=admin' },
        })
      ).status,
    ).toBe(200)
    expect(port.installations).toHaveBeenCalledWith({ userId: 2, sessionId: 7 }, 2)
    expect(
      (
        await app.request('/api/v1/work-items/github/repositories?installation_id=22', {
          headers: { cookie: 'session=admin' },
        })
      ).status,
    ).toBe(200)
    expect(port.repositories).toHaveBeenCalledWith({ userId: 2, sessionId: 7 }, '22', 1)
  })
  it('starts a reviewed manifest only for administrators and finishes without exposing credentials', async () => {
    const { app, post, port } = fixture()
    expect((await post('setup', {}, { cookie: 'session=member' })).status).toBe(403)
    expect((await post('setup', { organization: 'bad/org' })).status).toBe(422)
    expect(port.beginSetup).not.toHaveBeenCalled()
    expect((await post('setup', { organization: 'ConflictHQ' })).status).toBe(200)
    expect(port.beginSetup).toHaveBeenCalledWith({ userId: 2, sessionId: 7 }, 'ConflictHQ')
    const response = await app.request(
      '/api/v1/work-items/github/setup/callback?state=state&code=code',
      { headers: { cookie: 'session=admin' } },
    )
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe(
      '/settings/company?github_setup=complete#work-items',
    )
    expect(port.completeSetup).toHaveBeenCalledWith({ userId: 2, sessionId: 7 }, 'state', 'code')
    expect(await response.text()).not.toContain('PRIVATE KEY')
  })
  it('keeps mapping to a current native administrator and returns no credential fields', async () => {
    const { post, port } = fixture()
    expect((await post('repositories', mapping, { cookie: 'session=member' })).status).toBe(403)
    expect(
      (
        await post('repositories', mapping, {
          cookie: '',
          authorization: 'Bearer token',
        })
      ).status,
    ).toBe(403)
    expect(port.map).not.toHaveBeenCalled()
    const response = await post('repositories', mapping)
    expect(response.status).toBe(200)
    expect(port.map).toHaveBeenCalledWith({ userId: 2, sessionId: 7 }, mapping)
    expect(await response.json()).toEqual({
      data: { connection_id: '1:11:3', generation: 1 },
    })
  })
  it.each([
    { ...mapping, repository_id: 'https://elsewhere.test' },
    { ...mapping, project_id: 0 },
    { ...mapping, credential: 'not-accepted' },
  ])('rejects invalid mapping before calling the provider', async (body) => {
    const { post, port } = fixture()
    expect((await post('repositories', body)).status).toBe(422)
    expect(port.map).not.toHaveBeenCalled()
  })
  it('preserves native authority failures without leaking provider diagnostics', async () => {
    const { post, port } = fixture()
    port.map.mockRejectedValueOnce(new GithubReaderApiError('forbidden'))
    expect((await post('repositories', mapping)).status).toBe(403)
    port.map.mockRejectedValueOnce(new GithubReaderApiError('invalid'))
    expect((await post('repositories', mapping)).status).toBe(422)
  })
  it('checks link access independently from administrator integration management', async () => {
    const { app, port } = fixture()
    const missing = await app.request('/api/v1/work-item-links/1/github', {
      headers: { cookie: 'session=member' },
    })
    expect(missing.status).toBe(404)
    expect(port.linkedItem).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 2, profile: 'member' }),
      1,
    )
    port.linkedItem.mockResolvedValueOnce({ status: 'unverified', item: null })
    const response = await app.request('/api/v1/work-item-links/1/github', {
      headers: { cookie: 'session=member' },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: { status: 'unverified', item: null },
    })
  })
  it('passes bounded original webhook bytes to the verifier without a browser session', async () => {
    const { app, receive } = fixture()
    const raw = ' { "installation": { "id": 11 } }\n'
    const response = await app.request('/webhooks/github-work-items', {
      method: 'POST',
      headers: {
        'x-hub-signature-256': 'sha256=original',
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery-1',
      },
      body: raw,
    })
    expect(response.status).toBe(202)
    expect(new TextDecoder().decode(receive.mock.calls[0]![0])).toBe(raw)
    expect(receive.mock.calls[0]![1]).toEqual({
      signature: 'sha256=original',
      event: 'issues',
      deliveryId: 'delivery-1',
    })
    expect(
      (
        await app.request('/webhooks/github-work-items', {
          method: 'POST',
          body: 'x'.repeat(1048577),
        })
      ).status,
    ).toBe(413)
    expect(receive).toHaveBeenCalledOnce()
  })
})
