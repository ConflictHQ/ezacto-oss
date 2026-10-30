import { describe, expect, it, vi } from 'vitest'
import {
  createApiApp,
  installBackupDownloadMintRoute,
  installBackupDownloadRedeemRoute,
  type ActivityCaptureRequest,
  type ApiAuthentication,
  type ApiTokenService,
  type BackupDownloadService,
  type UserProfile,
} from '../src/index.js'

const now = '2026-10-19T12:00:00.000Z'
const goodCode = '123456'

const bearer = 'backup-download-test-bearer'

const authentication: ApiAuthentication = {
  sessions: {
    resolve: async (request) => {
      const profile = request.headers.get('x-test-profile') as UserProfile | null
      if (profile === null) return null
      return {
        type: 'user',
        userId: 7,
        profile,
        managerGrants: [],
        authentication: { kind: 'session', sessionId: 'backup-download-test' },
      }
    },
  },
  // Only `authenticate` is reached: an administrator's token, for the refusal.
  tokens: {
    authenticate: async (token) =>
      token === bearer
        ? { tokenId: 1, userId: 7, profile: 'administrator', scopes: ['reports:read'] }
        : null,
  } as ApiTokenService,
}

interface Link {
  id: number
  token: string
  runId: number
  userId: number
  spent: boolean
}

const bytes = new Uint8Array([80, 75, 5, 6])

/** The store's rules in memory: one spend per link, completed runs only. */
const harness = (
  options: {
    enrolled?: boolean
    locked?: boolean
    allowed?: (scope: 'mint' | 'redeem') => boolean
    origin?: string | null
    openFails?: boolean
    completedRuns?: number[]
  } = {},
) => {
  const links: Link[] = []
  const captured: ActivityCaptureRequest[] = []
  const completedRuns = options.completedRuns ?? [4]
  const service = {
    origin: options.origin === undefined ? 'https://app.example.test/' : options.origin,
    allow: vi.fn(async (scope: 'mint' | 'redeem') => options.allowed?.(scope) ?? true),
    latestCompletedRunId: vi.fn(async () => completedRuns.at(-1) ?? null),
    mint: vi.fn(async (input: { backupRunId: number; userId: number; now: string }) => {
      if (!completedRuns.includes(input.backupRunId)) return null
      const link: Link = {
        id: links.length + 1,
        token: String.fromCharCode(65 + links.length).repeat(43),
        runId: input.backupRunId,
        userId: input.userId,
        spent: false,
      }
      links.push(link)
      return {
        id: link.id,
        token: link.token,
        backupRunId: link.runId,
        expiresAt: '2026-10-19T12:10:00.000Z',
      }
    }),
    redeem: vi.fn(async (token: string) => {
      const link = links.find((candidate) => candidate.token === token && !candidate.spent)
      if (link === undefined) return null
      link.spent = true
      return { id: link.id, backupRunId: link.runId, createdByUserId: link.userId }
    }),
    openArchive: vi.fn(async () => {
      if (options.openFails === true) throw new Error('manifest_mismatch for run 4 in client Acme')
      return {
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes)
            controller.close()
          },
        }),
        filename: 'ezacto-backup-2026-10-18.zip',
      }
    }),
    secondFactor: {
      isEnrolled: vi.fn(async () => options.enrolled === true),
      verifyCode: vi.fn(async (_userId: number, code: string) =>
        options.locked === true ? ('locked' as const) : code === goodCode ? ('accepted' as const) : ('rejected' as const),
      ),
    },
  } satisfies BackupDownloadService
  const activity = {
    capture: vi.fn(async (request: ActivityCaptureRequest) => void captured.push(request)),
  }
  const app = createApiApp({
    authentication,
    installApi(api) {
      installBackupDownloadMintRoute(api, { service, activity, clock: () => now })
    },
    installApp(root) {
      installBackupDownloadRedeemRoute(root, {
        service,
        activity,
        clock: () => now,
        clientKey: (request) => request.headers.get('cf-connecting-ip') ?? 'unknown-client',
      })
    },
  })
  return { app, service, links, captured, activity }
}

