import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  harvestFetch,
  type HarvestApiError,
  type HarvestTransportError,
} from '../src/harvest-client.js'

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status })

describe('harvestFetch', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('[unit] translates a 401 into an actionable PAT-regeneration fix', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(401, { message: 'unauthorized' }))

    const err = (await harvestFetch('/v2/users/me', {
      pat: 'bad',
      userAgentEmail: 'a@b.com',
      accountId: '1',
    }).catch((e) => e)) as HarvestApiError

    expect(err.status).toBe(401)
    expect(err.message).toContain('HARVEST_PAT')
    expect(err.message).toContain('Harvest ID > Developers')
  })

  it('[unit] translates a 400 into an actionable, non-raw-JSON message', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(400, { message: 'Bad Request' }))

    const err = (await harvestFetch('/v2/company', {
      pat: 'pat',
      userAgentEmail: 'a@b.com',
      accountId: '1',
    }).catch((e) => e)) as HarvestApiError

    expect(err.status).toBe(400)
    expect(err.message).toContain('client bug')
    expect(err.message.trim().startsWith('{')).toBe(false)
  })

  it('[unit] always sends Authorization, Harvest-Account-Id (when given), and a non-empty User-Agent', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, {}))

    await harvestFetch('/v2/company', { pat: 'p', userAgentEmail: 'e@x.com', accountId: '42' })

    const [, init] = vi.mocked(fetch).mock.calls[0]
    const headers = init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer p')
    expect(headers['Harvest-Account-Id']).toBe('42')
    expect(headers['User-Agent']).toBeTruthy()
  })

  it('[unit] cannot be constructed without a User-Agent even when accountId is intentionally unset', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, {}))

    await harvestFetch('/api/v2/accounts', {
      pat: 'p',
      userAgentEmail: 'e@x.com',
      baseUrl: 'https://id.getharvest.com',
    })

    const [, init] = vi.mocked(fetch).mock.calls[0]
    const headers = init?.headers as Record<string, string>
    expect(headers['User-Agent']).toBeTruthy()
    expect(headers['Harvest-Account-Id']).toBeUndefined()
  })
})

// E14: the deadline has to cover the whole exchange. A server that sends headers
// and then stalls the body is the case a header-only timeout misses — it hangs
// the CLI forever, with no output, no error, and no exit.
describe('harvestFetch deadlines and retry [unit]', () => {
  let server: Server | undefined

  /** Starts a server on an ephemeral port and returns its base URL. */
  const listen = async (handler: Parameters<typeof createServer>[1]): Promise<string> => {
    const started = createServer(handler)
    server = started
    await new Promise<void>((resolve) => started.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(started.address() as AddressInfo).port}`
  }

  const close = async (): Promise<void> => {
    if (!server) return
    const closing = server
    server = undefined
    closing.closeAllConnections()
    await new Promise<void>((resolve) => closing.close(() => resolve()))
  }

  afterEach(close)

  it('[unit] times out a response whose headers arrive but whose body never ends', async () => {
    const baseUrl = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{"na') // body opened, never completed
    })

    const startedAt = Date.now()
    const err = (await harvestFetch('/v2/company', {
      pat: 'p',
      userAgentEmail: 'e@x.com',
      accountId: '1',
      baseUrl,
      timeoutMs: 100,
    }).catch((e: unknown) => e)) as HarvestTransportError

    expect(err).toBeInstanceOf(Error)
    expect(err.timedOut).toBe(true)
    expect(err.attempts).toBe(2)
    expect(err.message).toContain('/v2/company')
    expect(err.message).toContain('100ms')
    expect(Date.now() - startedAt).toBeLessThan(2_000)
  })

  it('[unit] retries once on a dropped connection, then succeeds', async () => {
    let calls = 0
    const baseUrl = await listen((_req, res) => {
      calls += 1
      if (calls === 1) {
        res.socket?.destroy()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ name: 'CONFLICT' }))
    })

    const body = await harvestFetch('/v2/company', {
      pat: 'p',
      userAgentEmail: 'e@x.com',
      accountId: '1',
      baseUrl,
      timeoutMs: 2_000,
    })

    expect(calls).toBe(2)
    expect(body).toEqual({ name: 'CONFLICT' })
  })

  it('[unit] surfaces an unreachable host as a named failure, not a bare fetch error', async () => {
    // bind, note the URL, then close it: a port nothing is listening on
    const baseUrl = await listen((_req, res) => res.end('{}'))
    await close()

    const err = (await harvestFetch('/v2/company', {
      pat: 'p',
      userAgentEmail: 'e@x.com',
      accountId: '1',
      baseUrl,
      timeoutMs: 2_000,
    }).catch((e: unknown) => e)) as HarvestTransportError

    expect(err.timedOut).toBe(false)
    expect(err.attempts).toBe(2)
    expect(err.message).toContain('could not reach Harvest')
  })
})
