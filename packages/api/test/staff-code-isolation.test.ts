import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { describe, expect, it } from 'vitest'
import {
  createContainerStaffMagicLinkStore,
  createD1StaffMagicLinkStore
} from '../../db/src/staff-magic-links.js'
import { migrateContainer, migrateD1 } from '../../db/src/migrate.js'
import { createApiApp } from '../src/app.js'
import {
  installStaffMagicLinkRoutes,
  type StaffMagicLinkDelivery
} from '../src/staff-magic-link.js'

for (const runtime of ['SQLite', 'D1'] as const)
  describe(`staff code requester isolation (${runtime})`, () => {
    it('does not allow requester A to exhaust requester B’s code attempts', async () => {
      const sqlite = runtime === 'SQLite' ? new BetterSqlite3(':memory:') : null
      const mf = sqlite
        ? null
        : new Miniflare({
            modules: true,
            script: 'export default {fetch(){return new Response("ok")}}',
            d1Databases: ['DB']
          })
      const d1 = mf ? await mf.getD1Database('DB') : null
      if (sqlite) migrateContainer(sqlite)
      else await migrateD1(d1!)
      const store = sqlite
        ? createContainerStaffMagicLinkStore(sqlite)
        : createD1StaffMagicLinkStore(d1!)
      let instant = '2026-10-26T00:00:00.000Z'
      const deliveries: StaffMagicLinkDelivery[] = []
      let issuedSessions = 0
      const app = createApiApp({
        installApp(app) {
          installStaffMagicLinkRoutes(app, {
            magicLinks: store,
            users: {
              findByEmail: async (email) => (email === 'owner@example.test' ? { userId: 42 } : null)
            },
            sessions: {
              issue: async () => {
                issuedSessions += 1
                return {
                  setCookie:
                    '__Host-ezacto_session=owned-session; Path=/; Secure; HttpOnly; SameSite=Lax'
                }
              }
            },
            appCodes: { create: async () => 'created', consume: async () => null },
            mailer: {
              enqueue: async (delivery) => {
                deliveries.push(delivery)
              }
            },
            codeKey: new Uint8Array(32).fill(7),
            linkOrigin: () => 'https://owned.example.test',
            now: () => instant
          })
        }
      })
      const send = (path: string, body: unknown, cookie = '') =>
        app.request(`https://owned.example.test${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'https://owned.example.test',
            ...(cookie ? { cookie } : {})
          },
          body: JSON.stringify(body)
        })
      try {
        for (const headers of [
          { origin: 'https://foreign.example' },
          { 'sec-fetch-site': 'cross-site' }
        ]) {
          const cross = await app.request('https://owned.example.test/auth/magic-link', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers },
            body: JSON.stringify({ email: 'owner@example.test' })
          })
          expect(cross.status).toBe(403)
        }
        const native = await app.request('https://owned.example.test/auth/magic-link', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'unknown@example.test' })
        })
        expect(native.status).toBe(202)
        const first = await send('/auth/magic-link', { email: 'owner@example.test' })
        const cookieA = first.headers.get('set-cookie')?.split(';')[0] ?? ''
        instant = '2026-10-26T00:01:01.000Z'
        const second = await send('/auth/magic-link', { email: 'owner@example.test' })
        const cookieB = second.headers.get('set-cookie')?.split(';')[0] ?? ''
        expect(deliveries).toHaveLength(2)
        const validB = deliveries[1]!.code
        const wrong = ['000000', '999999', '111111'].find(
          (code) => !deliveries.some((delivery) => delivery.code === code)
        )!
        for (let attempt = 0; attempt < 5; attempt++)
          expect(
            (
              await send(
                '/auth/magic-link/exchange',
                { email: 'owner@example.test', code: wrong },
                cookieA
              )
            ).status
          ).toBe(401)
        expect(
          (
            await send(
              '/auth/magic-link/exchange',
              { email: 'owner@example.test', code: deliveries[0]!.code },
              cookieA
            )
          ).status
        ).toBe(401)
        const result = await send(
          '/auth/magic-link/exchange',
          { email: 'owner@example.test', code: validB },
          cookieB
        )
        expect(result.status).toBe(200)
        expect(
          (
            await send(
              '/auth/magic-link/exchange',
              { email: 'owner@example.test', code: validB },
              cookieB
            )
          ).status
        ).toBe(401)
        // A lost success response leaves the old requester cookie in the jar.
        instant = '2026-10-26T00:02:02.000Z'
        const resend = await send('/auth/magic-link', { email: 'owner@example.test' }, cookieB)
        const cookieAgain = resend.headers.get('set-cookie')?.split(';')[0] ?? ''
        expect(cookieAgain === cookieB).toBe(true)
        const third = deliveries.at(-1)!
        expect(deliveries).toHaveLength(3)
        const tampered = cookieB.slice(0, -1) + (cookieB.endsWith('A') ? 'B' : 'A')
        for (const absent of ['', tampered])
          for (let i = 0; i < 5; i++)
            expect(
              (
                await send(
                  '/auth/magic-link/exchange',
                  { email: 'owner@example.test', code: wrong },
                  absent
                )
              ).status
            ).toBe(401)
        expect(
          (
            await send(
              '/auth/magic-link/exchange',
              { email: 'owner@example.test', code: third.code },
              cookieB
            )
          ).status
        ).toBe(200)
        // Known/unknown email repetition has identical cookie reuse semantics.
        const unknown = await send('/auth/magic-link', { email: 'unknown@example.test' })
        const unknownCookie = unknown.headers.get('set-cookie')?.split(';')[0] ?? ''
        const unknownAgain = await send(
          '/auth/magic-link',
          { email: 'unknown@example.test' },
          unknownCookie
        )
        expect(
          (unknownAgain.headers.get('set-cookie')?.split(';')[0] ?? '') === unknownCookie
        ).toBe(true)
        expect(unknownAgain.status).toBe(202)
        // An older high-entropy email link survives code exhaustion and resends.
        const longToken = new URL(deliveries[0]!.link).searchParams.get('token')!
        const linkResult = await app.request('https://owned.example.test/auth/magic-link/verify', {
          method: 'POST',
          headers: {
            origin: 'https://owned.example.test',
            'content-type': 'application/x-www-form-urlencoded'
          },
          body: new URLSearchParams({ token: longToken })
        })
        expect(linkResult.status).toBe(303)
        const afterLink = await send('/auth/magic-link', { email: 'owner@example.test' }, cookieA)
        expect(afterLink.status).toBe(202)
        const beforeConcurrent = issuedSessions
        const lastCode = deliveries.at(-1)!.code
        const concurrent = await Promise.all(
          [1, 2].map(() =>
            send(
              '/auth/magic-link/exchange',
              { email: 'owner@example.test', code: lastCode },
              cookieA
            )
          )
        )
        expect(concurrent.map((result) => result.status).sort()).toEqual([200, 401])
        expect(issuedSessions - beforeConcurrent).toBe(1)

        // Cookie policy and clearing are checked without printing bearer values.
        instant = '2026-10-26T00:20:00.000Z'
        expect(
          (
            await send(
              '/auth/magic-link/exchange',
              { email: 'owner@example.test', code: lastCode },
              cookieA
            )
          ).status
        ).toBe(401)
        const header = resend.headers.get('set-cookie') ?? ''
        expect(
          header.includes('HttpOnly') &&
            header.includes('Secure') &&
            header.includes('SameSite=Lax') &&
            header.includes('Path=/')
        ).toBe(true)
      } finally {
        sqlite?.close()
        await mf?.dispose()
      }
    }, 30000)
  })