const mint = (
  app: ReturnType<typeof harness>['app'],
  body: unknown = {},
  headers: Record<string, string> = {},
) =>
  app.request('/api/v1/backup/download-links', {
    method: 'POST',
    headers: {
      'x-test-profile': 'administrator',
      'content-type': 'application/json',
      origin: 'http://localhost',
      ...headers,
    },
    body: JSON.stringify(body),
  })

const hardened = (response: Response): void => {
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(response.headers.get('set-cookie')).toBeNull()
}

describe('backup download links: minting', () => {
  it('[api] gives an administrator a no-store link to the latest completed run', async () => {
    const { app, links } = harness()
    const response = await mint(app)
    expect(response.status).toBe(201)
    hardened(response)
    const body = (await response.json()) as {
      data: { id: number; run_id: number; url: string; expires_at: string }
    }
    expect(body.data).toEqual({
      id: 1,
      run_id: 4,
      url: `https://app.example.test/backup-download/${links[0]!.token}`,
      expires_at: '2026-10-19T12:10:00.000Z',
    })
  })

  it('[api] gives a path where no origin is configured', async () => {
    const { app, links } = harness({ origin: null })
    const body = (await (await mint(app)).json()) as { data: { url: string } }
    expect(body.data.url).toBe(`/backup-download/${links[0]!.token}`)
  })

  it('[api] refuses an API token, even an administrator one', async () => {
    const { app, service } = harness()
    const response = await mint(app, {}, { authorization: `Bearer ${bearer}` })
    expect(response.status).toBe(403)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'session_required',
    )
    expect(service.mint).not.toHaveBeenCalled()
  })

  it('[api] refuses every profile but administrator, and anonymous callers', async () => {
    const { app, service } = harness()
    for (const profile of ['member', 'project_manager', 'people_admin', 'accounting', 'executive_manager']) {
      const response = await mint(app, {}, { 'x-test-profile': profile })
      expect(response.status).toBe(403)
    }
    const anonymous = await app.request('/api/v1/backup/download-links', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      body: '{}',
    })
    expect(anonymous.status).toBe(401)
    expect(service.mint).not.toHaveBeenCalled()
  })

  it('[api] is rate limited before the body or a code is read', async () => {
    const { app, service } = harness({ allowed: () => false, enrolled: true })
    const response = await mint(app, { code: goodCode })
    expect(response.status).toBe(429)
    expect(service.secondFactor.verifyCode).not.toHaveBeenCalled()
    expect(service.mint).not.toHaveBeenCalled()
  })

  it('[api] needs a fresh code where a factor is enrolled, and not otherwise', async () => {
    const enrolled = harness({ enrolled: true })
    const missing = await mint(enrolled.app)
    expect(missing.status).toBe(401)
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe(
      'two_factor_code_required',
    )
    const wrong = await mint(enrolled.app, { code: '000000' })
    expect(wrong.status).toBe(401)
    expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe(
      'invalid_two_factor_code',
    )
    expect(enrolled.service.mint).not.toHaveBeenCalled()
    expect((await mint(enrolled.app, { code: goodCode })).status).toBe(201)

    const unenrolled = harness()
    expect((await mint(unenrolled.app)).status).toBe(201)
    expect(unenrolled.service.secondFactor.verifyCode).not.toHaveBeenCalled()
  })

  it('[api] says nothing precise about a locked factor', async () => {
    const { app, service } = harness({ enrolled: true, locked: true })
    const response = await mint(app, { code: goodCode })
    expect(response.status).toBe(429)
    expect(service.mint).not.toHaveBeenCalled()
  })

  it('[api] is a plain not-found when there is no completed run to export', async () => {
    const none = harness({ completedRuns: [] })
    expect((await mint(none.app)).status).toBe(404)
    const wrongRun = harness()
    expect((await mint(wrongRun.app, { run_id: 99 })).status).toBe(404)
    expect(none.captured).toEqual([])
  })

  it('[api] validates its body', async () => {
    const { app, service } = harness()
    for (const body of [[], 'x', { run_id: 0 }, { run_id: 'a' }, { code: '' }, { code: 5 }, { extra: 1 }]) {
      expect((await mint(app, body)).status).toBe(422)
    }
    expect(service.mint).not.toHaveBeenCalled()
  })

  it('[api] records the mint against the administrator and the run, without the token', async () => {
    const { app, captured, links } = harness()
    await mint(app)
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({
      eventType: 'backup.exported',
      subjectId: 4,
      actor: { type: 'user', id: 7 },
      occurredAt: now,
      detail: { phase: 'link_minted', link_id: 1 },
    })
    expect(JSON.stringify(captured)).not.toContain(links[0]!.token)
  })
})

