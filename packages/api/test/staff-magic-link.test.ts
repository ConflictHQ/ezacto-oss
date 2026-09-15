import { describe, expect, it, vi } from 'vitest'
import {
  createApiApp,
  installStaffMagicLinkRoutes,
  type OidcAppCodeStorePort,
  type StaffMagicLinkDelivery,
  type StaffMagicLinkFlow,
  type StaffMagicLinkStorePort,
} from '../src/index.js'

const fixedNow = '2026-08-28T12:00:00.000Z'
const CODE_KEY = new Uint8Array(32).fill(7)

interface Record {
  userId: number
  tokenHash: string
  codeHash: string
  flow: StaffMagicLinkFlow
  attempts: number
  expiresAt: string
  consumedAt: string | null
  createdAt: string
}

class MemoryMagicLinks implements StaffMagicLinkStorePort {
  readonly rows: Record[] = []

  async create(input: {
    userId: number
    tokenHash: string
    codeHash: string
    flow: StaffMagicLinkFlow
    expiresAt: string
    createdAt: string
    cleanupBefore: string
  }): Promise<'created' | 'collision'> {
    if (this.rows.some((r) => r.tokenHash === input.tokenHash)) return 'collision'
    this.rows.push({ ...input, attempts: 0, consumedAt: null })
    return 'created'
  }

  private active(now: string) {
    return this.rows.filter(
      (r) => r.consumedAt === null && Date.parse(r.expiresAt) > Date.parse(now)
    )
  }

  async consumeByToken(tokenHash: string, now: string) {
    const row = this.active(now).find((r) => r.tokenHash === tokenHash)
    if (row === undefined) return null
    row.consumedAt = now
    return { userId: row.userId, flow: row.flow }
  }

  async consumeByCode(userId: number, codeHash: string, now: string, max: number) {
    const row = this.active(now).find(
      (r) => r.userId === userId && r.attempts < max
    )
    if (row === undefined) return null
    if (row.codeHash === codeHash) {
      row.consumedAt = now
      return { userId: row.userId, flow: row.flow }
    }
    row.attempts += 1
    return null
  }

  async hasActiveLink(userId: number, now: string, since: string) {
    return this.active(now).some(
      (r) => r.userId === userId && Date.parse(r.createdAt) >= Date.parse(since)
    )
  }
}

class MemoryAppCodes implements OidcAppCodeStorePort {
  readonly codes = new Map<string, { userId: number; provider: string }>()
  async create(input: { codeHash: string; userId: number; provider: string }) {
    if (this.codes.has(input.codeHash)) return 'collision' as const
    this.codes.set(input.codeHash, {
      userId: input.userId,
      provider: input.provider,
    })
    return 'created' as const
  }
  async consume(codeHash: string) {
    const code = this.codes.get(codeHash)
    if (code === undefined) return null
    this.codes.delete(codeHash)
    return code
  }
}

const harness = (user: { userId: number } | null = { userId: 7 }) => {
  const magicLinks = new MemoryMagicLinks()
  const appCodes = new MemoryAppCodes()
  const mailed: StaffMagicLinkDelivery[] = []
  const sessions = {
    issue: vi.fn(async () => ({
      setCookie:
        '__Host-ezacto_session=staff-session; Path=/; HttpOnly; Secure; SameSite=Lax',
    })),
  }
  const users = { findByEmail: vi.fn(async () => user) }
  const app = createApiApp({
    installApp(app) {
      installStaffMagicLinkRoutes(app, {
        users,
        magicLinks,
        sessions,
        appCodes,
        mailer: { enqueue: async (d) => void mailed.push(d) },
        codeKey: CODE_KEY,
        linkOrigin: () => 'https://ezacto.io',
        now: () => fixedNow,
      })
    },
  })
  return { app, magicLinks, appCodes, mailed, sessions, users }
}

