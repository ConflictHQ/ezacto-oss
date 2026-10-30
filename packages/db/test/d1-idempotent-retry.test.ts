import { expect, it, vi } from 'vitest'
import { retryTransientD1IdempotentOperation } from '../src/d1-idempotent-retry.js'

it('retries wrapped transient errors with a fixed bounded backoff', async () => {
  const error = new Error('Failed query', { cause: new Error('D1_ERROR: Network connection lost') })
  const operation = vi
    .fn()
    .mockRejectedValueOnce(error)
    .mockRejectedValueOnce(error)
    .mockResolvedValue('ready')
  const sleep = vi.fn(async () => {})
  expect(await retryTransientD1IdempotentOperation(operation, sleep)).toBe('ready')
  expect(sleep.mock.calls).toEqual([[50], [200]])
})
it('preserves the original exhausted error and never retries permanent or cyclic errors', async () => {
  const transient = new Error('D1_ERROR: Network connection lost')
  const operation = vi.fn().mockRejectedValue(transient)
  await expect(retryTransientD1IdempotentOperation(operation, async () => {})).rejects.toBe(
    transient,
  )
  expect(operation).toHaveBeenCalledTimes(3)
  for (const error of [
    new Error('D1_ERROR: constraint failed'),
    new Error('provider network error'),
    new Error('cycle'),
  ]) {
    error.cause = error
    const permanent = vi.fn().mockRejectedValue(error),
      sleep = vi.fn(async () => {})
    await expect(retryTransientD1IdempotentOperation(permanent, sleep)).rejects.toBe(error)
    expect(permanent).toHaveBeenCalledOnce()
    expect(sleep).not.toHaveBeenCalled()
  }
})
