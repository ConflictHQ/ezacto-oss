import { EzactoApiError, EzactoClient } from '@conflict-hq/ezacto-client'
import { describe, expect, it, vi } from 'vitest'
import {
  createKeySupport,
  createPendingWrites,
  createRetryingFetch,
  MAX_ATTEMPTS,
  retryAfterMilliseconds,
  UnconfirmedWriteError,
  type KeySupport,
  type PendingWriteTracker,
} from '../src/shell/net.js'

/**
 * The shell's one fetch (issue 953): which requests it sends again, under which
 * key, after how long, and which it must never send twice.
 */

const origin = 'https://time.example.test'
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

const answer = (status: number, headers: Record<string, string> = {}, body = '{}'): Response =>
  new Response(status === 204 ? null : body, {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

const advertised = { 'idempotency-key-lifetime': '86400' }

interface Sent {
  readonly input: RequestInfo | URL
  readonly init: RequestInit | undefined
  readonly key: string | null
}

/** A fetch that answers from a script, in order, and remembers what it was sent. */
const scripted = (
  steps: readonly (Response | Error | (() => Response))[],
): { fetch: typeof globalThis.fetch; sent: Sent[] } => {
  const sent: Sent[] = []
  let next = 0
  const fetch: typeof globalThis.fetch = async (input, init) => {
    sent.push({ input, init, key: new Headers(init?.headers).get('idempotency-key') })
    const step = steps[Math.min(next, steps.length - 1)]!
    next += 1
    if (step instanceof Error) throw step
    return typeof step === 'function' ? step() : step.clone()
  }
  return { fetch, sent }
}

interface Harness {
  readonly fetch: typeof globalThis.fetch
  readonly sent: Sent[]
  readonly waits: number[]
  readonly support: KeySupport
  readonly pending: PendingWriteTracker
}

const harness = (
  steps: readonly (Response | Error | (() => Response))[],
  options: { honours?: boolean; random?: () => number; now?: () => number; newKey?: () => string } = {},
): Harness => {
  const script = scripted(steps)
  const waits: number[] = []
  const support = createKeySupport()
  if (options.honours === true) support.learn(origin, answer(200, advertised))
  const pending = createPendingWrites()
  const fetch = createRetryingFetch({
    fetch: script.fetch,
    support,
    pending,
    sleep: async (milliseconds) => {
      waits.push(milliseconds)
    },
    random: options.random ?? (() => 0.5),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.newKey === undefined ? {} : { newKey: options.newKey }),
  })
  return { fetch, sent: script.sent, waits, support, pending }
}

const post = (body: BodyInit | null = '{}', headers: HeadersInit = {}): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body,
})

const dropped = (): TypeError => new TypeError('Failed to fetch')

