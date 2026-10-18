import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { totpCodeForStep, totpStep } from '@ezacto/core'

/**
 * Issue 770, slice B: the emailed second factor through the whole stack, once
 * per runtime. The Worker runs these against a real D1 database and the
 * container against a real SQLite file; both are composed by their own
 * `createRuntimeServices`, so the wiring that is under test is the wiring that
 * ships -- not a stub of it.
 */

export interface CodeMail {
  to: string
  subject: string
  text: string
  html: string
}

export interface Stack {
  /** The owner's address: verified, and user 1. */
  ownerEmail: string
  ownerPassword: string
  request(path: string, init?: RequestInit): Promise<Response>
  /** Second-factor mails sent so far, settled. */
  codeMails(): Promise<CodeMail[]>
  rows(sql: string, ...bindings: unknown[]): Promise<Record<string, unknown>[]>
  exec(sql: string, ...bindings: unknown[]): Promise<void>
}

const code = (mail: CodeMail | undefined): string => {
  const found = /verification code is (\d{6})/u.exec(mail?.text ?? '')?.[1]
  if (found === undefined) throw new Error(`no code in mail: ${mail?.text}`)
  return found
}

const sha256 = async (value: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')

const post = (stack: Stack, path: string, body: unknown, cookie?: string) =>
  stack.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  })