describe('backup download links: redeeming', () => {
  const redeem = (app: ReturnType<typeof harness>['app'], token: string, ip = '203.0.113.9') =>
    app.request(`/backup-download/${token}`, { headers: { 'cf-connecting-ip': ip } })

  it('[api] streams the archive to a bare link, once, and records the download', async () => {
    const { app, links, captured } = harness()
    await mint(app)
    const response = await redeem(app, links[0]!.token)
    expect(response.status).toBe(200)
    hardened(response)
    expect(response.headers.get('content-type')).toBe('application/zip')
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="ezacto-backup-2026-10-18.zip"',
    )
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
    expect(captured).toHaveLength(2)
    expect(captured[1]).toMatchObject({
      eventType: 'backup.exported',
      subjectId: 4,
      actor: { type: 'system' },
      captureId: 'backup-download-1',
      detail: { phase: 'downloaded', link_id: 1, minted_by: 7 },
    })
    expect(JSON.stringify(captured)).not.toContain(links[0]!.token)
  })

  it('[api] answers one plain 404 to a second use, a stranger, and a malformed token alike', async () => {
    const { app, links } = harness()
    await mint(app)
    expect((await redeem(app, links[0]!.token)).status).toBe(200)
    const refusals = await Promise.all([
      redeem(app, links[0]!.token),
      redeem(app, 'Z'.repeat(43)),
      redeem(app, 'short'),
      redeem(app, `${'A'.repeat(42)}%21`),
    ])
    const shapes = await Promise.all(
      refusals.map(async (response) => ({
        status: response.status,
        type: response.headers.get('content-type'),
        cache: response.headers.get('cache-control'),
        body: await response.text(),
      })),
    )
    for (const shape of shapes) {
      expect(shape).toEqual({
        status: 404,
        type: 'text/plain; charset=utf-8',
        cache: 'no-store',
        body: 'Not found',
      })
    }
  })

  it('[api] refuses a bundle that cannot be served intact with the same 404 and no log', async () => {
    const { app, links, captured } = harness({ openFails: true })
    await mint(app)
    const response = await redeem(app, links[0]!.token)
    expect(response.status).toBe(404)
    const body = await response.text()
    expect(body).toBe('Not found')
    expect(body).not.toContain('Acme')
    // Only the mint is on record: nothing left.
    expect(captured.map((event) => (event.detail as { phase: string }).phase)).toEqual([
      'link_minted',
    ])
  })

  it('[api] is rate limited before the token is looked at', async () => {
    const { app, service } = harness({ allowed: (scope) => scope !== 'redeem' })
    const response = await redeem(app, 'A'.repeat(43))
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('60')
    expect(service.redeem).not.toHaveBeenCalled()
  })

  it('[api] needs no session and never sets a cookie', async () => {
    const { app, links } = harness()
    await mint(app)
    const response = await redeem(app, links[0]!.token)
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('[api] fails the request, not silently, when the log cannot be written', async () => {
    const { app, links, activity } = harness()
    await mint(app)
    activity.capture.mockRejectedValueOnce(new Error('log down'))
    const response = await redeem(app, links[0]!.token)
    expect(response.status).toBeGreaterThanOrEqual(500)
  })
})
