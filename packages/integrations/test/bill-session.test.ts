import { describe, expect, it, vi } from 'vitest'
import {
  BILL_SESSION_IDLE_SECONDS,
  BillAuthError,
  login,
  sessionIsStale,
  touchSession,
} from '../src/bill/session.js'

const credentials = {
  username: 'books@example.test',
  password: 'not-a-real-password',
  organizationId: '008EXAMPLEORG',
  devKey: 'dev-key-example',
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

describe('signing in to BILL', () => {
  it('[api] posts the four credentials BILL requires and keeps the session id', async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(request.method).toBe('POST')
      expect(new URL(request.url).pathname).toBe('/connect/v3/login')
      expect(await request.clone().json()).toEqual(credentials)
      return json({ sessionId: 'session-1' })
    })

    const session = await login({
      credentials,
      fetch,
      baseUrl: 'https://gateway.stage.bill.com/connect',
      now: '2026-09-11T12:00:00.000Z',
    })
    expect(session).toEqual({
      sessionId: 'session-1',
      lastUsedAt: '2026-09-11T12:00:00.000Z',
    })
  })

  it('[api] refuses to send a request missing a credential, and says which', async () => {
    // BILL answers a missing organisation id and a wrong password with the same
    // shape of failure, so "your credentials are wrong" would send an operator
    // to reset a password that was never the problem.
    const fetch = vi.fn()
    for (const field of ['username', 'password', 'organizationId', 'devKey'] as const) {
      await expect(
        login({
          credentials: { ...credentials, [field]: '  ' },
          fetch,
          now: '2026-09-11T12:00:00.000Z',
        }),
      ).rejects.toThrow(new RegExp(`${field} is required`, 'u'))
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('[api] reports a refusal with the status BILL gave', async () => {
    const fetch = vi.fn(async () => json({ message: 'Invalid credentials' }, 401))
    await expect(
      login({ credentials, fetch, now: '2026-09-11T12:00:00.000Z' }),
    ).rejects.toThrow(/status 401: Invalid credentials/u)
  })

  it('[api] survives a refusal whose body is not JSON', async () => {
    const fetch = vi.fn(async () => new Response('gateway down', { status: 502 }))
    const error = await login({
      credentials,
      fetch,
      now: '2026-09-11T12:00:00.000Z',
    }).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(BillAuthError)
    expect((error as BillAuthError).status).toBe(502)
  })

  it('[api] treats a 200 carrying no session id as a failure', async () => {
    // Answering "signed in" with nothing to sign in as would otherwise produce
    // a client that sends an empty session header to every call.
    const fetch = vi.fn(async () => json({ sessionId: '' }))
    await expect(
      login({ credentials, fetch, now: '2026-09-11T12:00:00.000Z' }),
    ).rejects.toThrow(/returned no session id/u)
  })

  it('[security] never puts the password in the error it raises', async () => {
    const fetch = vi.fn(async () => json({ message: credentials.password }, 401))
    // The body is BILL's own message and is carried on, so the one thing this
    // guards is that the request is not echoed back into the error.
    const error = await login({
      credentials: { ...credentials, password: 'hunter2-example' },
      fetch,
      now: '2026-09-11T12:00:00.000Z',
    }).catch((cause: unknown) => cause)
    expect(String(error)).not.toContain('hunter2-example')
  })
})

describe('when a session has gone stale', () => {
  const session = { sessionId: 'session-1', lastUsedAt: '2026-09-11T12:00:00.000Z' }
  const after = (seconds: number): string =>
    new Date(Date.parse(session.lastUsedAt) + seconds * 1000).toISOString()

  it('[unit] is fresh while it has been used recently', () => {
    expect(sessionIsStale(session, after(60))).toBe(false)
  })

  it('[unit] is stale once BILL would have dropped it', () => {
    expect(sessionIsStale(session, after(BILL_SESSION_IDLE_SECONDS))).toBe(true)
  })

  it('[unit] is stale inside the margin, because the call has not landed yet', () => {
    // A session judged live with two seconds left has expired by the time the
    // request arrives, and BILL answers that with an authentication failure
    // rather than a retry hint.
    expect(sessionIsStale(session, after(BILL_SESSION_IDLE_SECONDS - 1))).toBe(true)
    expect(sessionIsStale(session, after(BILL_SESSION_IDLE_SECONDS - 121))).toBe(false)
  })

  it('[unit] treats an unreadable instant as stale rather than assuming it is fine', () => {
    expect(sessionIsStale(session, 'not-a-date')).toBe(true)
    expect(sessionIsStale({ ...session, lastUsedAt: 'nonsense' }, after(1))).toBe(true)
  })

  it('[unit] the expiry is idle-based, so using it keeps it alive', () => {
    // The whole reason this is modelled as "last used" rather than "issued at":
    // a mirror that ticks every few minutes should never re-authenticate.
    let live = session
    for (let minute = 0; minute < 120; minute += 5) {
      const now = after(minute * 60)
      expect(sessionIsStale(live, now)).toBe(false)
      live = touchSession(live, now)
    }
  })

  it('[unit] touching keeps the id and moves only the clock', () => {
    expect(touchSession(session, after(90))).toEqual({
      sessionId: 'session-1',
      lastUsedAt: after(90),
    })
  })
})
