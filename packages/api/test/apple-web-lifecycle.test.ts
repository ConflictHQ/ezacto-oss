import { appleLifecycleMigration } from '../../db/src/migrations/0104_apple_lifecycle.js'
import BetterSqlite3 from 'better-sqlite3'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerAppleWebCustodyStore } from '../../db/src/apple-web-custody.js'
import { appleWebCustodyMigration } from '../../db/src/migrations/0105_apple_web_custody.js'
import { APPLE_WEB_CONNECTION_COOKIE, createAppleWebLifecycle } from '../src/apple-web-lifecycle.js'

const issuer = 'https://apple-auth.ezacto.com'
const fixed = new Date('2026-10-09T04:00:00.000Z')
const databases: BetterSqlite3.Database[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
const setup = async (demo = false) => {
  const db = new BetterSqlite3(':memory:'); databases.push(db)
  db.pragma('foreign_keys = ON')
  db.exec('CREATE TABLE users(id INTEGER PRIMARY KEY, is_active INTEGER NOT NULL) STRICT; INSERT INTO users VALUES(1,1),(2,1)')
  db.exec("CREATE TABLE account_closure_security(id INTEGER PRIMARY KEY, secret TEXT NOT NULL); INSERT INTO account_closure_security VALUES(1,'" + 'ab'.repeat(32) + "'); CREATE TABLE user_identities(user_id INTEGER, provider TEXT, provider_subject TEXT); INSERT INTO user_identities VALUES(1,'apple','private-apple-subject')")
  db.exec(appleLifecycleMigration[0])
  for (const sql of appleWebCustodyMigration) db.exec(sql)
  const store = createContainerAppleWebCustodyStore(db)
  const pair = await generateKeyPair('ES256')
  const publicKey = { ...await exportJWK(pair.publicKey), kid: 'service-test', alg: 'ES256', use: 'sig' }
  const clientId = 'com.ezacto.web'
  const origin = demo ? 'https://ezacto.io' : 'https://app.example.com'
  let overrides: Record<string, unknown> = {}
  let generation = 1, grantId = 'g'.repeat(32), failed = false
  let cleanupRequest: string | undefined
  const requests: { path: string; body: Record<string, unknown>; init: RequestInit }[] = []
  const capability = () => `${'r'.repeat(43)}.${grantId}.${'s'.repeat(43)}`
  const sign = (type: 'apple_grant' | 'apple_revocation', requestId?: string) => new SignJWT({
    type, channel: 'web', client_id: clientId, grant_id: grantId, generation,
    ...(type === 'apple_grant' ? { purpose: cleanupRequest === undefined ? 'sign-in' : 'cleanup', nonce: 'n'.repeat(43), challenge_id: 'c'.repeat(43), ...(cleanupRequest === undefined ? {} : { request_id: cleanupRequest }) }
      : { status: 'revoked', request_id: requestId, revoked_at: Math.floor(fixed.valueOf() / 1000) }),
    ...overrides,
  }).setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid: 'service-test' }).setIssuer(issuer).setAudience(typeof overrides['aud'] === 'string' ? overrides['aud'] : origin)
    .setSubject('private-apple-subject').setJti('event_0001').setIssuedAt(Math.floor(fixed.valueOf() / 1000))
    .setExpirationTime(Math.floor(fixed.valueOf() / 1000) + 300).sign(pair.privateKey)
  const retrieve: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    expect(url.origin).toBe(issuer)
    expect(init.redirect).toBe('manual')
    if (url.pathname === '/.well-known/jwks.json') return Response.json({ keys: [publicKey] })
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    requests.push({ path: url.pathname, body, init })
    if (url.pathname === '/v1/apple/web/challenges') {
      cleanupRequest = typeof body.deletionRequestId === 'string' ? body.deletionRequestId : undefined
      return Response.json({ challengeId: 'c'.repeat(43), nonce: 'n'.repeat(43), expiresAt: new Date(fixed.valueOf() + 300000).toISOString(), clientId, redirectUri: origin + '/auth/apple/callback' })
    }
    if (url.pathname === '/v1/apple/web/grants') return Response.json({ capability: capability(), grantId, generation, instanceOrigin: origin, bindingReceipt: await sign('apple_grant') })
    if (url.pathname === '/v1/apple/revocations') {
      if (failed) return new Response('Upstream unavailable', { status: 503 })
      return Response.json({ status: 'revoked', receipt: await sign('apple_revocation', String(body.deletionRequestId)) })
    }
    if (url.pathname === '/v1/apple/revocations/ack') return Response.json({ status: 'acknowledged' }, { status: 202 })
    throw new Error('Unexpected service request')
  }
  const config = { site: demo ? 'demo' as const : 'team' as const, servicesId: clientId, redirectOrigin: origin,
    encryptionKeys: { k1: 'k'.repeat(43) }, activeKeyId: 'k1', routingSecret: 'A'.repeat(43) }
  const lifecycle = createAppleWebLifecycle({ config, store, fetch: retrieve, now: () => fixed })
  const exchange = async (purpose: 'sign-in' | 'disconnect' = 'sign-in', requestId?: string) => {
    const input = { servicesId: clientId, instanceOrigin: origin, redirectUri: origin + '/auth/apple/callback', demo, purpose }
    const challenge = await lifecycle.challenge({ ...input, ...(requestId === undefined ? {} : { requestId }) })
    return lifecycle.exchange({ ...input, challengeId: challenge.challengeId, nonce: challenge.nonce, authorizationCode: 'provider-code', identityToken: 'provider-token' })
  }
  const request = (setCookie: string) => new Request(origin + '/auth/apple/disconnect', { headers: { cookie: setCookie.split(';')[0]! } })
  return { db, store, lifecycle, exchange, request, requests, capability,
    override: (claims: Record<string, unknown>) => { overrides = claims },
    fail: (value: boolean) => { failed = value },
    advance: () => { generation++; grantId = 'h'.repeat(32) },
  }
}

