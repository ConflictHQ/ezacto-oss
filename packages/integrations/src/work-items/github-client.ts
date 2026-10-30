import { decideGithubRetry, githubApiOrigin, type GithubRetryDecision } from './github-read.js'

const decimalId = (value: string): boolean =>
  /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value))
const maximumResponseBytes = 2_097_152
export class GithubReadError extends Error {
  constructor(
    readonly code:
      'invalid_configuration' | 'invalid_response' | 'transport_unavailable' | 'response_too_large' | 'lost_scope',
    readonly decision?: GithubRetryDecision,
  ) {
    super('GitHub read request could not be completed.')
    this.name = 'GithubReadError'
  }
}
export class GithubHttpError extends Error {
  constructor(
    readonly status: number,
    readonly decision: GithubRetryDecision,
  ) {
    super('GitHub refused the read request.')
    this.name = 'GithubHttpError'
  }
}
const base64url = (bytes: Uint8Array): string =>
  btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
const encodeJson = (value: unknown): string =>
  base64url(new TextEncoder().encode(JSON.stringify(value)))
const der = (tag: number, value: Uint8Array): Uint8Array => {
  let length: number[] = [value.length]
  if (value.length >= 128) {
    const octets: number[] = []
    for (let n = value.length; n > 0; n >>>= 8) octets.unshift(n & 255)
    length = [128 + octets.length, ...octets]
  }
  return new Uint8Array([tag, ...length, ...value])
}
/** GitHub generates PKCS#1 PEM; WebCrypto imports PKCS#8. Wrap, never persist. */
const privateKeyBytes = (pem: string): Uint8Array<ArrayBuffer> => {
  if (pem.length > 32_768 || !/^-----BEGIN (?:RSA )?PRIVATE KEY-----\r?\n/.test(pem))
    throw new GithubReadError('invalid_configuration')
  try {
    const raw = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '')), (c) =>
      c.charCodeAt(0),
    )
    if (pem.startsWith('-----BEGIN PRIVATE KEY-----')) return raw
    const algorithm = [
      0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
    ]
    return der(
      0x30,
      new Uint8Array([0x02, 0x01, 0x00, ...algorithm, ...der(0x04, raw)]),
    ) as Uint8Array<ArrayBuffer>
  } catch {
    throw new GithubReadError('invalid_configuration')
  }
}
export const githubAppJwt = async (appId: string, pem: string, now: number): Promise<string> => {
  if (!decimalId(appId) || !Number.isFinite(now)) throw new GithubReadError('invalid_configuration')
  try {
    const key = await crypto.subtle.importKey(
      'pkcs8',
      privateKeyBytes(pem),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const claims = `${encodeJson({ alg: 'RS256', typ: 'JWT' })}.${encodeJson({ iat: Math.floor(now / 1000) - 60, exp: Math.floor(now / 1000) + 540, iss: appId })}`
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      key,
      new TextEncoder().encode(claims),
    )
    return `${claims}.${base64url(new Uint8Array(signature))}`
  } catch {
    throw new GithubReadError('invalid_configuration')
  }
}
export interface GithubClientOptions {
  readonly appId: string
  readonly privateKey: string
  readonly fetch: (request: Request) => Promise<Response>
  readonly now: () => number
  readonly random?: () => number
}
const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new GithubReadError('invalid_response')
  return value as Record<string, unknown>
}
/** App authentication and issue READS only. No remote mutation API is exposed.
 * Installation-token minting is explicitly repo-scoped, ephemeral and uncached.
 * No automatic HTTP retry: callers durably persist the returned retry decision.
 */
