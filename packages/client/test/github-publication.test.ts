import { expect, it } from 'vitest'
import { EzactoClient } from '../src/index.js'

it('[unit] interpolates both publication identifiers in generated client requests', async () => {
  const requests: Request[] = []
  const client = new EzactoClient({
    baseUrl: 'https://owned.example',
    token: 'synthetic-client-token',
    fetch: async (input, init) => {
      const request = new Request(input, init)
      requests.push(request)
      return request.method === 'GET'
        ? Response.json({
            data: {
              link_id: 42,
              connection_id: '1:2:3',
              destination: 'https://github.com/owned/repo/issues/5',
              spent_date: '2026-10-01',
              seconds: 3600,
              source_version: 'a'.repeat(64),
              policy_enabled: true,
            },
          })
        : new Response(null, { status: 204 })
    },
  })
  await client.previewGithubPublication({ id: 42 })
  await client.actGithubPublication({
    id: 73,
    body: {
      action: 'unlink',
      confirm: true,
      expected_version: 2,
      command_id: 'a1234567-1234-4123-8123-123456789012',
    },
  })
  expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
    '/api/v1/work-items/github/publication/preview/42',
    '/api/v1/work-items/github/publication/73/actions',
  ])
})
