import { describe, expect, it } from 'vitest'
import { DeelApiError, DeelClient } from '../src/deel/client.js'
import { peoplePageOne, peoplePageTwo, timesheetCreated } from './fixtures/deel-api.js'

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('Deel API client', () => {
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