export class GithubReadClient {
  constructor(private readonly options: GithubClientOptions) {
    if (!decimalId(options.appId)) throw new GithubReadError('invalid_configuration')
  }
  async #request(
    path: string,
    authorization: string,
    attempt: number,
    body?: unknown,
  ): Promise<{ value: unknown; headers: Headers }> {
    if (!path.startsWith('/') || path.startsWith('//'))
      throw new GithubReadError('invalid_configuration')
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(), 10_000)
    try {
      let response: Response
      try {
        response = await this.options.fetch(
          new Request(`${githubApiOrigin}${path}`, {
            method: body === undefined ? 'GET' : 'POST',
            redirect: 'manual',
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${authorization}`,
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2026-03-10',
              'User-Agent': 'ezacto-github-reader',
              ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        )
      } catch {
        throw new GithubReadError(
          'transport_unavailable',
          decideGithubRetry({
            status: 503,
            headers: {},
            attempt,
            now: this.options.now(),
            random: this.options.random ?? Math.random,
          }),
        )
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new GithubHttpError(
          response.status,
          decideGithubRetry({
            status: response.status,
            headers: Object.fromEntries(response.headers),
            attempt,
            now: this.options.now(),
            random: this.options.random ?? Math.random,
          }),
        )
      }
      const reader = response.body?.getReader()
      if (!reader) throw new GithubReadError('invalid_response')
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          size += chunk.value.byteLength
          if (size > maximumResponseBytes) {
            await reader.cancel()
            throw new GithubReadError('response_too_large')
          }
          chunks.push(chunk.value)
        }
      } catch (error) {
        if (error instanceof GithubReadError) throw error
        throw new GithubReadError('transport_unavailable')
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      try {
        return {
          value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown,
          headers: response.headers,
        }
      } catch {
        throw new GithubReadError('invalid_response')
      }
    } finally {
      clearTimeout(deadline)
    }
  }
  async installations(
    page = 1,
  ): Promise<{
    items: { id: string; account: string; repository_selection: 'all' | 'selected' }[]
    next_page: number | null
  }> {
    if (!Number.isSafeInteger(page) || page < 1 || page > 100)
      throw new GithubReadError('invalid_configuration')
    const jwt = await githubAppJwt(this.options.appId, this.options.privateKey, this.options.now())
    const response = await this.#request(`/app/installations?per_page=100&page=${page}`, jwt, 1)
    if (!Array.isArray(response.value) || response.value.length > 100)
      throw new GithubReadError('invalid_response')
    const items = response.value
      .map((value) => {
        const row = object(value),
          account = object(row.account),
          permissions = object(row.permissions)
        if (
          !decimalId(String(row.id)) ||
          !decimalId(String(account.id)) ||
          typeof account.login !== 'string' ||
          !/^[A-Za-z0-9-]{1,100}$/.test(account.login) ||
          !['all', 'selected'].includes(String(row.repository_selection)) ||
          !['read', 'write'].includes(String(permissions.issues))
        )
          throw new GithubReadError('invalid_response')
        return {
          ...(row.suspended_at === null ? { active: true } : { active: false }),
          id: String(row.id),
          account: account.login,
          repository_selection: row.repository_selection as 'all' | 'selected',
        }
      })
      .filter((item) => item.active)
      .map((item) => ({
        id: item.id,
        account: item.account,
        repository_selection: item.repository_selection,
      }))
    return {
      items,
      next_page: response.headers.get('link')?.includes('rel="next"') ? page + 1 : null,
    }
  }
  /** Discovery uses metadata-only permissions; issue reads still require the explicit mapped repository. */
  async repositories(
    installationId: string,
    page = 1,
  ): Promise<{ items: { id: string; full_name: string }[]; next_page: number | null }> {
    if (!decimalId(installationId) || !Number.isSafeInteger(page) || page < 1 || page > 100)
      throw new GithubReadError('invalid_configuration')
    await this.installation(installationId)
    const jwt = await githubAppJwt(this.options.appId, this.options.privateKey, this.options.now())
    const token = object(
      (
        await this.#request(`/app/installations/${installationId}/access_tokens`, jwt, 1, {
          permissions: { metadata: 'read' },
        })
      ).value,
    )
    const permissions = object(token.permissions),
      expires = typeof token.expires_at === 'string' ? Date.parse(token.expires_at) : NaN
    if (
      typeof token.token !== 'string' ||
      token.token.length < 1 ||
      token.token.length > 4096 ||
      !Number.isFinite(expires) ||
      expires <= this.options.now() ||
      expires > this.options.now() + 3660000 ||
      permissions.metadata !== 'read' ||
      Object.entries(permissions).some(([name, access]) => name !== 'metadata' && access !== 'none')
    )
      throw new GithubReadError('invalid_response')
    const response = await this.#request(
      `/installation/repositories?per_page=100&page=${page}`,
      token.token,
      1,
    )
    const value = object(response.value)
    if (!Array.isArray(value.repositories) || value.repositories.length > 100)
      throw new GithubReadError('invalid_response')
    const items = value.repositories.map((value) => {
      const row = object(value)
      if (
        !decimalId(String(row.id)) ||
        typeof row.full_name !== 'string' ||
        !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(row.full_name) ||
        row.full_name.length > 140
      )
        throw new GithubReadError('invalid_response')
      return { id: String(row.id), full_name: row.full_name }
    })
    return {
      items,
      next_page: response.headers.get('link')?.includes('rel="next"') ? page + 1 : null,
    }
  }
  async installation(
    installationId: string,
  ): Promise<{ accountId: string; repositorySelection: 'all' | 'selected' }> {
    if (!decimalId(installationId)) throw new GithubReadError('invalid_configuration')
    const jwt = await githubAppJwt(this.options.appId, this.options.privateKey, this.options.now())
    const result = object(
      (await this.#request(`/app/installations/${installationId}`, jwt, 1)).value,
    )
    const account = object(result.account)
    const permissions = object(result.permissions)
    if (
      String(result.id) !== installationId ||
      !decimalId(String(account.id)) ||
      result.suspended_at !== null ||
      !['read', 'write'].includes(String(permissions.issues)) ||
      (result.repository_selection !== 'all' && result.repository_selection !== 'selected')
    )
      throw new GithubReadError('invalid_response')
    return { accountId: String(account.id), repositorySelection: result.repository_selection }
  }
  async #token(
    installationId: string,
    repositoryId: string,
    attempt: number,
  ): Promise<{ token: string; fullName: string }> {
    if (!decimalId(installationId) || !decimalId(repositoryId))
      throw new GithubReadError('invalid_configuration')
    const jwt = await githubAppJwt(this.options.appId, this.options.privateKey, this.options.now())
    const result = object(
      (
        await this.#request(`/app/installations/${installationId}/access_tokens`, jwt, attempt, {
          repository_ids: [Number(repositoryId)],
          permissions: { issues: 'read', metadata: 'read' },
        })
      ).value,
    )
    const expires = typeof result.expires_at === 'string' ? Date.parse(result.expires_at) : NaN
    const permissions = object(result.permissions)
    // Prove the issued token has precisely the requested repository, never broader.
    const repositories = result.repositories
    if (
      typeof result.token !== 'string' ||
      result.token.length < 1 ||
      result.token.length > 4096 ||
      !Number.isFinite(expires) ||
      expires <= this.options.now() ||
      expires > this.options.now() + 3_660_000 ||
      permissions.issues !== 'read' ||
      permissions.metadata !== 'read' ||
      Object.entries(permissions).some(
        ([name, access]) => !['issues', 'metadata'].includes(name) && access !== 'none',
      ) ||
      !Array.isArray(repositories) ||
      repositories.length !== 1 ||
      String(object(repositories[0]).id) !== repositoryId
    )
      throw new GithubReadError('invalid_response')
    const fullName = object(repositories[0]).full_name
    if (
      typeof fullName !== 'string' ||
      !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(fullName) ||
      fullName.length > 140
    )
      throw new GithubReadError('invalid_response')
    return { token: result.token, fullName }
  }
  async repository(
    installationId: string,
    repositoryId: string,
    attempt = 1,
  ): Promise<{ repositoryId: string; fullName: string; accountId: string }> {
    const token = await this.#token(installationId, repositoryId, attempt)
    const result = object(
      (await this.#request(`/repos/${token.fullName}`, token.token, attempt)).value,
    )
    const owner = object(result.owner)
    if (
      String(result.id) !== repositoryId ||
      typeof result.full_name !== 'string' ||
      !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(result.full_name) ||
      !decimalId(String(owner.id))
    )
      throw new GithubReadError('invalid_response')
    return { repositoryId, fullName: result.full_name, accountId: String(owner.id) }
  }
  async issues(input: {
    installationId: string
    repositoryId: string
    page: number
    since: string | null
    attempt: number
  }): Promise<{ issues: readonly unknown[]; nextPage: number | null }> {
    if (
      !Number.isSafeInteger(input.page) ||
      input.page < 1 ||
      input.page > 10_000 ||
      !Number.isInteger(input.attempt) ||
      input.attempt < 1 ||
      input.attempt > 5 ||
      (input.since !== null && !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(input.since))
    )
      throw new GithubReadError('invalid_configuration')
    const token = await this.#token(input.installationId, input.repositoryId, input.attempt)
    const query = new URLSearchParams({
      state: 'all',
      sort: 'updated',
      direction: 'asc',
      per_page: '100',
      page: String(input.page),
    })
    if (input.since !== null) query.set('since', input.since)
    const result = await this.#request(
      `/repos/${token.fullName}/issues?${query}`,
      token.token,
      input.attempt,
    )
    if (!Array.isArray(result.value) || result.value.length > 100)
      throw new GithubReadError('invalid_response')
    // Never follow provider Link URLs (or forward Authorization to them). Construct the next fixed-origin page locally.
    const hasNext = /;\s*rel="next"/.test(result.headers.get('link') ?? '')
    if (hasNext && (result.value.length === 0 || input.page === 10_000))
      throw new GithubReadError('invalid_response')
    return { issues: result.value, nextPage: hasNext ? input.page + 1 : null }
  }
}
