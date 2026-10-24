import { randomUUID } from 'node:crypto'
import { EzactoClient } from '@conflict-hq/ezacto-client'
import { normalizeBaseUrl } from './config.js'

/** Session material arrives through a private pipe, is never an argv value or a saved CLI token. */
export const webhookCommand = async (
  args: readonly string[],
  runtime: { readStdin(): Promise<string>; stdout(text: string): void },
) => {
  const [command, id, ...extra] = args
  if (!['log', 'replay'].includes(command ?? '') || extra.length || (command === 'replay' && !id))
    throw new Error(
      'usage: ez webhooks log [subscription UUID] | ez webhooks replay <delivery ID>; pipe JSON {base_url, session_cookie} on stdin',
    )
  if (command === 'log' && id && !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id))
    throw new Error('Expected a subscription UUID.')
  if (command === 'replay' && !/^[0-9a-f]{32}$/.test(id!))
    throw new Error('Expected a delivery ID.')
  let input: unknown
  try {
    input = JSON.parse(await runtime.readStdin())
  } catch {
    throw new Error('Pipe JSON with base_url and session_cookie on stdin.')
  }
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid session input.')
  const record = input as Record<string, unknown>
  if (
    Object.keys(record).some((key) => !['base_url', 'session_cookie'].includes(key)) ||
    typeof record.base_url !== 'string' ||
    typeof record.session_cookie !== 'string' ||
    !/^__Host-ezacto_session=[A-Za-z0-9_-]{32,256}$/.test(record.session_cookie)
  )
    throw new Error(
      'Invalid session input. Supply only base_url and one __Host-ezacto_session cookie.',
    )
  const baseUrl = normalizeBaseUrl(record.base_url)
  if (new URL(baseUrl).protocol !== 'https:')
    throw new Error('Webhook session commands require HTTPS.')
  const client = new EzactoClient({
    baseUrl,
    headers: { cookie: record.session_cookie, origin: new URL(baseUrl).origin },
    fetch: (request, init) => fetch(request, { ...init, redirect: 'error' }),
  })
  if (command === 'replay') {
    const response = await client.replayWebhookDelivery({
      signal: AbortSignal.timeout(30_000),
      id: id!,
      body: {},
      'Idempotency-Key': randomUUID(),
    })
    runtime.stdout(JSON.stringify(response, null, 2))
    return 0
  }
  let cursor: string | undefined
  do {
    const response = await client.listWebhookDeliveries({
      signal: AbortSignal.timeout(30_000),
      query: {
        per_page: 100,
        ...(id ? { subscription_id: id } : {}),
        ...(cursor ? { cursor } : {}),
      },
    })
    for (const delivery of response.data) runtime.stdout(JSON.stringify(delivery))
    cursor = response.page.next_cursor ?? undefined
  } while (cursor)
  return 0
}
