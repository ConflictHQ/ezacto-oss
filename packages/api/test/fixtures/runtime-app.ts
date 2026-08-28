import {
  createApiApp,
  cursorPage,
  readJsonBody,
  requireApiScope,
  validationError,
  type ApiTokenMetadata,
  type ApiTokenService,
} from '../../src/index.js'

const cursorSigningKey = new Uint8Array(32).fill(0x41)
const runtimeRows = [1, 2, 3].map((id) => ({
  id,
  label: `row-${id}`,
  internal: 'hidden',
}))
const runtimeBearer =
  'ezacto_runtimeauthseed_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi1234567'

type StoredRuntimeToken = ApiTokenMetadata & {
  userId: number
  secretHash: string
}

const hexDigest = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  )
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

const createRuntimeTokenService = (): ApiTokenService => {
  const records: StoredRuntimeToken[] = []
  let nextId = 2
  let seedPromise: Promise<void> | undefined
  const seed = () => {
    seedPromise ??= hexDigest(runtimeBearer).then((secretHash) => {
      records.push({
        id: 1,
        userId: 1,
        name: 'Runtime bearer',
        scopes: ['reports:read'],
        tokenHint: 'ezacto_runtimeauthseed_…',
        secretHash,
        createdAt: '2026-08-28T12:00:00.000Z',
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
      })
    })
    return seedPromise
  }

  return {
    async authenticate(token) {
      await seed()
      const secretHash = await hexDigest(token)
      const record = records.find(
        (candidate) =>
          candidate.secretHash === secretHash && candidate.revokedAt === null,
      )
      return record === undefined
        ? null
        : {
            tokenId: record.id,
            userId: record.userId,
            profile: 'administrator',
            scopes: [...record.scopes],
          }
    },
    async issue(input) {
      await seed()
      const id = nextId++
      const selector = id.toString(36).padStart(16, 'a')
      const secret = id.toString(36).padStart(43, 'b')
      const token = `ezacto_${selector}_${secret}`
      const createdAt = `2026-08-28T12:00:${id.toString().padStart(2, '0')}.000Z`
      const record: StoredRuntimeToken = {
        id,
        userId: input.userId,
        name: input.name,
        scopes: [...input.scopes],
        tokenHint: `ezacto_${selector}_…`,
        secretHash: await hexDigest(token),
        createdAt,
        lastUsedAt: null,
        expiresAt: input.expiresAt ?? null,
        revokedAt: null,
      }
      records.push(record)
      return { ...record, token }
    },
    async list(userId) {
      await seed()
      return records.filter((record) => record.userId === userId)
    },
    async revoke(userId, tokenId) {
      await seed()
      const record = records.find(
        (candidate) => candidate.userId === userId && candidate.id === tokenId,
      )
      if (record === undefined) return null
      record.revokedAt ??= '2026-08-28T12:59:00.000Z'
      return record
    },
  }
}

export const runtimeApp = createApiApp({
  authentication: {
    tokens: createRuntimeTokenService(),
    sessions: {
      resolve: async (request) => {
        const cookie = request.headers.get('cookie')
        if (cookie === 'session=runtime-user') {
          return {
            type: 'user',
            userId: 1,
            profile: 'administrator',
            authentication: {
              kind: 'session',
              sessionId: 'runtime-test-session',
            },
          }
        }
        if (cookie === 'session=runtime-contact') {
          return {
            type: 'contact',
            contactId: 7,
            clientId: 3,
            authentication: {
              kind: 'session',
              sessionId: 'runtime-contact-session',
            },
          }
        }
        return null
      },
    },
  },
  installApp(app) {
    app.get('/api/v1/runtime/installer-bypass', (context) =>
      context.json({ data: { bypassed: true } }),
    )
  },
  installApi(api) {
    api.get('/runtime/echo/:value', (context) =>
      context.json({ data: { value: context.req.param('value') } }),
    )
    api.post('/runtime/validate', async (context) => {
      const body = await readJsonBody<{ value?: unknown }>(context, {
        maxBytes: 128,
      })
      if (typeof body.value !== 'string' || body.value.length === 0) {
        throw validationError([
          {
            field: 'value',
            code: 'required',
            message: 'value must be a non-empty string',
          },
        ])
      }
      return context.json({ data: { value: body.value } })
    })
    api.post('/runtime/bodyless', (context) =>
      context.json({ data: { mutated: true } }),
    )
    api.get('/runtime/items', async (context) =>
      context.json(
        await cursorPage({
          requestUrl: new URL(context.req.url),
          source: {
            highWatermark: async () => runtimeRows.at(-1)!.id,
            list: async ({ afterId, throughId, take }) =>
              runtimeRows
                .filter(
                  ({ id }) =>
                    (afterId === null || id > afterId) && id <= throughId,
                )
                .slice(0, take),
          },
          viewer: {},
          serializer: ({ id, label }) => ({ id, label }),
          cursorSigningKey,
        }),
      ),
    )
    api.get('/runtime/reports', (context) => {
      requireApiScope(context, 'reports:read')
      return context.json({ data: { visible: true } })
    })
  },
})

export default runtimeApp
