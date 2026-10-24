import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { migrateD1 } from '../../db/src/migrate.js'
import { createD1SessionStore } from '../../db/src/sessions.js'

it('runs the public managed command inside workerd with real D1 session/CSRF and generation fences', async () => {
  // Fixture-only dispatch; no new route is installed in the production Worker.
  const output = await build({
    stdin: {
      resolveDir: dirname(fileURLToPath(import.meta.url)),
      loader: 'ts',
      contents: `
      import { createManagedQuickBooksGrantCommands, createApiSessionService } from '../src/index.js'
      import { createD1Database, createD1SessionStore, createManagedQuickBooksGrantStore, createQuickBooksStore } from '../../db/src/d1.js'
      const now = '2026-10-24T18:00:00.000Z'
      const command = {
        grantId:'a'.repeat(64),browserHash:'b'.repeat(64),credentialHash:'c'.repeat(64),
        expectedActorUserId:2,expectedConnectionGeneration:0,expiresAt:Date.parse(now)+600000,
        tokens:{realmId:'owned-realm',companyName:null,accessToken:'OWNED_ACCESS_SENTINEL',refreshToken:'OWNED_REFRESH_SENTINEL',
          accessTokenExpiresAt:'2026-10-24T19:00:00.000Z',refreshTokenExpiresAt:'2027-10-24T18:00:00.000Z',scope:'com.intuit.quickbooks.accounting'}
      }
      export default {async fetch(request,env){
        const db = createD1Database(env.DB)
        const commands = createManagedQuickBooksGrantCommands({store:createManagedQuickBooksGrantStore(db),
          authentication:{sessions:createApiSessionService(createD1SessionStore(env.DB,{now:()=>now}))},now:()=>now})
        const result = await commands.accept(request,command)
        if(result instanceof Response) return result
        if(new URL(request.url).pathname==='/accept-and-disconnect') await createQuickBooksStore(db).disconnect({now})
        return Response.json(result)
      }}
    `,
    },
    bundle: true,
    // Match Vitest and the existing Worker fixtures: CI tests source exports
    // before any workspace dist build has run.
    conditions: ['development'],
    format: 'esm',
    platform: 'browser',
    external: ['node:async_hooks'],
    write: false,
  })
  const mf = new Miniflare({
    compatibilityDate: '2026-08-06',
    compatibilityFlags: ['nodejs_als'],
    modules: true,
    script: output.outputFiles[0]!.text,
    d1Databases: ['DB'],
  })
  try {
    const db = await mf.getD1Database('DB')
    await migrateD1(db)
    const now = '2026-10-24T18:00:00.000Z'
    await db
      .prepare(
        `INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES
      (1,'Owner','Fixture','administrator','[]',?,?),(2,'Administrator','Fixture','administrator','[]',?,?),(3,'Member','Fixture','member','[]',?,?)`,
      )
      .bind(now, now, now, now, now, now)
      .run()
    const sessions = createD1SessionStore(db, { now: () => now })
    const admin = await sessions.issue(2),
      member = await sessions.issue(3)
    const request = (
      token: string,
      origin = 'https://owned.example',
      path = '/accept',
      authorization?: string,
    ) =>
      mf.dispatchFetch(`https://owned.example${path}`, {
        method: 'POST',
        headers: {
          origin,
          cookie: `__Host-ezacto_session=${token}`,
          ...(authorization ? { authorization } : {}),
        },
      })
    expect((await request(member.token)).status).toBe(403)
    expect((await request(admin.token, 'https://foreign.example')).status).toBe(
      403,
    )
    expect(
      (
        await request(
          admin.token,
          'https://owned.example',
          '/accept',
          'Bearer invalid',
        )
      ).status,
    ).toBe(401)
    const accepted = await request(admin.token)
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toMatchObject({
      actorUserId: 2,
      outcome: 'accepted',
      connected: true,
      connectionGeneration: 1,
    })
    expect(
      await (
        await request(
          admin.token,
          'https://owned.example',
          '/accept-and-disconnect',
        )
      ).json(),
    ).toMatchObject({ outcome: 'replayed', connectionGeneration: 1 })
    expect((await request(admin.token)).status).toBe(409)
    const receipts = await db
      .prepare('SELECT * FROM quickbooks_managed_grants')
      .all()
    expect(receipts.results).toHaveLength(1)
    expect(JSON.stringify(receipts.results)).not.toMatch(
      /OWNED_ACCESS_SENTINEL|OWNED_REFRESH_SENTINEL/,
    )
  } finally {
    await mf.dispose()
  }
}, 60_000)