describe('Apple web lifecycle custody', () => {
  it.each([false, true])('keeps site challenges and receipts separate under the shared audience: demo=%s', async demo => {
    const h = await setup(demo)
    const otherOrigin = demo ? 'https://app.example.com' : 'https://ezacto.io'
    await expect(h.lifecycle.challenge({ servicesId: 'com.ezacto.web', instanceOrigin: otherOrigin,
      redirectUri: otherOrigin + '/auth/apple/callback', demo, purpose: 'sign-in' })).rejects.toThrow()
    expect(h.requests).toEqual([])
    h.override({ aud: otherOrigin })
    await expect(h.exchange()).rejects.toThrow()
    expect(h.requests[0]?.body).toEqual({ site: demo ? 'demo' : 'team', purpose: 'sign-in' })
    expect(h.db.prepare('SELECT count(*) AS n FROM apple_web_connections').get()).toEqual({ n: 0 })
  })

  it('encrypts capability and subject before issuing an independent browser handle', async () => {
    const h = await setup(), grant = await h.exchange()
    const connection = await grant.bindUser(1, { knownFromFirstLink: true })
    expect(connection.setCookie).toContain(APPLE_WEB_CONNECTION_COOKIE + '=')
    expect(connection.setCookie).toContain('Secure; HttpOnly; SameSite=Lax')
    expect(connection.setCookie).not.toContain(h.capability())
    const stored = JSON.stringify(h.db.prepare('SELECT * FROM apple_web_connections').all())
    expect(stored).not.toContain(h.capability())
    expect(stored).not.toContain('private-apple-subject')
    expect(h.db.prepare('SELECT channel, known_from_first_link FROM apple_identity_channels').all()).toEqual([{ channel: 'web', known_from_first_link: 1 }])
    expect(await h.lifecycle.connected(h.request(connection.setCookie))).toBe(true)
    expect(await h.lifecycle.connected(h.request('session=shared-demo'))).toBe(false)
    expect(h.requests.some(request => request.path.includes('/revocations'))).toBe(false)
  })

  it('does not save custody or channel provenance for a different workspace identity', async () => {
    const h = await setup()
    await expect((await h.exchange()).bindUser(2, { knownFromFirstLink: true })).rejects.toThrow()
    expect(h.db.prepare('SELECT * FROM apple_web_connections').all()).toEqual([])
    expect(h.db.prepare('SELECT * FROM apple_identity_channels').all()).toEqual([])
  })

  it('records verified web provenance without promoting a previously unclassified identity', async () => {
    const h = await setup()
    await (await h.exchange()).bindUser(1, { knownFromFirstLink: false })
    expect(h.db.prepare('SELECT channel, known_from_first_link FROM apple_identity_channels').all()).toEqual([{ channel: 'web', known_from_first_link: 0 }])
    h.advance()
    await (await h.exchange()).bindUser(1, { knownFromFirstLink: true })
    expect(h.db.prepare('SELECT known_from_first_link FROM apple_identity_channels').get()).toEqual({ known_from_first_link: 0 })
  })

  it('keeps demo custody independent of the published workspace member', async () => {
    const h = await setup(true), grant = await h.exchange()
    await expect(grant.bindUser(1, { knownFromFirstLink: true })).rejects.toThrow()
    const connection = await grant.bindBrowser()
    expect(h.db.prepare('SELECT user_id FROM apple_web_connections').get()).toEqual({ user_id: null })
    expect(h.db.prepare('SELECT * FROM apple_identity_channels').all()).toEqual([])
    await h.lifecycle.begin(1, 'request_001')
    expect(await h.lifecycle.status('request_001')).toBe('not_linked')
    expect(await h.lifecycle.connected(h.request(connection.setCookie))).toBe(true)
  })

  it.each([{ channel: 'native' }, { client_id: 'com.ezacto.app' }, { nonce: 'wrong-nonce' }, { challenge_id: 'other_challenge' }, { generation: 2 }])('rejects a substituted web binding receipt: %j', async claims => {
    const h = await setup(); h.override(claims)
    await expect(h.exchange()).rejects.toThrow()
    expect(h.db.prepare('SELECT count(*) AS n FROM apple_web_connections').get()).toEqual({ n: 0 })
  })

  it('keeps cleanup unresolved on provider failure and completes only matching verified proof', async () => {
    const h = await setup(), grant = await h.exchange()
    const connection = await grant.bindUser(1, { knownFromFirstLink: true })
    h.fail(true)
    await h.lifecycle.begin(1, 'request_001')
    expect(h.requests.some(request => request.path === '/v1/apple/revocations')).toBe(false)
    await h.lifecycle.perform('request_001')
    expect(await h.lifecycle.status('request_001')).toBe('pending')
    h.fail(false)
    h.override({ request_id: 'wrong_request' })
    await h.lifecycle.perform('request_001')
    expect(await h.lifecycle.status('request_001')).not.toBe('revoked')
    expect(await h.lifecycle.recovery(h.request(connection.setCookie))).toEqual({ requestId: 'request_001', required: true })
    h.override({})
    await h.lifecycle.perform('request_001')
    expect(await h.lifecycle.status('request_001')).toBe('revoked')
    expect(h.db.prepare('SELECT sealed_capability FROM apple_web_connections').get()).toEqual({ sealed_capability: null })
    expect(h.requests.at(-1)?.body).toMatchObject({ deletionRequestId: 'request_001', disposition: 'delivered' })
  })

  it('rejects modified ciphertext without contacting the revocation endpoint', async () => {
    const h = await setup(), grant = await h.exchange(), connection = await grant.bindUser(1, { knownFromFirstLink: true })
    h.db.prepare("UPDATE apple_web_connections SET sealed_capability = json_set(sealed_capability, '$.ciphertext', 'dGFtcGVyZWQ')").run()
    await expect(h.lifecycle.disconnect(h.request(connection.setCookie))).rejects.toThrow()
    expect(h.requests.some(request => request.path === '/v1/apple/revocations')).toBe(false)
  })

  it('recovers a lost browser handle against the original deletion request and rotates custody', async () => {
    const h = await setup(), original = await (await h.exchange()).bindUser(1, { knownFromFirstLink: true })
    h.fail(true); await h.lifecycle.begin(1, 'request_001'); await h.lifecycle.perform('request_001')
    h.fail(false); h.advance()
    const replacement = await (await h.exchange('disconnect', 'request_001')).bindBrowser()
    expect(await h.lifecycle.connected(h.request(original.setCookie))).toBe(false)
    expect(await h.lifecycle.status('request_001')).toBe('pending')
    await h.lifecycle.disconnect(h.request(replacement.setCookie))
    expect(await h.lifecycle.status('request_001')).toBe('revoked')
  })
})
