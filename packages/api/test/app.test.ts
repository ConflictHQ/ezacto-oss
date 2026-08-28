import { describe, expect, it } from 'vitest'
import {
  ApiError,
  createApiApp,
  readJsonBody,
  validationError,
  type ApiErrorBody,
  type ApiInstaller,
  type ApiAuthentication,
} from '../src/index.js'

interface TestBindings {
  ENVIRONMENT: string
  RELEASE: string
}

const bindings: TestBindings = {
  ENVIRONMENT: 'test',
  RELEASE: 'abc1234def5678',
}
const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const authentication: ApiAuthentication = {
  sessions: {
    resolve: async () => ({
      type: 'user',
      userId: 1,
      profile: 'administrator',
      authentication: { kind: 'session', sessionId: 'test-session' },
    }),
  },
}

const installTestRoutes: ApiInstaller<TestBindings> = (api) => {
  api.post('/validate', async (context) => {
    const body = await readJsonBody<{ name?: unknown }>(context, {
      maxBytes: 128,
    })
    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      throw validationError([
        {
          field: 'name',
          code: 'required',
          message: 'name must be a non-empty string',
        },
      ])
    }
    return context.json({ data: { name: body.name } })
  })
  api.get('/conflict', () => {
    throw new ApiError({
      status: 409,
      code: 'version_conflict',
      message: 'The resource changed before this request completed.',
    })
  })
  api.get('/explode', () => {
    throw new Error('internal-debug-detail-must-never-reach-the-response')
  })
  api.get('/deliberate-500', () => {
    throw new ApiError({
      status: 503,
      code: 'database_unavailable',
      message: 'postgres://service:credential@internal/database',
    })
  })
}

type App = ReturnType<typeof createApiApp<TestBindings>>
type RuntimeRequest = (path: string, init?: RequestInit) => Promise<Response>

const runtimeFactories = [
  [
    'Hono app.request',
    (app: App): RuntimeRequest =>
      async (path, init) => {
        const headers = new Headers(init?.headers)
        headers.set('origin', 'http://localhost')
        return app.request(path, { ...init, headers }, bindings)
      },
  ],
  [
    'Hono fetch',
    (app: App): RuntimeRequest =>
      async (path, init) => {
        const headers = new Headers(init?.headers)
        headers.set('origin', 'https://worker.test')
        return app.fetch(
          new Request(new URL(path, 'https://worker.test'), {
            ...init,
            headers,
          }),
          bindings,
          {
            waitUntil() {},
            passThroughOnException() {},
          } as unknown as ExecutionContext,
        )
      },
  ],
] as const

for (const [runtime, requestFor] of runtimeFactories) {
  describe(`/api/v1 chassis in-process (${runtime})`, () => {
    const request = requestFor(
      createApiApp({ authentication, installApi: installTestRoutes }),
    )

    it('[unit] serves the same version root with a server-generated request id', async () => {
      const response = await request('/api/v1', {
        headers: { 'x-request-id': 'attacker-controlled' },
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('x-request-id')).toMatch(requestIdPattern)
      expect(response.headers.get('x-request-id')).not.toBe(
        'attacker-controlled',
      )
      expect(await response.json()).toEqual({
        data: { service: 'ezacto', version: 'v1' },
        links: { self: '/api/v1' },
      })
    })

    it('[api] returns a uniform 404 body', async () => {
      const response = await request('/api/v1/missing')
      const body = (await response.json()) as ApiErrorBody
      expect(response.status).toBe(404)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(body).toEqual({
        error: {
          code: 'not_found',
          message: 'The requested resource does not exist.',
          fields: [],
        },
        request_id: response.headers.get('x-request-id'),
      })
    })

    it('[api] returns machine and field errors for 422 validation failures', async () => {
      const response = await request('/api/v1/validate', {
        method: 'POST',
        headers: {
          origin: 'http://localhost',
          'content-type': 'application/json',
        },
        body: '{}',
      })
      expect(response.status).toBe(422)
      expect(await response.json()).toEqual({
        error: {
          code: 'validation_failed',
          message: 'The request contains invalid fields.',
          fields: [
            {
              field: 'name',
              code: 'required',
              message: 'name must be a non-empty string',
            },
          ],
        },
        request_id: response.headers.get('x-request-id'),
      })
    })

    it('[api] normalizes deliberate, malformed-body, and media-type errors', async () => {
      const conflict = await request('/api/v1/conflict')
      expect(conflict.status).toBe(409)
      expect((await conflict.json()) as ApiErrorBody).toMatchObject({
        error: { code: 'version_conflict', fields: [] },
      })

      const malformed = await request('/api/v1/validate', {
        method: 'POST',
        headers: {
          origin: 'http://localhost',
          'content-type': 'application/json',
        },
        body: '{',
      })
      expect(malformed.status).toBe(400)
      expect((await malformed.json()) as ApiErrorBody).toMatchObject({
        error: { code: 'invalid_json', fields: [] },
      })

      const unsupported = await request('/api/v1/validate', {
        method: 'POST',
        headers: {
          origin: 'http://localhost',
          'content-type': 'text/plain',
        },
        body: '{}',
      })
      expect(unsupported.status).toBe(415)
      expect((await unsupported.json()) as ApiErrorBody).toMatchObject({
        error: { code: 'unsupported_media_type', fields: [] },
      })
    })

    it('[api] hides unknown exception details behind the same envelope', async () => {
      const response = await request('/api/v1/explode')
      const wire = await response.text()
      expect(response.status).toBe(500)
      expect(wire).not.toContain('internal-debug-detail')
      expect(JSON.parse(wire)).toEqual({
        error: {
          code: 'internal_error',
          message: 'The request could not be completed.',
          fields: [],
        },
        request_id: response.headers.get('x-request-id'),
      })
    })

    it('[security] bounds JSON bytes without trusting Content-Length', async () => {
      const response = await request('/api/v1/validate', {
        method: 'POST',
        headers: {
          origin: 'http://localhost',
          'content-type': 'application/json',
          'content-length': '1',
        },
        body: JSON.stringify({ name: 'x'.repeat(256) }),
      })
      expect(response.status).toBe(413)
      expect(await response.json()).toEqual({
        error: {
          code: 'payload_too_large',
          message: 'Request body exceeds the 128-byte limit.',
          fields: [],
        },
        request_id: response.headers.get('x-request-id'),
      })
    })

    it('[security] sanitizes deliberate 5xx failures as well as unknown ones', async () => {
      const response = await request('/api/v1/deliberate-500')
      const wire = await response.text()
      expect(response.status).toBe(503)
      expect(wire).not.toContain('credential')
      expect(wire).not.toContain('database_unavailable')
      expect(JSON.parse(wire)).toEqual({
        error: {
          code: 'internal_error',
          message: 'The request could not be completed.',
          fields: [],
        },
        request_id: response.headers.get('x-request-id'),
      })
    })
  })
}

it('[unit] refuses a fieldless 422 at the construction boundary', () => {
  expect(
    () =>
      new ApiError({
        status: 422,
        code: 'validation_failed',
        message: 'Invalid.',
      }),
  ).toThrow(/field error/)
})
