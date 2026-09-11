import { describe, expect, it } from 'vitest'
import {
  createApiApp,
  installBrandAssetRoutes,
  installBrandRoute,
  installPublicBrandAssetRoutes,
  MAX_BRAND_ASSET_BYTES,
  type ApiAuthentication,
  type BrandAssetSurface,
  type StoredBrandAsset,
  type UserProfile,
} from '../src/index.js'

const clock = '2026-09-09T12:00:00.000Z'

/**
 * A session-authenticated mutation is refused without an exact same-origin
 * `Origin` header, which is the CSRF guard every other session route sits
 * behind; `app.request` serves from `http://localhost`.
 */
const sameOrigin = 'http://localhost'

const authentication: ApiAuthentication = {
  tokens: {
    authenticate: async (token) =>
      token === 'portal-token'
        ? { tokenId: 1, userId: 8, profile: 'member', scopes: ['clients:read'] }
        : null,
    issue: async () => {
      throw new Error('not used')
    },
    list: async () => [],
    revoke: async () => null,
  },
  sessions: {
    resolve: async (request) => {
      const profile = request.headers.get('x-test-profile') as UserProfile | null
      if (profile === null) return null
      return {
        type: 'user',
        userId: 7,
        profile,
        managerGrants: [],
        authentication: { kind: 'session', sessionId: 'brand-asset-test' },
      }
    },
  },
}

const png = (payload: string): Uint8Array => {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  return new Uint8Array([...signature, ...new TextEncoder().encode(payload)])
}

const surface = () => {
  const rows = new Map<string, StoredBrandAsset>()
  const objects = new Map<string, ArrayBuffer>()
  const port: BrandAssetSurface<Record<string, never>> = {
    list: async () => [...rows.values()],
    read: async (_env, fileKey) => {
      const bytes = objects.get(fileKey)
      return bytes === undefined ? null : { body: bytes }
    },
    write: async (_env, input) => {
      objects.set(input.fileKey, input.bytes)
      const stored: StoredBrandAsset = {
        slot: input.slot,
        contentHash: input.contentHash,
        fileKey: input.fileKey,
        contentType: input.contentType,
        byteSize: input.bytes.byteLength,
        updatedAt: input.now,
      }
      rows.set(input.slot, stored)
      return stored
    },
    remove: async (_env, slot) => rows.delete(slot),
  }
  return { port, rows, objects }
}

const harness = () => {
  const store = surface()
  const app = createApiApp<Record<string, never>>({
    authentication,
    installApp: (application) => installPublicBrandAssetRoutes(application, store.port),
    installApi: (api) => {
      installBrandAssetRoutes(api, store.port, () => clock)
      installBrandRoute(api, {
        organizationName: async () => 'Northpeak Studio',
        assets: (env) => store.port.list(env),
      })
    },
  })
  const upload = (segment: string, bytes: Uint8Array, type: string, name = 'logo.png') => {
    const body = new FormData()
    body.set('file', new File([bytes as BlobPart], name, { type }))
    return app.request(`/api/v1/settings/brand-assets/${segment}`, {
      method: 'POST',
      headers: { 'x-test-profile': 'administrator', origin: sameOrigin },
      body,
    })
  }
  return { app, store, upload }
}

