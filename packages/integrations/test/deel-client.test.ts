import { describe, expect, it } from 'vitest'
import { DeelApiError, DeelClient, DeelResponseError } from '../src/deel/client.js'
import { peoplePageOne, peoplePageTwo, timesheetCreated } from './fixtures/deel-api.js'

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const stagedTimesheet = {
  id: 'tms_0001', status: 'approved', contract: { id: 'con_ana_hourly' },
  quantity: 7.5, total_amount: '375.0000', currency_code: 'USD',
  date_submitted: '2026-08-14T00:00:00.000Z',
}

describe('Deel API client', () => {
  it('[unit] reads a specific timesheet with pinned version and returns only status receipt fields', async () => {
    const requests: Request[] = []
    const client = new DeelClient({
      token: 'deel-token-for-tests',
      fetch: async (request) => {
        requests.push(request)
        return json({ data: { ...stagedTimesheet, status: 'paid', description: 'Private work notes', reported_by: { full_name: 'Private name' } } })
      },
    })
    await expect(client.getTimesheet('tms_0001')).resolves.toEqual({
      timesheetId: 'tms_0001', contractId: 'con_ana_hourly', status: 'paid', providerStatus: 'paid',
      quantity: 7.5, totalAmount: '375.0000', currency: 'USD', spentDate: '2026-08-14',
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe('https://api.letsdeel.com/rest/timesheets/tms_0001')
    expect(requests[0]!.method).toBe('GET')
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer deel-token-for-tests')
    expect(requests[0]!.headers.get('x-version')).toBe('2026-01-01')
    expect(requests[0]!.body).toBeNull()
  })

  it.each(['approved', 'declined', 'not_payable', 'paid', 'pending', 'processing'])('[unit] preserves documented timesheet status %s', async (status) => {
    const client = new DeelClient({ token: 'test', fetch: async () => json({ data: { ...stagedTimesheet, status } }) })
    await expect(client.getTimesheet('tms_0001')).resolves.toMatchObject({ status, providerStatus: status })
  })

  it.each([null, 'new_status', 'PAID', ' paid '])('[unit] treats unrecognized status %j as unknown rather than paid', async (providerStatus) => {
    const client = new DeelClient({ token: 'test', fetch: async () => json({ data: { ...stagedTimesheet, status: providerStatus } }) })
    await expect(client.getTimesheet('tms_0001')).resolves.toMatchObject({ status: 'unknown', providerStatus: typeof providerStatus === 'string' ? providerStatus.trim() : null })
  })

  it('[unit] accepts documented integer IDs and nullable quantities', async () => {
    const client = new DeelClient({ token: 'test', fetch: async () => json({ data: { ...stagedTimesheet, id: 1234, quantity: null } }) })
    await expect(client.getTimesheet('1234')).resolves.toMatchObject({ timesheetId: '1234', quantity: null })
  })

  it.each([
    { id: 'other-timesheet' },
    { id: 9007199254740992 },
    { contract: {} },
    { status: undefined },
    { status: 123 },
    { quantity: '7.5' },
    { total_amount: '375 USD' },
    { currency_code: 'usd' },
    { date_submitted: '2026-02-30' },
  ])('[unit] rejects malformed or mismatched timesheet receipt %j', async (fields) => {
    const client = new DeelClient({ token: 'test', fetch: async () => json({ data: { ...stagedTimesheet, ...fields } }) })
    await expect(client.getTimesheet('tms_0001')).rejects.toBeInstanceOf(DeelResponseError)
  })

  it.each([403, 404, 429, 500])('[unit] exposes provider read failure %s without inventing a receipt status', async (status) => {
    const client = new DeelClient({ token: 'test', fetch: async () => json({ data: stagedTimesheet }, status) })
    await expect(client.getTimesheet('tms_0001')).rejects.toMatchObject({ name: 'DeelApiError', status })
  })

  it('[unit] encodes opaque timesheet IDs as one path segment', async () => {
    const requests: Request[] = []
    const id = 'id/with?special#characters'
    const client = new DeelClient({ token: 'test', fetch: async (request) => {
      requests.push(request)
      return json({ data: { ...stagedTimesheet, id } })
    } })
    await client.getTimesheet(id)
    expect(requests[0]!.url).toBe('https://api.letsdeel.com/rest/timesheets/id%2Fwith%3Fspecial%23characters')
  })

  it.each(['', ' ', '.', '..'])('[unit] refuses invalid timesheet id %j before making a request', async (id) => {
    const client = new DeelClient({ token: 'test', fetch: async () => { throw new Error('unexpected request') } })
    await expect(client.getTimesheet(id)).rejects.toBeInstanceOf(RangeError)
  })

  it('[unit] reads every page of /people with a bearer token and normalizes the payload', async () => {
    const requests: Request[] = []
    const client = new DeelClient({
      token: 'deel-token-for-tests',
      pageSize: 2,
      fetch: async (request) => {
        requests.push(request.clone())
        return json(requests.length === 1 ? peoplePageOne : peoplePageTwo)
      },
    })

    await expect(client.listPeople()).resolves.toEqual([
      {
        id: 'per_ana',
        fullName: 'Ana Vasquez',
        emails: ['ana.personal@example.test', 'ana@halcyon.example'],
        contracts: [{ id: 'con_ana_hourly', status: 'in_progress' }],
      },
      {
        id: 'per_byron',
        fullName: 'Byron Ellis',
        emails: ['byron.personal@example.test'],
        contracts: [
          { id: 'con_byron_old', status: 'completed' },
          { id: 'con_byron_hourly', status: 'in_progress' },
        ],
      },
      {
        id: 'per_cleo',
        fullName: 'Cleo Nakamura',
        emails: ['cleo@example.test'],
        contracts: [
          { id: 'con_cleo_a', status: 'in_progress' },
          { id: 'con_cleo_b', status: 'in_progress' },
        ],
      },
    ])

    expect(requests.map((request) => request.url)).toEqual([
      'https://api.letsdeel.com/rest/people?limit=2&offset=0',
      'https://api.letsdeel.com/rest/people?limit=2&offset=2',
    ])
    expect(requests[0]!.method).toBe('GET')
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer deel-token-for-tests')
    expect(requests[0]!.headers.get('accept')).toBe('application/json')
    // Every request, not just the first: a client that pins the version on page
    // one and drops it on page two reads two different APIs in one traversal.
    for (const request of requests) {
      expect(request.headers.get('x-version')).toBe('2026-01-01')
    }
  })

  it('[unit] posts one timesheet per submission and returns the id Deel assigned', async () => {
    const requests: Request[] = []
    const client = new DeelClient({
      token: 'deel-token-for-tests',
      fetch: async (request) => {
        requests.push(request.clone())
        return json(timesheetCreated, 201)
      },
    })

    await expect(
      client.createTimesheet({
        contractId: 'con_ana_hourly',
        spentDate: '2026-08-14',
        quantityHours: 7.5,
        description: 'ezacto time sync 2026-08-14',
      }),
    ).resolves.toEqual({ timesheetId: 'tms_0001' })

    expect(requests).toHaveLength(1)
    const request = requests[0]!
    expect(request.method).toBe('POST')
    expect(request.url).toBe('https://api.letsdeel.com/rest/timesheets')
    // Deel versions by date header, not by path. Sending none does not mean
    // "no version" -- it means Deel picks, and what it picks can move, so the
    // integration breaks on a day nobody deployed. Asserted on both verbs
    // because a read that pins and a write that does not is the same bug half
    // the time.
    expect(request.headers.get('x-version')).toBe('2026-01-01')
    expect(request.headers.get('content-type')).toBe('application/json')
    await expect(request.json()).resolves.toEqual({
      data: {
        contract_id: 'con_ana_hourly',
        date_submitted: '2026-08-14',
        quantity: 7.5,
        description: 'ezacto time sync 2026-08-14',
      },
    })
  })

  it('[unit] raises a typed error carrying the status when Deel rejects the request', async () => {
    const client = new DeelClient({
      token: 'deel-token-for-tests',
      fetch: async () => json({ errors: [{ message: 'rate limited' }] }, 429),
    })

    await expect(client.listPeople()).rejects.toMatchObject({
      name: 'DeelApiError',
      status: 429,
    })
    await expect(client.listPeople()).rejects.toBeInstanceOf(DeelApiError)
  })

  it('[unit] refuses a people payload whose contract has no id rather than dropping the person', async () => {
    const client = new DeelClient({
      token: 'deel-token-for-tests',
      fetch: async () =>
        json({
          data: [
            {
              id: 'per_ana',
              full_name: 'Ana Vasquez',
              emails: [{ type: 'primary', value: 'ana.personal@example.test' }],
              employments: [{ contract_status: 'in_progress' }],
            },
          ],
        }),
    })

    await expect(client.listPeople()).rejects.toThrow(/employment/i)
  })

  it('[unit] refuses a non-positive quantity rather than posting an empty timesheet', async () => {
    const client = new DeelClient({
      token: 'deel-token-for-tests',
      fetch: async () => json(timesheetCreated, 201),
    })

    await expect(
      client.createTimesheet({
        contractId: 'con_ana_hourly',
        spentDate: '2026-08-14',
        quantityHours: 0,
        description: 'ezacto time sync 2026-08-14',
      }),
    ).rejects.toThrow(/quantity/i)
  })
})

describe('Deel optional person email values', () => {
  const read = (emails: unknown[]) => new DeelClient({
    token: 'deel-token-for-tests',
    fetch: async () => json({ data: [{
      id: 'per_ana', full_name: 'Ana Vasquez', emails,
      employments: [{ id: 'con_ana_hourly', contract_status: 'in_progress' }],
    }] }),
  }).listPeople()

  it.each([null, undefined, '', '  \t '])('treats optional email value %j as absent without dropping the person or valid addresses', async (value) => {
    await expect(read([{ value }, { value: ' Ana.Personal@Example.Test ' }])).resolves.toEqual([{
      id: 'per_ana', fullName: 'Ana Vasquez', emails: ['ana.personal@example.test'],
      contracts: [{ id: 'con_ana_hourly', status: 'in_progress' }],
    }])
  })

  it.each([0, false, {}, []])('still rejects malformed email value %j', async (value) => {
    await expect(read([{ value }])).rejects.toThrow('person email address')
  })

  it.each([null, 'ana@example.test', []])('still rejects malformed email entry %j', async (entry) => {
    await expect(read([entry])).rejects.toThrow('person email must be an object')
  })
})