const authed = (stack: Stack, method: string, path: string, cookie: string, body?: unknown) =>
  stack.request(path, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const setCookies = (response: Response): string[] =>
  response.headers.getSetCookie?.() ??
  (response.headers.get('set-cookie') === null ? [] : [response.headers.get('set-cookie')!])

const cookiePair = (response: Response, name: string): string | undefined =>
  setCookies(response)
    .find((value) => value.startsWith(`${name}=`))
    ?.split(';', 1)[0]

const SESSION = '__Host-ezacto_session'
const CHALLENGE_COOKIE = '__Host-ezacto_2fa_challenge'

interface Challenged {
  data: { status: string; challenge: string; expires_at: string; methods: string[] }
}

export const emailSecondFactorScenarios = (
  runtime: string,
  boot: () => Promise<{ stack: Stack; close: () => Promise<void> }>,
): void => {
  describe(`emailed second factor through the stack (${runtime})`, () => {
    let stack: Stack
    let close: () => Promise<void>
    let session: string

    /** Forgets the send ledger, as a minute and an hour passing would. */
    const letTimePass = () => stack.exec(`DELETE FROM two_factor_email_code_sends`)

    const signIn = () =>
      post(stack, '/auth/sign-in', { email: stack.ownerEmail, password: stack.ownerPassword })

    const sentAgo = (minutes: number) =>
      stack.exec(
        `UPDATE two_factor_email_code_sends SET sent_at = ?`,
        new Date(Date.now() - minutes * 60_000).toISOString(),
      )

    beforeAll(async () => {
      ;({ stack, close } = await boot())
      const response = await signIn()
      expect(response.status).toBe(200)
      session = cookiePair(response, SESSION)!
      expect(session).toBeTruthy()
    })

    afterAll(async () => close())

    beforeEach(async () => {
      await stack.exec(`DELETE FROM two_factor_challenges`)
      await stack.exec(`DELETE FROM two_factor_email_code_sends`)
      await stack.exec(`DELETE FROM user_email_second_factors`)
      await stack.exec(`DELETE FROM user_recovery_codes`)
      await stack.exec(`DELETE FROM user_totp_enrolments`)
    })

    const enable = async () => {
      const response = await authed(stack, 'POST', '/api/v1/two-factor/email', session)
      expect(response.status).toBe(200)
    }

    it('[security] turning it on needs a session and a verified address', async () => {
      const anonymous = await stack.request('/api/v1/two-factor/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      })
      expect(anonymous.status).toBe(401)
      expect(await stack.rows(`SELECT user_id FROM user_email_second_factors`)).toHaveLength(0)

      await enable()
      expect(await stack.rows(`SELECT user_id FROM user_email_second_factors`)).toEqual([
        { user_id: 1 },
      ])
      const status = await authed(stack, 'GET', '/api/v1/two-factor', session)
      expect(await status.json()).toMatchObject({
        data: { email_enabled: true, enrolled: false },
      })

      // The address went unverified: the factor is refused rather than turned on
      // for a mailbox nobody has shown they read.
      await stack.exec(`UPDATE user_emails SET is_primary = 0, verified_at = NULL WHERE user_id = 1`)
      await stack.exec(`DELETE FROM user_email_second_factors`)
      const refused = await authed(stack, 'POST', '/api/v1/two-factor/email', session)
      await stack.exec(
        `UPDATE user_emails SET is_primary = 1, verified_at = ? WHERE user_id = 1`,
        new Date().toISOString(),
      )
      expect(refused.status).toBe(409)
      expect(await refused.json()).toMatchObject({ error: { code: 'verified_email_required' } })
    })

    it('[e2e:first-run] an email-only user signs in with a mailed code, once', async () => {
      await enable()
      const before = (await stack.codeMails()).length
      const response = await signIn()

      expect(response.status).toBe(200)
      const body = (await response.json()) as Challenged
      expect(body.data.status).toBe('two_factor_required')
      expect(body.data.methods).toEqual(['email'])
      // No session until the code is answered.
      expect(cookiePair(response, SESSION)).toBeUndefined()
      expect(cookiePair(response, CHALLENGE_COOKIE)).toBeTruthy()

      const mails = await stack.codeMails()
      expect(mails).toHaveLength(before + 1)
      const mail = mails[mails.length - 1]!
      expect(mail.to).toBe(stack.ownerEmail)
      // A code and no link, asserted on both parts of the real composed mail.
      for (const part of [mail.text, mail.html]) {
        expect(part).not.toMatch(/https?:|www\.|<a[\s>]|href/i)
      }
      const emailed = code(mail)
      expect(JSON.stringify(body)).not.toContain(emailed)

      // Only a keyed hash of the code is at rest.
      const stored = JSON.stringify(await stack.rows(`SELECT * FROM two_factor_challenges`))
      expect(stored).not.toContain(emailed)

      const answered = await post(stack, '/auth/two-factor/challenge', {
        challenge: body.data.challenge,
        code: emailed,
      })
      expect(answered.status).toBe(200)
      expect(await answered.json()).toEqual({ data: { status: 'authenticated' } })
      const issued = cookiePair(answered, SESSION)
      expect(issued).toBeTruthy()
      const whoami = await authed(stack, 'GET', '/api/v1/whoami', issued!)
      expect(await whoami.json()).toMatchObject({ data: { user_id: 1 } })

      // The same challenge and code do not work twice.
      const replay = await post(stack, '/auth/two-factor/challenge', {
        challenge: body.data.challenge,
        code: emailed,
      })
      expect(replay.status).toBe(401)
      expect(cookiePair(replay, SESSION)).toBeUndefined()
    })

    it('[security] the sixth guess is refused with the right code, and 429 says nothing of how long', async () => {
      await enable()
      const body = (await (await signIn()).json()) as Challenged
      const emailed = code((await stack.codeMails()).at(-1))
      const wrong = emailed === '000000' ? '000001' : '000000'
      for (let guess = 1; guess <= 4; guess += 1) {
        const response = await post(stack, '/auth/two-factor/challenge', {
          challenge: body.data.challenge,
          code: wrong,
        })
        expect(response.status, `guess ${guess}`).toBe(401)
      }
      const fifth = await post(stack, '/auth/two-factor/challenge', {
        challenge: body.data.challenge,
        code: wrong,
      })
      expect(fifth.status).toBe(429)
      expect(((await fifth.json()) as { error: { message: string } }).error.message).not.toMatch(
        /\d/,
      )
      const right = await post(stack, '/auth/two-factor/challenge', {
        challenge: body.data.challenge,
        code: emailed,
      })
      expect(right.status).toBe(429)
      expect(cookiePair(right, SESSION)).toBeUndefined()
    })

    it('[security] a second sign-in within the minute is refused and mails nothing', async () => {
      await enable()
      await signIn()
      const sent = (await stack.codeMails()).length
      const again = await signIn()
      expect(again.status).toBe(429)
      expect(cookiePair(again, SESSION)).toBeUndefined()
      expect(cookiePair(again, CHALLENGE_COOKIE)).toBeUndefined()
      expect(await stack.codeMails()).toHaveLength(sent)
    })

    it('[security] a wrong password mails nothing at all', async () => {
      await enable()
      const sent = (await stack.codeMails()).length
      const response = await post(stack, '/auth/sign-in', {
        email: stack.ownerEmail,
        password: 'not the password at all',
      })
      expect(response.status).toBe(401)
      expect(await stack.codeMails()).toHaveLength(sent)
      expect(await stack.rows(`SELECT id FROM two_factor_email_code_sends`)).toHaveLength(0)
    })

    it('[security] resending supersedes the earlier code, and is limited per minute and per hour', async () => {
      await enable()
      const first = (await (await signIn()).json()) as Challenged
      const firstCode = code((await stack.codeMails()).at(-1))

      // Straight away: too soon.
      const tooSoon = await post(stack, '/auth/two-factor/email-code', {
        challenge: first.data.challenge,
      })
      expect(tooSoon.status).toBe(429)
      expect(Number(tooSoon.headers.get('retry-after'))).toBeGreaterThan(0)

      let token = first.data.challenge
      for (let resend = 1; resend < 5; resend += 1) {
        await sentAgo(2)
        const response = await post(stack, '/auth/two-factor/email-code', { challenge: token })
        expect(response.status, `resend ${resend}`).toBe(200)
        const body = (await response.json()) as Challenged
        expect(body.data.challenge).not.toBe(token)
        expect(cookiePair(response, CHALLENGE_COOKIE)).toContain(body.data.challenge)
        token = body.data.challenge
      }
      // Five in the hour, each a minute apart or more: the sixth waits.
      await sentAgo(2)
      const sixth = await post(stack, '/auth/two-factor/email-code', { challenge: token })
      expect(sixth.status).toBe(429)

      // The first code died with its challenge.
      const stale = await post(stack, '/auth/two-factor/challenge', {
        challenge: first.data.challenge,
        code: firstCode,
      })
      expect(stale.status).toBe(401)
      // The latest one works.
      const latest = await post(stack, '/auth/two-factor/challenge', {
        challenge: token,
        code: code((await stack.codeMails()).at(-1)),
      })
      expect(latest.status).toBe(200)
    })

    it('[security] a challenge that was not issued by a password sign-in cannot be mailed a code', async () => {
      await enable()
      // As a magic-link sign-in or any other path would issue one: no code, and
      // not marked as one that may be mailed.
      const token = 'Z'.repeat(43)
      await stack.exec(
        `INSERT INTO two_factor_challenges
           (user_id, token_hash, expires_at, created_at, updated_at, email_code_allowed)
         VALUES (1, ?, ?, ?, ?, 0)`,
        await sha256(token),
        new Date(Date.now() + 300_000).toISOString(),
        new Date().toISOString(),
        new Date().toISOString(),
      )
      const sent = (await stack.codeMails()).length
      const response = await post(stack, '/auth/two-factor/email-code', { challenge: token })
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({
        error: { code: 'two_factor_email_unavailable' },
      })
      expect(await stack.codeMails()).toHaveLength(sent)
      expect(await stack.rows(`SELECT id FROM two_factor_email_code_sends`)).toHaveLength(0)
    })

    it('[security] asking for a code for a user who never turned the factor on mails nothing', async () => {
      // Authenticator-only sign-in: a marked-or-not challenge is not enough.
      const token = 'Y'.repeat(43)
      await stack.exec(
        `INSERT INTO two_factor_challenges
           (user_id, token_hash, expires_at, created_at, updated_at, email_code_allowed)
         VALUES (1, ?, ?, ?, ?, 1)`,
        await sha256(token),
        new Date(Date.now() + 300_000).toISOString(),
        new Date().toISOString(),
        new Date().toISOString(),
      )
      const sent = (await stack.codeMails()).length
      const response = await post(stack, '/auth/two-factor/email-code', { challenge: token })
      expect(response.status).toBe(403)
      expect(await stack.codeMails()).toHaveLength(sent)
    })

    it('[e2e:first-run] a user with an authenticator and the email factor may use either', async () => {
      await enable()
      const begun = await authed(stack, 'POST', '/api/v1/two-factor', session)
      expect(begun.status).toBe(201)
      const { secret } = ((await begun.json()) as { data: { secret: string } }).data
      const confirmed = await authed(stack, 'POST', '/api/v1/two-factor/confirm', session, {
        code: await totpCodeForStep(secret, totpStep(Date.now())),
      })
      expect(confirmed.status).toBe(200)

      // Sign-in mails nothing: the person has an app, and asks if they want mail.
      const sent = (await stack.codeMails()).length
      const challenged = await signIn()
      const body = (await challenged.json()) as Challenged
      expect(body.data.methods).toEqual(['totp', 'email'])
      expect(await stack.codeMails()).toHaveLength(sent)

      // Asking for it mails one and returns the new challenge.
      const asked = await post(stack, '/auth/two-factor/email-code', {
        challenge: body.data.challenge,
      })
      expect(asked.status).toBe(200)
      const next = (await asked.json()) as Challenged
      expect(next.data.methods).toEqual(['totp', 'email'])
      const mails = await stack.codeMails()
      expect(mails).toHaveLength(sent + 1)

      const answered = await post(stack, '/auth/two-factor/challenge', {
        challenge: next.data.challenge,
        code: code(mails.at(-1)),
      })
      expect(answered.status).toBe(200)
      expect(cookiePair(answered, SESSION)).toBeTruthy()

      // And the authenticator still works on a fresh sign-in. Its step must be
      // newer than the one that confirmed the enrolment.
      await letTimePass()
      const again = (await (await signIn()).json()) as Challenged
      const later = totpStep(Date.now()) + 1
      const totp = await post(stack, '/auth/two-factor/challenge', {
        challenge: again.data.challenge,
        code: await totpCodeForStep(secret, later),
      })
      expect(totp.status).toBe(200)
    })

    it('[security] an administrator turns off a user\'s factor, audited, and the lockout ends', async () => {
      await stack.exec(
        `INSERT INTO users (id, first_name, last_name, profile, manager_grants, is_owner, created_at, updated_at)
         VALUES (2, 'Robin', 'Diaz', 'member', '[]', 0, ?, ?)`,
        '2026-10-01T00:00:00.000Z',
        '2026-10-01T00:00:00.000Z',
      )
      await stack.exec(
        `INSERT INTO user_email_second_factors (user_id, enabled_at) VALUES (2, ?)`,
        '2026-10-01T00:00:00.000Z',
      )
      const anonymous = await stack.request('/api/v1/users/2/two-factor/email', {
        method: 'DELETE',
        headers: { origin: 'http://localhost' },
      })
      expect(anonymous.status).toBeGreaterThanOrEqual(401)
      expect(await stack.rows(`SELECT user_id FROM user_email_second_factors`)).toHaveLength(1)

      const removed = await authed(stack, 'DELETE', '/api/v1/users/2/two-factor/email', session)
      expect(removed.status).toBe(200)
      expect(await removed.json()).toEqual({ data: { user_id: 2, email_enabled: false } })
      expect(await stack.rows(`SELECT user_id FROM user_email_second_factors`)).toHaveLength(0)

      const audit = await stack.rows(
        `SELECT event_type AS eventType, aggregate_id AS subject, payload_json AS payload
           FROM event_outbox WHERE event_type = 'two_factor.email_disabled'`,
      )
      expect(audit).toHaveLength(1)
      expect(audit[0]).toMatchObject({ eventType: 'two_factor.email_disabled', subject: 2 })
      expect(String(audit[0]!.payload)).toContain('administrator')

      const again = await authed(stack, 'DELETE', '/api/v1/users/2/two-factor/email', session)
      expect(again.status).toBe(404)
    })

    it('[security] turning the factor off puts sign-in back as it was', async () => {
      await enable()
      const off = await authed(stack, 'DELETE', '/api/v1/two-factor/email', session)
      expect(off.status).toBe(200)
      const sent = (await stack.codeMails()).length
      const response = await signIn()
      expect(response.status).toBe(200)
      expect(((await response.json()) as { data: { status: string } }).data.status).toBe(
        'authenticated',
      )
      expect(await stack.codeMails()).toHaveLength(sent)
    })
  })
}