describe('password recovery is never automatically replayed', () => {
  for (const operation of ['forgot', 'reset'] as const) {
    it.each(['drop', 408, 429, 500, 503] as const)(
      `[security] sends ${operation} once after %s even when keys are advertised`,
      async (failure) => {
        const first = failure === 'drop' ? dropped() : answer(failure, { ...advertised, 'retry-after': '0' })
        const { fetch, sent, waits, pending } = harness([first, answer(200)], { honours: true })
        const client = new EzactoClient({ baseUrl: origin, fetch })
        const request = operation === 'forgot'
          ? client.requestPasswordReset({ body: { email: 'owner@example.test' } })
          : client.resetPassword({ body: { token: 'fixture-token', password: 'fixture-new-password' } })
        await expect(request).rejects.toThrow()
        expect(sent).toHaveLength(1)
        expect(String(sent[0]!.input)).toBe(`${origin}/auth/password/${operation}`)
        expect(waits).toEqual([])
        expect(pending.unsent).toBe(0)
      },
    )
  }

  it('[security] also excludes a relative recovery URL with a query', async () => {
    vi.stubGlobal('location', new URL(`${origin}/`))
    try {
      const { fetch, sent } = harness([answer(503, advertised), answer(200)], { honours: true })
      expect((await fetch('/auth/password/reset?source=login', post())).status).toBe(503)
      expect(sent).toHaveLength(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('the key every write carries', () => {
  it('[unit] makes one key per write and sends it on every attempt of that write', async () => {
    const { fetch, sent } = harness(
      [answer(503, { 'retry-after': '0' }), answer(503, { 'retry-after': '0' }), answer(201)],
      { honours: true },
    )
    const response = await fetch(`${origin}/api/v1/time-entries`, post())
    expect(response.status).toBe(201)
    expect(sent).toHaveLength(3)
    expect(sent[0]!.key).toMatch(uuidV4)
    expect(sent.map((attempt) => attempt.key)).toEqual([sent[0]!.key, sent[0]!.key, sent[0]!.key])
  })

  it('[unit] gives two writes two keys', async () => {
    const { fetch, sent } = harness([answer(201)], { honours: true })
    await fetch(`${origin}/api/v1/time-entries`, post())
    await fetch(`${origin}/api/v1/time-entries`, post())
    expect(sent[0]!.key).toMatch(uuidV4)
    expect(sent[1]!.key).toMatch(uuidV4)
    expect(sent[0]!.key).not.toBe(sent[1]!.key)
  })

  it.each(['PUT', 'PATCH', 'DELETE'])('[unit] keys a %s as a write', async (method) => {
    const { fetch, sent } = harness([answer(200)], { honours: true })
    await fetch(`${origin}/api/v1/time-entries/7`, { method })
    expect(sent[0]!.key).toMatch(uuidV4)
  })

  it('[unit] keeps a key the caller already chose, the command ids', async () => {
    const { fetch, sent } = harness([answer(500), answer(201)], { honours: true })
    await fetch(`${origin}/api/v1/retainers`, post('{}', { 'Idempotency-Key': 'retainer-create-41' }))
    expect(sent.map((attempt) => attempt.key)).toEqual(['retainer-create-41', 'retainer-create-41'])
  })

  it('[unit] sends a read without a key, and untouched', async () => {
    const { fetch, sent } = harness([answer(200)])
    const init = { credentials: 'same-origin' as const }
    await fetch('/api/v1/whoami', init)
    expect(sent[0]!.key).toBeNull()
    expect(sent[0]!.init).toBe(init)
  })

  it('[unit] keeps everything else the caller set on a write', async () => {
    const { fetch, sent } = harness([answer(201)], { honours: true })
    await fetch(`${origin}/api/v1/time-entries`, {
      ...post('{"seconds":60}', { 'x-request-id': 'kept' }),
      credentials: 'same-origin',
    })
    const headers = new Headers(sent[0]!.init?.headers)
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('x-request-id')).toBe('kept')
    expect(sent[0]!.init?.credentials).toBe('same-origin')
    expect(sent[0]!.init?.body).toBe('{"seconds":60}')
  })
})

describe('when to try again, and how long to wait', () => {
  it('[unit] stops after four attempts and hands back the last answer', async () => {
    const { fetch, sent, waits } = harness([answer(500)])
    const response = await fetch(`${origin}/api/v1/whoami`)
    expect(MAX_ATTEMPTS).toBe(4)
    expect(sent).toHaveLength(4)
    expect(waits).toHaveLength(3)
    expect(response.status).toBe(500)
  })

  it('[unit] waits a full-jitter backoff whose ceiling doubles from half a second', async () => {
    const half = harness([answer(502)], { random: () => 0.5 })
    await half.fetch(`${origin}/api/v1/whoami`)
    expect(half.waits).toEqual([250, 500, 1_000])

    // The jitter is the whole of the wait, from nothing up to the ceiling.
    const none = harness([answer(502)], { random: () => 0 })
    await none.fetch(`${origin}/api/v1/whoami`)
    expect(none.waits).toEqual([0, 0, 0])
    const most = harness([answer(502)], { random: () => 0.999 })
    await most.fetch(`${origin}/api/v1/whoami`)
    expect(most.waits.map(Math.round)).toEqual([500, 999, 1_998])
  })

  it('[unit] waits out Retry-After in seconds, then the jitter on top', async () => {
    const { fetch, waits } = harness([answer(503, { 'retry-after': '2' }), answer(200)])
    await fetch(`${origin}/api/v1/whoami`)
    expect(waits).toEqual([2_000 + 250])
  })

  it('[unit] waits out Retry-After given as an HTTP date', async () => {
    const now = Date.parse('2026-10-07T12:00:00.000Z')
    const { fetch, waits } = harness(
      [answer(429, { 'retry-after': 'Wed, 07 Oct 2026 12:00:03 GMT' }), answer(200)],
      { now: () => now },
    )
    await fetch(`${origin}/api/v1/whoami`)
    expect(waits).toEqual([3_000 + 250])
  })

  it('[unit] reads Retry-After the two ways the header is written, and nothing else', () => {
    const now = Date.parse('2026-10-07T12:00:00.000Z')
    expect(retryAfterMilliseconds('5', now)).toBe(5_000)
    expect(retryAfterMilliseconds(' 0 ', now)).toBe(0)
    expect(retryAfterMilliseconds('Wed, 07 Oct 2026 12:00:10 GMT', now)).toBe(10_000)
    // A date already past is no wait at all, not a negative one.
    expect(retryAfterMilliseconds('Wed, 07 Oct 2026 11:59:00 GMT', now)).toBe(0)
    expect(retryAfterMilliseconds(null, now)).toBeNull()
    expect(retryAfterMilliseconds('soon', now)).toBeNull()
  })

  it('[unit] hands back a Retry-After longer than half a minute rather than sitting on it', async () => {
    const { fetch, sent, waits } = harness([answer(429, { 'retry-after': '31' }), answer(200)])
    const response = await fetch(`${origin}/api/v1/whoami`)
    expect(response.status).toBe(429)
    expect(sent).toHaveLength(1)
    expect(waits).toEqual([])
  })

  it.each([400, 401, 403, 404, 409, 422])(
    '[unit] answers a %i at once, read or write',
    async (status) => {
      const read = harness([answer(status), answer(200)])
      expect((await read.fetch(`${origin}/api/v1/whoami`)).status).toBe(status)
      expect(read.sent).toHaveLength(1)
      const write = harness([answer(status), answer(201)], { honours: true })
      expect((await write.fetch(`${origin}/api/v1/time-entries`, post())).status).toBe(status)
      expect(write.sent).toHaveLength(1)
    },
  )

  it.each([408, 429, 500, 502, 503, 504])('[unit] tries a %i again', async (status) => {
    const read = harness([answer(status), answer(200)])
    expect((await read.fetch(`${origin}/api/v1/whoami`)).status).toBe(200)
    expect(read.sent).toHaveLength(2)
    const write = harness([answer(status), answer(201)], { honours: true })
    expect((await write.fetch(`${origin}/api/v1/time-entries`, post())).status).toBe(201)
    expect(write.sent).toHaveLength(2)
  })

  it('[unit] tries a read again after a dropped connection, and rethrows the last drop', async () => {
    const recovers = harness([dropped(), answer(200)])
    expect((await recovers.fetch(`${origin}/api/v1/whoami`)).status).toBe(200)
    expect(recovers.sent).toHaveLength(2)

    const failure = dropped()
    const never = harness([failure])
    await expect(never.fetch(`${origin}/api/v1/whoami`)).rejects.toBe(failure)
    expect(never.sent).toHaveLength(4)
  })

  it('[unit] takes an answer the instance replayed as final, whatever its status', async () => {
    const { fetch, sent } = harness(
      [answer(500, { 'idempotent-replayed': 'true', ...advertised }), answer(201)],
      { honours: true },
    )
    const response = await fetch(`${origin}/api/v1/time-entries`, post())
    expect(response.status).toBe(500)
    expect(response.headers.get('idempotent-replayed')).toBe('true')
    expect(sent).toHaveLength(1)
  })

  it('[unit] does not send a streamed body twice', async () => {
    const { fetch, sent } = harness([answer(503, { 'retry-after': '0' }), answer(201)], {
      honours: true,
    })
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{}'))
        controller.close()
      },
    })
    const response = await fetch(`${origin}/api/v1/time-entries`, {
      ...post(body),
      duplex: 'half',
    } as RequestInit)
    expect(response.status).toBe(503)
    expect(sent).toHaveLength(1)
  })

  it('[unit] takes a whole Request: retries one without a body, keys one with a body and sends it once', async () => {
    const read = harness([answer(502), answer(200)])
    expect((await read.fetch(new Request(`${origin}/api/v1/whoami`))).status).toBe(200)
    expect(read.sent).toHaveLength(2)

    const write = harness([answer(503, { 'retry-after': '0' }), answer(201)], { honours: true })
    const response = await write.fetch(
      new Request(`${origin}/api/v1/time-entries`, { method: 'POST', body: '{}' }),
    )
    // Its body is a stream the first attempt used up.
    expect(response.status).toBe(503)
    expect(write.sent).toHaveLength(1)
    expect(write.sent[0]!.key).toMatch(uuidV4)
  })

  it('[unit] encodes a multipart body once, so every attempt carries the same bytes', async () => {
    // A fresh encoding picks a fresh boundary. An instance comparing a retry
    // with the request its key first carried would refuse different bytes.
    const { fetch, sent } = harness([answer(503, { 'retry-after': '0' }), answer(201)], {
      honours: true,
    })
    const form = new FormData()
    form.append('file', new Blob(['mark'], { type: 'image/png' }), 'mark.png')
    await fetch(`${origin}/api/v1/settings/brand-assets/logo`, { method: 'POST', body: form })
    expect(sent).toHaveLength(2)
    const [first, second] = sent.map((attempt) => attempt.init!)
    expect(first!.body).toBeInstanceOf(ArrayBuffer)
    expect(second!.body).toBe(first!.body)
    const contentType = new Headers(first!.headers).get('content-type')
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/u)
    expect(new Headers(second!.headers).get('content-type')).toBe(contentType)
    const text = new TextDecoder().decode(first!.body as ArrayBuffer)
    expect(text).toContain(contentType!.split('boundary=')[1])
    expect(text).toContain('mark')
  })
})

describe('an instance that has not said it honours keys', () => {
  it('[security] never sends a write again after a dropped connection: it may have landed', async () => {
    const { fetch, sent } = harness([dropped(), answer(201)])
    const failure = await fetch(`${origin}/api/v1/time-entries`, post()).catch(
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(UnconfirmedWriteError)
    expect((failure as Error).message).toContain('Reload to check whether it was saved')
    expect((failure as Error).cause).toBeInstanceOf(TypeError)
    expect(sent).toHaveLength(1)
  })

  it.each([
    [500, {}],
    [502, {}],
    [504, {}],
    [503, {}],
  ] as const)(
    '[security] never sends a write again after a %i without a Retry-After',
    async (status, headers) => {
      const { fetch, sent } = harness([answer(status, headers), answer(201)])
      expect((await fetch(`${origin}/api/v1/time-entries`, post())).status).toBe(status)
      expect(sent).toHaveLength(1)
    },
  )

  it.each([
    [408, {}],
    [429, {}],
    [503, { 'retry-after': '1' }],
  ] as const)(
    '[unit] still sends a write again after an explicit refusal, a %i',
    async (status, headers) => {
      const { fetch, sent } = harness([answer(status, headers), answer(201)])
      expect((await fetch(`${origin}/api/v1/time-entries`, post())).status).toBe(201)
      expect(sent).toHaveLength(2)
    },
  )

  it('[unit] still tries a read again after anything retryable', async () => {
    const { fetch, sent } = harness([dropped(), answer(500), answer(200)])
    expect((await fetch(`${origin}/api/v1/whoami`)).status).toBe(200)
    expect(sent).toHaveLength(3)
  })

  it('[unit] says a write was unconfirmed even after every attempt where keys are honoured', async () => {
    const { fetch, sent } = harness([dropped()], { honours: true })
    await expect(fetch(`${origin}/api/v1/time-entries`, post())).rejects.toBeInstanceOf(
      UnconfirmedWriteError,
    )
    expect(sent).toHaveLength(4)
  })
})

describe('what an instance says about keys', () => {
  it('[unit] learns it from any answer that carries the lifetime, and per origin', () => {
    const support = createKeySupport()
    expect(support.honours(origin)).toBe(false)
    support.learn(origin, answer(503, advertised))
    expect(support.honours(origin)).toBe(true)
    expect(support.honours('https://other.example.test')).toBe(false)
  })

  it('[unit] unlearns it from a success that does not carry it: an older or rolled-back instance', () => {
    const support = createKeySupport()
    support.learn(origin, answer(200, advertised))
    support.learn(origin, answer(204))
    expect(support.honours(origin)).toBe(false)
  })

  it('[unit] keeps what it knows through an answer that proves nothing: a proxy or a router refusal', () => {
    const support = createKeySupport()
    support.learn(origin, answer(200, advertised))
    support.learn(origin, answer(502))
    support.learn(origin, answer(503, { 'retry-after': '1' }))
    support.learn(origin, answer(401))
    expect(support.honours(origin)).toBe(true)
  })

  it('[unit] takes a lifetime that is not a positive whole number as no lifetime at all', () => {
    const support = createKeySupport()
    for (const value of ['0', '-5', 'forever', '1.5', '']) {
      support.learn(origin, answer(200, { 'idempotency-key-lifetime': value }))
      expect(support.honours(origin)).toBe(false)
    }
  })

  it('[unit] learns from the answers it retries, so a 503 that advertises is retried', async () => {
    const { fetch, sent, support } = harness([answer(500, advertised), answer(201, advertised)])
    expect((await fetch(`${origin}/api/v1/time-entries`, post())).status).toBe(201)
    expect(sent).toHaveLength(2)
    expect(support.honours(origin)).toBe(true)
  })

  it('[unit] places a relative address on the page origin', async () => {
    const script = scripted([answer(500), answer(201)])
    const support = createKeySupport()
    const fetch = createRetryingFetch({
      fetch: script.fetch,
      support,
      sleep: async () => undefined,
    })
    vi.stubGlobal('location', new URL(`${origin}/time`))
    try {
      support.learn(origin, answer(200, advertised))
      expect((await fetch('/api/v1/time-entries', post())).status).toBe(201)
      expect(script.sent).toHaveLength(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('an abort', () => {
  it('[security] stops a write mid-wait, and sends nothing more', async () => {
    const script = scripted([answer(503, { 'retry-after': '1' }), answer(201)])
    const controller = new AbortController()
    const fetch = createRetryingFetch({ fetch: script.fetch, random: () => 0.5 })
    const pending = fetch(`${origin}/api/v1/time-entries`, {
      ...post(),
      signal: controller.signal,
    })
    await vi.waitFor(() => expect(script.sent).toHaveLength(1))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(script.sent).toHaveLength(1)
  })

  it('[security] sends nothing for a request already aborted', async () => {
    const { fetch, sent } = harness([answer(200)])
    const controller = new AbortController()
    controller.abort()
    await expect(
      fetch(`${origin}/api/v1/whoami`, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(sent).toHaveLength(0)
  })

  it('[security] is not mistaken for a dropped connection', async () => {
    const controller = new AbortController()
    const fetch = createRetryingFetch({
      fetch: async () => {
        controller.abort()
        throw new DOMException('The operation was aborted.', 'AbortError')
      },
    })
    await expect(
      fetch(`${origin}/api/v1/time-entries`, { ...post(), signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('writes still unsent', () => {
  it('[unit] counts a write from its first send, and as retrying only once it has failed', async () => {
    const release: Array<() => void> = []
    const pending = createPendingWrites()
    const support = createKeySupport()
    support.learn(origin, answer(200, advertised))
    const snapshots: Array<[number, number]> = []
    pending.subscribe(() => snapshots.push([pending.unsent, pending.retrying]))
    let calls = 0
    const fetch = createRetryingFetch({
      fetch: async () => {
        calls += 1
        if (calls === 1) return answer(503, { 'retry-after': '0' })
        return new Promise<Response>((resolve) => release.push(() => resolve(answer(201))))
      },
      support,
      pending,
      sleep: async () => undefined,
    })
    const write = fetch(`${origin}/api/v1/time-entries`, post())
    await vi.waitFor(() => expect(release).toHaveLength(1))
    expect([pending.unsent, pending.retrying]).toEqual([1, 1])
    release[0]!()
    await write
    expect([pending.unsent, pending.retrying]).toEqual([0, 0])
    expect(snapshots).toEqual([
      [1, 0],
      [1, 1],
      [0, 0],
    ])
  })

  it('[unit] does not count a read', async () => {
    const pending = createPendingWrites()
    const fetch = createRetryingFetch({ fetch: async () => answer(200), pending })
    await fetch(`${origin}/api/v1/whoami`)
    expect(pending.unsent).toBe(0)
  })

  it('[unit] settles a write that fails for good, too', async () => {
    const { fetch, pending } = harness([dropped()])
    await fetch(`${origin}/api/v1/time-entries`, post()).catch(() => undefined)
    expect([pending.unsent, pending.retrying]).toEqual([0, 0])
  })
})

/**
 * An instance that keeps a write's answer under its key, the way issue 952
 * makes ezacto do: a key it has seen gets the stored answer back, marked as a
 * replay, and the write is not run again. Its first answers can be made to
 * fail, each in one of the four ways a request is lost.
 *
 * - `500` and `503` refuse before the write: nothing happens.
 * - `drop` loses the request on its way there: nothing happens.
 * - `lost` answers as the instance would -- the write the first time, the
 *   stored answer after that -- and loses that answer on the way back. The one
 *   the client must not run twice.
 */
type Loss = '500' | '503' | 'drop' | 'lost'

const instance = (options: { advertises: boolean; losses: readonly Loss[] }) => {
  const entries: Array<{ id: number; project_id: number; task_id: number; seconds: number }> = []
  const stored = new Map<string, string>()
  const writes: Array<string | null> = []
  const losses = [...options.losses]
  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    'content-type': 'application/json',
    ...(options.advertises ? advertised : {}),
    ...extra,
  })
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname
    if ((init?.method ?? 'GET') === 'GET') {
      return new Response(
        JSON.stringify({
          data: {
            user_id: 1,
            profile: 'member',
            manager_grants: [],
            authentication: { kind: 'session' },
          },
        }),
        { status: 200, headers: headers() },
      )
    }
    expect(path).toBe('/api/v1/time-entries')
    const key = new Headers(init?.headers).get('idempotency-key')
    writes.push(key)
    const loss = losses.shift()
    if (loss === 'drop') throw new TypeError('Failed to fetch')
    if (loss === '500') {
      return new Response(
        JSON.stringify({ error: { code: 'internal_error', message: 'Nothing was stored.', fields: [] } }),
        { status: 500, headers: headers() },
      )
    }
    if (loss === '503') {
      return new Response(
        JSON.stringify({ error: { code: 'service_unavailable', message: 'Busy.', fields: [] } }),
        { status: 503, headers: headers({ 'retry-after': '1' }) },
      )
    }
    let response: Response
    const original = key === null ? undefined : stored.get(key)
    if (options.advertises && original !== undefined) {
      response = new Response(original, {
        status: 201,
        headers: headers({ 'idempotent-replayed': 'true' }),
      })
    } else {
      const body = JSON.parse(String(init?.body)) as {
        project_id: number
        task_id: number
        seconds: number
      }
      const entry = { id: 100 + entries.length + 1, ...body }
      entries.push(entry)
      const text = JSON.stringify({
        data: entry,
        links: { self: `/api/v1/time-entries/${entry.id}` },
      })
      if (options.advertises && key !== null) stored.set(key, text)
      response = new Response(text, { status: 201, headers: headers() })
    }
    if (loss === 'lost') throw new TypeError('Failed to fetch')
    return response
  }
  return { fetch, entries, writes }
}

const clientFor = (fetch: typeof globalThis.fetch): EzactoClient =>
  new EzactoClient({
    baseUrl: origin,
    fetch: createRetryingFetch({
      fetch,
      support: createKeySupport(),
      sleep: async () => undefined,
    }),
  })

const entryInput = { project_id: 3, task_id: 4, spent_date: '2026-10-07', seconds: 5_400 }

describe('an instance that honours keys', () => {
  it.each([
    ['500', 1],
    ['500', 3],
    ['503', 1],
    ['503', 3],
    ['drop', 1],
    ['drop', 3],
    ['lost', 1],
    ['lost', 3],
  ] as const)(
    '[acceptance] a write whose first attempts end in %s (%i of them) lands once, and the caller gets the original answer',
    async (loss, times) => {
      const server = instance({ advertises: true, losses: Array<Loss>(times).fill(loss) })
      const client = clientFor(server.fetch)
      // A page's first read settles what the instance honours.
      await client.getWhoami()

      const created = await client.createTimeEntry({ body: entryInput })

      expect(server.entries).toHaveLength(1)
      expect(created.data).toEqual(server.entries[0])
      expect(server.writes).toHaveLength(times + 1)
      expect(new Set(server.writes).size).toBe(1)
      expect(server.writes[0]).toMatch(uuidV4)
    },
  )

  it('[acceptance] lands once through every kind of loss in a row', async () => {
    const server = instance({ advertises: true, losses: ['500', '503', 'lost'] })
    const client = clientFor(server.fetch)
    await client.getWhoami()

    const created = await client.createTimeEntry({ body: entryInput })

    expect(server.entries).toHaveLength(1)
    expect(created.data).toEqual(server.entries[0])
    expect(server.writes).toHaveLength(4)
    expect(new Set(server.writes).size).toBe(1)
  })

  it('[acceptance] keeps writes apart: a second write after a replayed one is a second entry', async () => {
    const server = instance({ advertises: true, losses: ['lost'] })
    const client = clientFor(server.fetch)
    await client.getWhoami()

    const first = await client.createTimeEntry({ body: entryInput })
    const second = await client.createTimeEntry({ body: entryInput })

    expect(server.entries).toHaveLength(2)
    expect(first.data.id).not.toBe(second.data.id)
  })

  it('[security] sends a dropped write once while it does not yet know the instance honours keys', async () => {
    // Nothing read yet, so nothing has vouched for the key being kept.
    const server = instance({ advertises: true, losses: ['lost'] })
    const client = clientFor(server.fetch)

    await expect(client.createTimeEntry({ body: entryInput })).rejects.toBeInstanceOf(
      UnconfirmedWriteError,
    )
    expect(server.entries).toHaveLength(1)
    expect(server.writes).toHaveLength(1)
  })
})

describe('an instance that does not honour keys', () => {
  it('[security] does not send a write again after its answer is lost: one effect, and the caller told so', async () => {
    const server = instance({ advertises: false, losses: ['lost'] })
    const client = clientFor(server.fetch)
    await client.getWhoami()

    const failure = await client
      .createTimeEntry({ body: entryInput })
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(UnconfirmedWriteError)
    expect(server.entries).toHaveLength(1)
    expect(server.writes).toHaveLength(1)
  })

  it('[security] does not send a write again after a 500', async () => {
    const server = instance({ advertises: false, losses: ['500'] })
    const client = clientFor(server.fetch)
    await client.getWhoami()

    const failure = await client
      .createTimeEntry({ body: entryInput })
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(EzactoApiError)
    expect(failure).toMatchObject({ status: 500 })
    expect(server.writes).toHaveLength(1)
  })

  it('[acceptance] sends a write again after a 503 that names a time: it did nothing', async () => {
    const server = instance({ advertises: false, losses: ['503'] })
    const client = clientFor(server.fetch)
    await client.getWhoami()

    const created = await client.createTimeEntry({ body: entryInput })

    expect(server.entries).toHaveLength(1)
    expect(created.data).toEqual(server.entries[0])
    expect(server.writes).toHaveLength(2)
  })
})
