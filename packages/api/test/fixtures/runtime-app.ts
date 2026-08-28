import { createApiApp, cursorPage, readJsonBody, validationError } from '../../src/index.js'

const cursorSigningKey = new Uint8Array(32).fill(0x41)
const runtimeRows = [1, 2, 3].map((id) => ({ id, label: `row-${id}`, internal: 'hidden' }))

export const runtimeApp = createApiApp({
  authentication: {
    sessions: {
      resolve: async () => ({
        type: 'user',
        userId: 1,
        profile: 'administrator',
        authentication: { kind: 'session', sessionId: 'runtime-test-session' },
      }),
    },
  },
  installApi(api) {
    api.get('/runtime/echo/:value', (context) =>
      context.json({ data: { value: context.req.param('value') } }),
    )
    api.post('/runtime/validate', async (context) => {
      const body = await readJsonBody<{ value?: unknown }>(context, { maxBytes: 128 })
      if (typeof body.value !== 'string' || body.value.length === 0) {
        throw validationError([
          { field: 'value', code: 'required', message: 'value must be a non-empty string' },
        ])
      }
      return context.json({ data: { value: body.value } })
    })
    api.get('/runtime/items', async (context) =>
      context.json(
        await cursorPage({
          requestUrl: new URL(context.req.url),
          source: {
            highWatermark: async () => runtimeRows.at(-1)!.id,
            list: async ({ afterId, throughId, take }) =>
              runtimeRows
                .filter(({ id }) => (afterId === null || id > afterId) && id <= throughId)
                .slice(0, take),
          },
          viewer: {},
          serializer: ({ id, label }) => ({ id, label }),
          cursorSigningKey,
        }),
      ),
    )
  },
})

export default runtimeApp
