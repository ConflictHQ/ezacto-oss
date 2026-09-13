import { describe, expect, it, vi } from 'vitest'
import { withD1Diagnostics } from './fixtures/d1-proxy-diagnostics.js'

/**
 * Issue 645. The flake this serves fails with
 * `AssertionError: The expression evaluated to a falsy value:` and nothing
 * else -- no status, no frame naming the call, and no `assert(` in this package
 * to search for. It cost two CI reruns before anyone could say where it came
 * from.
 *
 * This wrapper cannot stop that happening. It can stop it being anonymous.
 */

const bareAssertion = () => {
  const error = new Error(
    'The expression evaluated to a falsy value:\n\n  assert(res.status === 200)\n',
  )
  error.name = 'AssertionError'
  return error
}

describe('naming what the D1 proxy was doing', () => {
  it('[unit] says which statement was in flight', async () => {
    const database = withD1Diagnostics({
      prepare: () => ({
        bind: () => ({ run: async () => { throw bareAssertion() } }),
      }),
    })
    await expect(
      (database as never as { prepare: (s: string) => { bind: () => { run: () => Promise<void> } } })
        .prepare('SELECT 1 FROM attachments WHERE id = ?')
        .bind()
        .run(),
    ).rejects.toThrow(/prepare\(SELECT 1 FROM attachments WHERE id = \?\)/u)
  })

  it('[unit] keeps the original as the cause, so nothing is hidden', async () => {
    const original = bareAssertion()
    const database = withD1Diagnostics({ run: async () => { throw original } })
    await expect(
      (database as never as { run: () => Promise<void> }).run(),
    ).rejects.toMatchObject({ name: 'D1ProxyError', cause: original })
  })

  it('[security] passes a real test assertion straight through', async () => {
    // A wrapper that swallowed every error would be a worse version of the
    // problem it exists to solve.
    const mine = new Error('expected 2 to be 3')
    mine.name = 'AssertionError'
    const database = withD1Diagnostics({ run: async () => { throw mine } })
    await expect((database as never as { run: () => Promise<void> }).run()).rejects.toBe(mine)
  })

  it('[security] passes every other error through untouched', async () => {
    const other = new TypeError('not a function')
    const database = withD1Diagnostics({ run: async () => { throw other } })
    await expect((database as never as { run: () => Promise<void> }).run()).rejects.toBe(other)
  })

  it('[unit] leaves a call that succeeds alone', async () => {
    const run = vi.fn(async () => ({ results: [{ id: 1 }] }))
    const database = withD1Diagnostics({ run })
    expect(await (database as never as { run: () => Promise<unknown> }).run()).toEqual({
      results: [{ id: 1 }],
    })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('[unit] truncates a long statement rather than printing a page of SQL', async () => {
    const long = `SELECT ${'column_name, '.repeat(40)} FROM attachments`
    const database = withD1Diagnostics({
      prepare: () => ({ run: async () => { throw bareAssertion() } }),
    })
    await expect(
      (database as never as { prepare: (s: string) => { run: () => Promise<void> } })
        .prepare(long)
        .run(),
    ).rejects.toThrow(/…\)/u)
  })
})
