import { githubAppJwt, GithubReadError } from './github-client.js'
import {
  AmbiguousWriteError,
  CooldownError,
  type CommentSurface,
  type RemoteComment,
} from './publication.js'

const decimal = (value: string) =>
  /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value))
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

export interface GithubCommentOptions {
  appId: string
  privateKey: string
  installationId: string
  repositoryId: string
  accountId: string
  fetch(request: Request): Promise<Response>
  now(): number
  /** Recheck native connection, policy, source and lease immediately before a write. */
  beforeWrite(): Promise<boolean>
}

/** Installation token narrowed to ONE repository and Issues write. No token is
 * returned to a caller or browser. All redirects fail closed. */
export async function createGithubCommentSurface(
  options: GithubCommentOptions,
): Promise<CommentSurface> {
  for (const value of [
    options.appId,
    options.installationId,
    options.repositoryId,
    options.accountId,
  ])
    if (!decimal(value)) throw new GithubReadError('invalid_configuration')
  const request = async (path: string, token: string, method = 'GET', body?: unknown) => {
    const mutation = method !== 'GET'
    let response: Response
    try {
      response = await options.fetch(
        new Request(`https://api.github.com${path}`, {
          method,
          redirect: 'manual',
          signal: AbortSignal.timeout(10000),
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2026-03-10',
            'User-Agent': 'ezacto',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      )
    } catch {
      if (mutation) throw new AmbiguousWriteError()
      throw new GithubReadError('transport_unavailable')
    }
    if (
      response.status === 429 ||
      (response.status === 403 && response.headers.has('retry-after'))
    ) {
      const seconds = Number(response.headers.get('retry-after'))
      throw new CooldownError(
        Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 86400000) : 60000,
      )
    }
    if (response.status >= 500 && mutation) throw new AmbiguousWriteError()
    if (response.status === 404 && method === 'GET')
      return { value: null, headers: response.headers }
    if (!response.ok || response.status >= 300)
      throw new GithubReadError(
        response.status === 401 || response.status === 403 ? 'lost_scope' : 'invalid_response',
      )
    if (response.status === 204) return { value: null, headers: response.headers }
    try {
      const reader = response.body?.getReader()
      if (!reader) throw new Error('empty')
      const chunks: Uint8Array[] = []
      let length = 0
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        length += chunk.value.byteLength
        if (length > 2 * 1024 * 1024) {
          await reader.cancel()
          throw new Error('large')
        }
        chunks.push(chunk.value)
      }
      const data = new Uint8Array(length)
      let offset = 0
      for (const chunk of chunks) {
        data.set(chunk, offset)
        offset += chunk.byteLength
      }
      return {
        value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)) as unknown,
        headers: response.headers,
      }
    } catch {
      if (mutation) throw new AmbiguousWriteError()
      throw new GithubReadError('invalid_response')
    }
  }
  const jwt = await githubAppJwt(options.appId, options.privateKey, options.now())
  const installation = object(
    (await request(`/app/installations/${options.installationId}`, jwt)).value,
  )
  if (
    String(installation.id) !== options.installationId ||
    installation.suspended_at !== null ||
    String(object(installation.account).id) !== options.accountId ||
    object(installation.permissions).issues !== 'write'
  )
    throw new GithubReadError('lost_scope')
  const grant = object(
    (
      await request(`/app/installations/${options.installationId}/access_tokens`, jwt, 'POST', {
        repository_ids: [Number(options.repositoryId)],
        permissions: { issues: 'write', metadata: 'read' },
      })
    ).value,
  )
  const permissions = object(grant.permissions)
  const repositories = grant.repositories
  const expires = typeof grant.expires_at === 'string' ? Date.parse(grant.expires_at) : NaN
  if (
    typeof grant.token !== 'string' ||
    !grant.token ||
    grant.token.length > 4096 ||
    !Number.isFinite(expires) ||
    expires <= options.now() ||
    expires > options.now() + 3660000 ||
    permissions.issues !== 'write' ||
    permissions.metadata !== 'read' ||
    Object.entries(permissions).some(
      ([key, value]) => !['issues', 'metadata'].includes(key) && value !== 'none',
    ) ||
    !Array.isArray(repositories) ||
    repositories.length !== 1 ||
    String(object(repositories[0]).id) !== options.repositoryId
  )
    throw new GithubReadError('invalid_response')
  const token = grant.token
  const name = object(repositories[0]).full_name
  if (
    typeof name !== 'string' ||
    !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(name) ||
    name.length > 140
  )
    throw new GithubReadError('invalid_response')
  const repo = object((await request(`/repos/${name}`, token)).value)
  if (
    String(repo.id) !== options.repositoryId ||
    String(object(repo.owner).id) !== options.accountId ||
    repo.full_name !== name
  )
    throw new GithubReadError('lost_scope')
  const author = `github-app:${options.appId}`
  const comment = (value: unknown): RemoteComment => {
    const row = object(value),
      user = object(row.user),
      app = object(row.performed_via_github_app)
    if (!decimal(String(row.id)) || typeof row.body !== 'string' || row.body.length > 65536)
      throw new GithubReadError('invalid_response')
    // GitHub's official issue-comment schema identifies the performing App. A
    // lookalike marker or a human comment is never sufficient proof of custody.
    return {
      id: String(row.id),
      body: row.body,
      authorId:
        user.type === 'Bot' && decimal(String(user.id)) && String(app.id) === options.appId
          ? author
          : 'other',
    }
  }
  const issuePath = (id: string) => {
    if (!decimal(id)) throw new GithubReadError('invalid_configuration')
    return `/repos/${name}/issues/${id}/comments`
  }
  const commentPath = (id: string) => {
    if (!decimal(id)) throw new GithubReadError('invalid_configuration')
    return `/repos/${name}/issues/comments/${id}`
  }
  const write = async (path: string, method: string, body?: string) => {
    if (expires <= options.now() || !(await options.beforeWrite()))
      throw new GithubReadError('lost_scope')
    const result = await request(path, token, method, body === undefined ? undefined : { body })
    if (method === 'DELETE') return null
    try {
      const value = comment(result.value)
      if (value.authorId !== author || value.body !== body) throw new Error('unproven')
      return value
    } catch {
      throw new AmbiguousWriteError()
    }
  }
  return {
    appAuthorId: author,
    async listComments(itemId) {
      const comments: RemoteComment[] = []
      for (let page = 1; page <= 5; page++) {
        const response = await request(`${issuePath(itemId)}?per_page=100&page=${page}`, token)
        if (!Array.isArray(response.value) || response.value.length > 100)
          throw new GithubReadError('invalid_response')
        comments.push(...response.value.map(comment))
        if (!/;\s*rel="next"/.test(response.headers.get('link') ?? ''))
          return { comments, complete: true }
      }
      return { comments, complete: false }
    },
    async getComment(itemId, id) {
      issuePath(itemId)
      const response = await request(commentPath(id), token)
      return response.value === null ? null : comment(response.value)
    },
    async createComment(itemId, body) {
      return (await write(issuePath(itemId), 'POST', body))!
    },
    async updateComment(itemId, id, body) {
      issuePath(itemId)
      return (await write(commentPath(id), 'PATCH', body))!
    },
    async deleteComment(itemId, id) {
      issuePath(itemId)
      await write(commentPath(id), 'DELETE')
    },
  }
}
