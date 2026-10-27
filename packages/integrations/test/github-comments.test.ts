import { beforeAll, describe, expect, it } from 'vitest'
import {
  createGithubCommentSurface,
  type GithubCommentOptions,
} from '../src/work-items/github-comments.js'
import { AmbiguousWriteError } from '../src/work-items/publication.js'
let pem: string
const now = Date.parse('2026-10-26T00:00:00Z')
beforeAll(async () => {
  const keys = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )
  pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----`
})
const fixture = (handler: (request: Request) => Promise<Response> | Response, permit = true) => {
  const calls: Request[] = []
  const options: GithubCommentOptions = {
    appId: '11',
    issueId: '900',
    privateKey: pem,
    installationId: '22',
    repositoryId: '77',
    accountId: '33',
    now: () => now,
    beforeWrite: async () => permit,
    fetch: async (request) => {
      calls.push(request)
      const path = new URL(request.url).pathname
      if (path === '/app/installations/22')
        return Response.json({
          id: 22,
          account: { id: 33 },
          suspended_at: null,
          permissions: { issues: 'write' },
        })
      if (path === '/app/installations/22/access_tokens') {
        expect(await request.json()).toEqual({
          repository_ids: [77],
          permissions: { issues: 'write', metadata: 'read' },
        })
        return Response.json({
          token: 'owned-token',
          expires_at: new Date(now + 3600000).toISOString(),
          permissions: { issues: 'write', metadata: 'read' },
          repositories: [{ id: 77, full_name: 'owned/repo' }],
        })
      }
      if (path === '/repos/owned/repo')
        return Response.json({ id: 77, full_name: 'owned/repo', owner: { id: 33 } })
      if (path === '/repos/owned/repo/issues/5') return Response.json({ id: 900 })
      return handler(request)
    },
  }
  return { options, calls }
}
describe('GitHub issue comment HTTP boundary', () => {
  it('[security] requires both authorized App and Bot identity, never follows a listing URL', async () => {
    const { options, calls } = fixture(() =>
      Response.json(
        [
          {
            id: 1,
            body: 'marker',
            user: { id: 100, type: 'User' },
            performed_via_github_app: { id: 11 },
          },
          {
            id: 2,
            body: 'marker',
            user: { id: 100, type: 'Bot' },
            performed_via_github_app: { id: 12 },
          },
          {
            id: 3,
            body: 'marker',
            user: { id: 100, type: 'Bot' },
            performed_via_github_app: { id: 11 },
          },
        ],
        { headers: { link: '<https://foreign.example/secrets>; rel="next"' } },
      ),
    )
    const api = await createGithubCommentSurface(options),
      listing = await api.listComments('5')
    expect(listing.complete).toBe(false)
    expect(
      listing.comments.filter((c) => c.authorId === api.appAuthorId).every((c) => c.id === '3'),
    ).toBe(true)
    expect(calls).toHaveLength(8)
    expect(
      calls.every(
        (c) => new URL(c.url).origin === 'https://api.github.com' && c.redirect === 'manual',
      ),
    ).toBe(true)
  })
  it('[unit] honors the primary GitHub reset when the quota is exhausted without Retry-After', async () => {
    const { options } = fixture(
      () =>
        new Response(null, {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 3600) },
        }),
    )
    const api = await createGithubCommentSurface(options)
    await expect(api.listComments('5')).rejects.toMatchObject({ retryAfterMs: 3600000 })
  })
  it('[security] refuses remote writes after the native permit is revoked', async () => {
    let writes = 0
    const { options } = fixture(() => {
      writes++
      return Response.json({})
    }, false)
    const api = await createGithubCommentSurface(options)
    await expect(api.createComment('5', 'body')).rejects.toThrow()
    expect(writes).toBe(0)
  })
  it('[unit] classifies lost response or unverifiable success as ambiguous, preserving journal intent', async () => {
    const { options } = fixture(() =>
      Response.json(
        {
          id: 1,
          body: 'body',
          user: { id: 100, type: 'User' },
          performed_via_github_app: { id: 11 },
        },
        { status: 201 },
      ),
    )
    const api = await createGithubCommentSurface(options)
    await expect(api.createComment('5', 'body')).rejects.toBeInstanceOf(AmbiguousWriteError)
  })
  it('[security] refuses redirects and nonnumeric issue/comment destinations', async () => {
    const { options } = fixture(
      () => new Response(null, { status: 302, headers: { location: 'https://foreign.example' } }),
    )
    const api = await createGithubCommentSurface(options)
    await expect(api.listComments('5')).rejects.toThrow()
    await expect(api.createComment('../secrets', 'body')).rejects.toThrow()
  })
})
