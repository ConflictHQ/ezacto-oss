import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Does the deployed Worker actually refuse to talk in cleartext?
 *
 * #548 was found against the live site, not against this file: http://
 * app.example.com/ answered 200 with a password field, and the form's
 * action is relative, so a browser would have posted the password over the
 * same cleartext link. A unit test of a helper would not have caught it,
 * because nothing was wrong with a helper -- the entry simply never asked.
 *
 * So this suite calls no helper. It bundles the real Worker entry, runs it in
 * Miniflare, and dispatches URLs whose scheme is the thing under test. The
 * assertions are literal: a status, a location, an absence of a password field.
 *
 * To confirm it discriminates rather than decorates, delete the
 * `cleartextRefusal` call from `fetch`: the four cleartext tests go red, the
 * first of them reporting a 200 carrying `type="password"`.
 */

let miniflare: Miniflare

const fetchAt = (url: string, init?: RequestInit): Promise<Response> =>
  miniflare.dispatchFetch(url, init as never) as unknown as Promise<Response>

beforeAll(async () => {
  const bundled = await build({
    entryPoints: [new URL('../src/index.ts', import.meta.url).pathname],
    bundle: true,
    conditions: ['development'],
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
  })
  miniflare = new Miniflare({
    bindings: {
      API_CURSOR_SIGNING_KEY: 'A'.repeat(43),
      ENVIRONMENT: 'prod',
      RELEASE: 'https-enforcement-test',
    },
    compatibilityDate: '2026-08-06',
    d1Databases: ['DB'],
    r2Buckets: ['ATTACHMENTS'],
    modules: true,
    script: bundled.outputFiles[0]!.text,
  })
})

afterAll(async () => {
  await miniflare.dispose()
})

describe('cleartext enforcement at the Worker boundary', () => {
  it('[security] never serves a sign-in form over http', async () => {
    const response = await fetchAt('http://app.example.com/', {
      redirect: 'manual',
    })
    expect(response.status).toBe(301)
    expect(response.headers.get('location')).toBe('https://app.example.com/')
    // The point of the issue: not "it redirects eventually", but that no HTML
    // carrying a password field is ever composed for a cleartext request.
    const body = await response.text()
    expect(body).not.toContain('type="password"')
    expect(body).not.toContain('data-sign-in-form')
  })

  it('[security] keeps the path and query when it upgrades the link', async () => {
    const response = await fetchAt(
      'http://app.example.com/invoices?state=open',
      { redirect: 'manual' },
    )
    expect(response.status).toBe(301)
    expect(response.headers.get('location')).toBe(
      'https://app.example.com/invoices?state=open',
    )
  })

  it('[security] refuses a cleartext credential post rather than replaying it', async () => {
    const response = await fetchAt('http://app.example.com/auth/sign-in', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.invalid', password: 'x' }),
      redirect: 'manual',
    })
    // Not a redirect. The body is already on the wire; sending it again over
    // https would put the same secret out twice and answer 200, which reads as
    // "that was fine".
    expect(response.status).toBe(403)
    expect(response.headers.get('location')).toBeNull()
    expect(await response.json()).toMatchObject({
      error: { code: 'https_required' },
    })
  })

  it('[security] refuses a cleartext API write before authenticating it', async () => {
    // The status alone proves nothing here: an unauthenticated write is
    // refused anyway. What this pins is WHICH refusal answers -- the scheme is
    // checked before the credential is, so the caller is told the transport is
    // wrong rather than handed an auth challenge to satisfy over cleartext.
    const cleartext = await fetchAt(
      'http://app.example.com/api/v1/time-entries',
      { method: 'POST', redirect: 'manual' },
    )
    expect(cleartext.status).toBe(403)
    expect(await cleartext.json()).toMatchObject({
      error: { code: 'https_required' },
    })

    const encrypted = await fetchAt(
      'https://app.example.com/api/v1/time-entries',
      { method: 'POST', redirect: 'manual' },
    )
    // Same status, different refusal: over https the request reaches the CSRF
    // origin gate, which is the proof that the scheme check ran first and
    // stopped the cleartext one short of it.
    expect(encrypted.status).toBe(403)
    expect(await encrypted.json()).toMatchObject({
      error: { code: 'csrf_origin_mismatch' },
    })
  })

  it('[security] answers https with a year of strict transport', async () => {
    const response = await fetchAt('https://app.example.com/')
    expect(response.status).toBe(200)
    expect(response.headers.get('strict-transport-security')).toBe(
      'max-age=31536000; includeSubDomains',
    )
  })

  it('[unit] leaves loopback alone so local development still serves', async () => {
    // There is no certificate to upgrade to on localhost, and pinning a
    // developer's whole loopback to https would break every other project on
    // it. Cleartext here is answered, not redirected, and carries no HSTS.
    const response = await fetchAt('http://localhost:8787/', {
      redirect: 'manual',
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('strict-transport-security')).toBeNull()
  })
})