describe('brand asset routes (#489)', () => {
  it('[unit] stores an uploaded mark and serves it to a request with no session', async () => {
    const runtime = harness()
    const created = await runtime.upload('wordmark-dark', png('dark mark'), 'image/png')
    expect(created.status).toBe(201)
    const { data } = (await created.json()) as {
      data: { url: string; content_type: string; byte_size: number; slot: string }
    }
    expect(data.slot).toBe('wordmark_dark')
    expect(data.content_type).toBe('image/png')
    expect(data.url).toMatch(/^\/brand\/wordmark-dark\/[0-9a-f]{64}$/u)

    // No session header at all: the sign-in page is fetched by a browser that
    // has none, which is the whole reason this route is not authenticated.
    const served = await runtime.app.request(data.url)
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('image/png')
    expect(served.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(served.headers.get('x-content-type-options')).toBe('nosniff')
    expect(served.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    expect(served.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    expect(served.headers.get('x-frame-options')).toBe('DENY')
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(png('dark mark'))
  })

  it('[security] a URL whose hash is not the current one serves nothing', async () => {
    const runtime = harness()
    const created = await runtime.upload('favicon', png('first'), 'image/png')
    const first = ((await created.json()) as { data: { url: string } }).data.url
    expect((await runtime.app.request(first)).status).toBe(200)

    await runtime.upload('favicon', png('second'), 'image/png')
    // The immutable cache lifetime is only safe because the old URL stops
    // resolving the moment the slot holds something else.
    const stale = await runtime.app.request(first)
    expect(stale.status).toBe(404)
    expect(stale.headers.get('cache-control')).toBe('no-store')
  })

  it('[security] refuses SVG by its bytes, whatever the upload calls it', async () => {
    const runtime = harness()
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/v1/me")</script></svg>',
    )
    const refused = await runtime.upload('wordmark-dark', svg, 'image/png')
    expect(refused.status).toBe(422)
    const body = (await refused.json()) as {
      error: { fields: readonly { code: string; message: string }[] }
    }
    expect(body.error.fields[0]?.code).toBe('markup_not_accepted')
    expect(body.error.fields[0]?.message).toContain('SVG')
    expect(runtime.store.rows.size).toBe(0)
    expect(runtime.store.objects.size).toBe(0)
  })

  it('[security] recognises markup however the document opens', async () => {
    const runtime = harness()
    // XML has no magic number, so each of the three ways an SVG can start has
    // to be recognised on its own or the file is refused with the wrong reason
    // and an operator is told to convert a PNG they never uploaded.
    for (const opening of [
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>',
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN"><svg></svg>',
      '  <svg xmlns="http://www.w3.org/2000/svg"></svg>',
    ]) {
      const refused = await runtime.upload(
        'favicon',
        new TextEncoder().encode(opening),
        'image/png',
      )
      expect(refused.status).toBe(422)
      const body = (await refused.json()) as {
        error: { fields: readonly { code: string }[] }
      }
      expect(body.error.fields[0]?.code, opening).toBe('markup_not_accepted')
    }
  })

  it('[security] refuses bytes that are no image the allowlist knows', async () => {
    const runtime = harness()
    const refused = await runtime.upload(
      'wordmark-light',
      new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),
      'image/gif',
      'logo.gif',
    )
    expect(refused.status).toBe(422)
    const body = (await refused.json()) as {
      error: { fields: readonly { code: string }[] }
    }
    expect(body.error.fields[0]?.code).toBe('unsupported_image')
  })

  it('[unit] refuses a file over the size cap and stores nothing', async () => {
    const runtime = harness()
    const oversized = png('x'.repeat(MAX_BRAND_ASSET_BYTES))
    expect(oversized.byteLength).toBeGreaterThan(MAX_BRAND_ASSET_BYTES)
    const refused = await runtime.upload('wordmark-light', oversized, 'image/png')
    expect(refused.status).toBe(413)
    expect(runtime.store.objects.size).toBe(0)
  })

  it('[unit] accepts a file exactly at the cap', async () => {
    const runtime = harness()
    const exact = png('x'.repeat(MAX_BRAND_ASSET_BYTES - 8))
    expect(exact.byteLength).toBe(MAX_BRAND_ASSET_BYTES)
    expect((await runtime.upload('wordmark-light', exact, 'image/png')).status).toBe(201)
  })

  it('[security] only administrators may read or change the marks', async () => {
    const runtime = harness()
    for (const profile of ['member', 'manager', 'executive_manager']) {
      const listed = await runtime.app.request('/api/v1/settings/brand-assets', {
        headers: { 'x-test-profile': profile },
      })
      expect(listed.status).toBe(403)
      const body = new FormData()
      body.set('file', new File([png('x') as BlobPart], 'logo.png', { type: 'image/png' }))
      const uploaded = await runtime.app.request(
        '/api/v1/settings/brand-assets/wordmark-dark',
        {
          method: 'POST',
          headers: { 'x-test-profile': profile, origin: sameOrigin },
          body,
        },
      )
      expect(uploaded.status).toBe(403)
      expect(runtime.store.rows.size).toBe(0)
    }
  })

  it('[unit] removing a mark empties the slot and stops it being served', async () => {
    const runtime = harness()
    const created = await runtime.upload('wordmark-light', png('light'), 'image/png')
    const url = ((await created.json()) as { data: { url: string } }).data.url

    const removed = await runtime.app.request(
      '/api/v1/settings/brand-assets/wordmark-light',
      {
        method: 'DELETE',
        headers: { 'x-test-profile': 'administrator', origin: sameOrigin },
      },
    )
    expect(removed.status).toBe(204)
    expect((await runtime.app.request(url)).status).toBe(404)

    const again = await runtime.app.request(
      '/api/v1/settings/brand-assets/wordmark-light',
      {
        method: 'DELETE',
        headers: { 'x-test-profile': 'administrator', origin: sameOrigin },
      },
    )
    expect(again.status).toBe(404)
  })

  it('[unit] a slot nobody defined is a 404, not an upload target', async () => {
    const runtime = harness()
    expect((await runtime.app.request('/brand/wordmark-huge/deadbeef')).status).toBe(404)
    expect((await runtime.upload('wordmark-huge', png('x'), 'image/png')).status).toBe(404)
  })

  it('[unit] GET /brand gives any principal the organisation name and the stored marks (#590)', async () => {
    const runtime = harness()
    await runtime.upload('wordmark-dark', png('dark mark'), 'image/png')
    await runtime.upload('favicon', png('icon'), 'image/png')

    // A member holding only clients:read, over a token: no admin, no session,
    // no brand scope. The marks are public and the name is on every invoice.
    const response = await runtime.app.request('/api/v1/brand', {
      headers: { authorization: 'Bearer portal-token' },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = (await response.json()) as {
      data: { organization_name: string; assets: Array<Record<string, unknown>> }
      links: { self: string }
    }
    expect(body.links.self).toBe('/api/v1/brand')
    expect(body.data.organization_name).toBe('Northpeak Studio')
    expect(body.data.assets.map((asset) => asset.slot).sort()).toEqual(['favicon', 'wordmark_dark'])
    const mark = body.data.assets.find((asset) => asset.slot === 'wordmark_dark')!
    expect(mark.url).toMatch(/^\/brand\/wordmark-dark\/[0-9a-f]{64}$/u)
    expect(mark.content_type).toBe('image/png')
    expect(mark).not.toHaveProperty('content_hash')
    expect(mark).not.toHaveProperty('byte_size')
    // The URL it hands out is the one the public route serves.
    expect((await runtime.app.request(mark.url as string)).status).toBe(200)

    // Session principals read it too; nobody else does.
    expect(
      (await runtime.app.request('/api/v1/brand', { headers: { 'x-test-profile': 'member' } })).status,
    ).toBe(200)
    expect((await runtime.app.request('/api/v1/brand')).status).toBe(401)
  })
})
