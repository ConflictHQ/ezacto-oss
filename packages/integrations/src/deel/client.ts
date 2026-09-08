/**
 * Deel `/rest/v2` client. The transport is injected rather than reached for:
 * this package runs on the Worker and in the container, and its tests are not
 * allowed to touch the real API, where a stray POST creates a timesheet that
 * somebody then has to void by hand.
 *
 * The token is supplied by the caller from deployment configuration. Nothing in
 * this file has a default credential, a sandbox fallback, or an environment
 * lookup.
 */

export interface DeelContract {
  id: string
  status: string
}

export interface DeelPerson {
  id: string
  fullName: string
  emails: readonly string[]
  contracts: readonly DeelContract[]
}

export interface DeelTimesheetInput {
  contractId: string
  spentDate: string
  quantityHours: number
  description: string
}

export interface DeelTimesheetReceipt {
  timesheetId: string
}

/**
 * The narrow half of the client the transfer runner needs, so the runner can be
 * driven by a fake without constructing an HTTP client at all.
 */
export interface DeelTimesheetSink {
  createTimesheet(input: DeelTimesheetInput): Promise<DeelTimesheetReceipt>
}

export interface DeelClientOptions {
  token: string
  fetch: (request: Request) => Promise<Response>
  baseUrl?: string
  pageSize?: number
}

export class DeelApiError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`Deel request failed with status ${status}`)
    this.name = 'DeelApiError'
    this.status = status
  }
}

export class DeelResponseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeelResponseError'
  }
}

// Verified against developer.deel.com/api/stable/api-versioning.md, not
// inferred: the base carries no version segment. `/rest/v2` paths still resolve
// -- Deel keeps them backward-compatible for older integrations -- which is
// exactly why writing them here looked correct and was not.
const defaultBaseUrl = 'https://api.letsdeel.com/rest'

/**
 * The API version this client was written against.
 *
 * Deel versions by date header rather than by path. Sending no header does not
 * mean "no version": it means Deel chooses, and what it chooses can move. An
 * integration that has not said which version it expects is one that breaks on
 * a day nobody deployed anything, which is the worst kind of break to diagnose.
 *
 * Raising this is a deliberate act with a changelog to read first.
 */
const apiVersion = '2026-01-01'
const defaultPageSize = 50
const maximumPageSize = 100
// A people listing that never returns a short page means the API changed shape
// under us. Walking it forever would look like a hung cron rather than a bug.
const pageLimit = 500
const isoDate = /^\d{4}-\d{2}-\d{2}$/

const record = (value: unknown, field: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DeelResponseError(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

const list = (value: unknown, field: string): readonly unknown[] => {
  if (!Array.isArray(value)) throw new DeelResponseError(`${field} must be an array`)
  return value
}

const text = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DeelResponseError(`${field} must be a non-empty string`)
  }
  return value.trim()
}

const person = (value: unknown): DeelPerson => {
  const raw = record(value, 'person')
  const emails = list(raw.emails ?? [], 'person emails').map((entry) =>
    // Deel echoes whatever casing the address was invited with; matching is
    // case-insensitive, so normalize once here instead of at every call site.
    text(record(entry, 'person email').value, 'person email address').toLowerCase(),
  )
  const contracts = list(raw.employments ?? [], 'person employments').map((entry) => {
    const employment = record(entry, 'employment')
    return {
      id: text(employment.id, 'employment id'),
      status: text(employment.contract_status, 'employment contract_status'),
    }
  })
  return {
    id: text(raw.id, 'person id'),
    fullName: text(raw.full_name, 'person full_name'),
    emails,
    contracts,
  }
}

export class DeelClient implements DeelTimesheetSink {
  readonly #token: string
  readonly #fetch: (request: Request) => Promise<Response>
  readonly #baseUrl: string
  readonly #pageSize: number

  constructor(options: DeelClientOptions) {
    if (typeof options.token !== 'string' || options.token.trim() === '') {
      throw new RangeError('a Deel API token is required')
    }
    const pageSize = options.pageSize ?? defaultPageSize
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > maximumPageSize) {
      throw new RangeError(`page size must be between 1 and ${maximumPageSize}`)
    }
    this.#token = options.token
    this.#fetch = options.fetch
    this.#baseUrl = (options.baseUrl ?? defaultBaseUrl).replace(/\/+$/, '')
    this.#pageSize = pageSize
  }

  async #send(request: Request): Promise<Record<string, unknown>> {
    const response = await this.#fetch(request)
    if (!response.ok) throw new DeelApiError(response.status)
    return record(await response.json(), 'response body')
  }

  /**
   * Every person on the account, paged. Deel returns a page at a time and the
   * matcher needs the whole directory before it can call an address ambiguous,
   * so this collects rather than streams.
   */
  async listPeople(): Promise<readonly DeelPerson[]> {
    const people: DeelPerson[] = []
    for (let page = 0; page < pageLimit; page += 1) {
      const url = `${this.#baseUrl}/people?limit=${this.#pageSize}&offset=${page * this.#pageSize}`
      const body = await this.#send(
        new Request(url, {
          method: 'GET',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${this.#token}`,
            'x-version': apiVersion,
          },
        }),
      )
      const rows = list(body.data, 'people data')
      for (const row of rows) people.push(person(row))
      if (rows.length < this.#pageSize) return people
    }
    throw new DeelResponseError('people listing did not reach a final page')
  }

  async createTimesheet(input: DeelTimesheetInput): Promise<DeelTimesheetReceipt> {
    if (!isoDate.test(input.spentDate)) {
      throw new RangeError('spent date must be an ISO calendar date')
    }
    if (!Number.isFinite(input.quantityHours) || input.quantityHours <= 0) {
      throw new RangeError('timesheet quantity must be a positive number of hours')
    }
    // Deel stores hours as a decimal. Four places is the finest figure the
    // planner produces, and sending more than it produced would mean we had
    // computed the hours somewhere other than the planner.
    const scaled = input.quantityHours * 10_000
    if (Math.abs(scaled - Math.round(scaled)) > 1e-6) {
      throw new RangeError('timesheet quantity must have at most four decimal places')
    }
    const body = await this.#send(
      new Request(`${this.#baseUrl}/timesheets`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.#token}`,
          'content-type': 'application/json',
          'x-version': apiVersion,
        },
        body: JSON.stringify({
          data: {
            contract_id: input.contractId,
            date_submitted: input.spentDate,
            quantity: input.quantityHours,
            description: input.description,
          },
        }),
      }),
    )
    return { timesheetId: text(record(body.data, 'timesheet data').id, 'timesheet id') }
  }
}
