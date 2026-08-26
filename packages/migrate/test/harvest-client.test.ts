import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { harvestFetch, type HarvestApiError } from '../src/harvest-client.js'

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