const request = (app: ReturnType<typeof harness>['app'], body: unknown) =>
  app.request('https://ezacto.io/auth/magic-link', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('staff magic-link request', () => {
  it('emails a link and a code for a known user (app flow marks the link)', async () => {
    const h = harness()
    const res = await request(h.app, { email: 'Owner@Example.test', flow: 'app' })
    expect(res.status).toBe(202)
    expect(h.mailed).toHaveLength(1)
    expect(h.mailed[0]!.to).toBe('owner@example.test')
    expect(h.mailed[0]!.code).toMatch(/^[0-9]{6}$/)
    const link = new URL(h.mailed[0]!.link)
    expect(link.pathname).toBe('/auth/magic-link/verify')
    expect(link.searchParams.get('flow')).toBe('app')
    expect(link.searchParams.get('token')).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('is a silent 202 for an unknown email and sends nothing', async () => {
    const h = harness(null)
    const res = await request(h.app, { email: 'nobody@example.test' })
    expect(res.status).toBe(202)
    expect(h.mailed).toHaveLength(0)
  })

  it('throttles a rapid repeat to one outstanding email', async () => {
    const h = harness()
    await request(h.app, { email: 'owner@example.test' })
    await request(h.app, { email: 'owner@example.test' })
    expect(h.mailed).toHaveLength(1)
  })

  it('answers 503 when the instance has the key but no mailer', async () => {
    const magicLinks = new MemoryMagicLinks()
    const app = createApiApp({
      installApp(app) {
        installStaffMagicLinkRoutes(app, {
          users: { findByEmail: async () => ({ userId: 7 }) },
          magicLinks,
          sessions: { issue: async () => ({ setCookie: 'x' }) },
          appCodes: new MemoryAppCodes(),
          codeKey: CODE_KEY,
          linkOrigin: () => 'https://ezacto.io',
          now: () => fixedNow,
        })
      },
    })
    const res = await request(app, { email: 'owner@example.test' })
    expect(res.status).toBe(503)
    // Nothing was written or looked up: the guard is deployment-level.
    expect(magicLinks.rows).toHaveLength(0)
  })
})

describe('staff magic-link verify (link)', () => {
  it('app flow redirects to the app scheme with a one-time code; web issues a session', async () => {
    for (const flow of ['app', 'web'] as const) {
      const h = harness()
      await request(h.app, { email: 'owner@example.test', flow })
      const token = new URL(h.mailed[0]!.link).searchParams.get('token')!
      const res = await h.app.request(
        `https://ezacto.io/auth/magic-link/verify?token=${token}`
      )
      expect(res.status).toBe(303)
      if (flow === 'app') {
        const location = new URL(res.headers.get('location')!)
        expect(location.protocol).toBe('ezacto:')
        expect(location.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/)
        expect(res.headers.get('set-cookie') ?? '').not.toContain('staff-session')
      } else {
        expect(res.headers.get('location')).toBe('/')
        expect(res.headers.get('set-cookie')).toContain('staff-session')
      }
    }
  })

  it('refuses a reused or unknown token', async () => {
    const h = harness()
    await request(h.app, { email: 'owner@example.test', flow: 'web' })
    const token = new URL(h.mailed[0]!.link).searchParams.get('token')!
    expect(
      (await h.app.request(`https://ezacto.io/auth/magic-link/verify?token=${token}`))
        .status
    ).toBe(303)
    const replay = await h.app.request(
      `https://ezacto.io/auth/magic-link/verify?token=${token}`
    )
    expect(replay.status).toBe(401)
  })
})

describe('staff magic-link exchange (code)', () => {
  const exchange = (app: ReturnType<typeof harness>['app'], body: unknown) =>
    app.request('https://ezacto.io/auth/magic-link/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('trades the code for a session', async () => {
    const h = harness()
    await request(h.app, { email: 'owner@example.test' })
    const res = await exchange(h.app, {
      email: 'owner@example.test',
      code: h.mailed[0]!.code,
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toContain('staff-session')
    expect(h.sessions.issue).toHaveBeenCalledWith(7)
  })

  it('locks after five wrong codes, then refuses the right one', async () => {
    const h = harness()
    await request(h.app, { email: 'owner@example.test' })
    for (let i = 0; i < 5; i += 1) {
      expect(
        (await exchange(h.app, { email: 'owner@example.test', code: '000000' }))
          .status
      ).toBe(401)
    }
    expect(
      (await exchange(h.app, { email: 'owner@example.test', code: h.mailed[0]!.code }))
        .status
    ).toBe(401)
  })

  it('rejects a malformed code without touching the store', async () => {
    const h = harness()
    expect(
      (await exchange(h.app, { email: 'owner@example.test', code: 'abc' })).status
    ).toBe(422)
  })
})

