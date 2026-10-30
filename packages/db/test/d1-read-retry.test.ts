import { describe, expect, it } from 'vitest'
import { D1_READ_MAX_RETRIES, retryTransientD1Read } from '../src/d1-read-retry.js'
import { createIdempotentD1 } from '../src/idempotency.js'

/**
 * Issue 745. D1 sometimes drops the connection on a read with
 * `D1_ERROR: Network connection lost`. Reads are retried a bounded number of
 * times; a write never is, because it may already have been applied.
 */

const lost = () => new Error('D1_ERROR: Network connection lost')

/** A D1 binding whose every executing call consumes the next scripted outcome. */
const fakeBinding = (outcomes: Array<'ok' | Error>) => {
  const calls: string[] = []
  const next = (sql: string, method: string) => {
    calls.push(`${method}:${sql}`)
    const outcome = outcomes.shift() ?? 'ok'
    if (outcome !== 'ok') return Promise.reject(outcome)
    return Promise.resolve({ results: [{ n: 1 }], success: true, meta: {} })
  }
  const statement = (sql: string) => {
    const self = {
      bind: () => self,
      all: () => next(sql, 'all'),
      run: () => next(sql, 'run'),
      first: () => next(sql, 'first').then(() => ({ n: 1 })),
      raw: () => next(sql, 'raw').then(() => [[1]]),
    }
    return self
  }
  const binding = {
    prepare: statement,
    batch: (statements: unknown[]) => {
      calls.push(`batch:${statements.length}`)
      const outcome = outcomes.shift() ?? 'ok'
      return outcome === 'ok' ? Promise.resolve([]) : Promise.reject(outcome)
    },
  }
  return { binding: binding as unknown as D1Database, calls }
}

describe('D1 read retry', () => {
  it('[unit] retries a transient failure on a read and returns the result', async () => {
    const { binding, calls } = fakeBinding([lost(), 'ok'])
    const db = createIdempotentD1(binding)
    const result = await db.prepare('SELECT 1 AS n').bind().all()
    expect(result.results).toEqual([{ n: 1 }])
    expect(calls).toEqual(['all:SELECT 1 AS n', 'all:SELECT 1 AS n'])
  })

  it('[unit] retries first() and raw() reads too', async () => {
    const { binding, calls } = fakeBinding([lost(), 'ok', lost(), lost(), 'ok'])
    const db = createIdempotentD1(binding)
    await expect(db.prepare('SELECT 1').first()).resolves.toEqual({ n: 1 })
    await expect(db.prepare('SELECT 1').raw()).resolves.toEqual([[1]])
    expect(calls).toHaveLength(5)
  })

  it('[unit] gives up after two retries and throws the original error', async () => {
    const { binding, calls } = fakeBinding([lost(), lost(), lost(), 'ok'])
    const db = createIdempotentD1(binding)
    await expect(db.prepare('SELECT 1').all()).rejects.toThrow('Network connection lost')
    expect(calls).toHaveLength(1 + D1_READ_MAX_RETRIES)
  })

  it('[unit] does not retry a non-transient error', async () => {
    const { binding, calls } = fakeBinding([new Error('D1_ERROR: no such table: nope')])
    const db = createIdempotentD1(binding)
    await expect(db.prepare('SELECT * FROM nope').all()).rejects.toThrow('no such table')
    expect(calls).toHaveLength(1)
  })

  it('[unit] never retries a write, even on the transient error', async () => {
    const { binding, calls } = fakeBinding([lost(), 'ok'])
    const db = createIdempotentD1(binding)
    await expect(db.prepare('INSERT INTO t (id) VALUES (?)').bind(1).run()).rejects.toThrow(
      'Network connection lost',
    )
    expect(calls).toEqual(['run:INSERT INTO t (id) VALUES (?)'])
  })

  it('[unit] never retries a write that returns rows', async () => {
    const { binding, calls } = fakeBinding([lost(), 'ok'])
    const db = createIdempotentD1(binding)
    await expect(
      db.prepare('UPDATE t SET n = 1 RETURNING n').all(),
    ).rejects.toThrow('Network connection lost')
    expect(calls).toHaveLength(1)
  })

  it('[unit] never retries a batch', async () => {
    const { binding, calls } = fakeBinding([lost(), 'ok'])
    const db = createIdempotentD1(binding)
    await expect(
      db.batch([db.prepare('SELECT 1'), db.prepare('SELECT 2')]),
    ).rejects.toThrow('Network connection lost')
    expect(calls).toEqual(['batch:2'])
  })

  it('[unit] waits a short, growing backoff between attempts', async () => {
    const waits: number[] = []
    let attempts = 0
    const result = await retryTransientD1Read(
      async () => {
        attempts += 1
        if (attempts < 3) throw lost()
        return 'done'
      },
      async (ms) => {
        waits.push(ms)
      },
    )
    expect(result).toBe('done')
    expect(waits).toEqual([50, 200])
  })
})
