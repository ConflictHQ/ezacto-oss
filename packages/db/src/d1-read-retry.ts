/**
 * Bounded retry for D1 reads that fail in transit (issue 745).
 *
 * Prod and dev have both thrown `D1_ERROR: Network connection lost` on a plain
 * SELECT (Sentry EZACTO-SERVER-P, -F, -J, -M). The connection to D1 dropped
 * before an answer came back; the same read a moment later succeeds.
 *
 * Reads only. A write that lost its answer may have been applied, so retrying
 * it could apply it twice; the caller decides what is a read and this function
 * never sees anything else. Only this one error is retried: any other failure
 * (a bad statement, a constraint, a timeout) is real and passes straight
 * through, and after the last retry the original error is thrown unchanged.
 */

/** Retries after the first attempt. */
export const D1_READ_MAX_RETRIES = 2

/** Wait before retry 1 and retry 2, in milliseconds. */
export const D1_READ_BACKOFF_MS: readonly number[] = [50, 200]

const TRANSIENT_MESSAGE = 'D1_ERROR: Network connection lost'

export const isTransientD1ReadError = (error: unknown): boolean =>
  error instanceof Error && error.message.includes(TRANSIENT_MESSAGE)

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export const retryTransientD1Read = async <T>(
  read: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = wait,
): Promise<T> => {
  for (let retry = 0; ; retry += 1) {
    try {
      return await read()
    } catch (error) {
      if (retry >= D1_READ_MAX_RETRIES || !isTransientD1ReadError(error)) throw error
      await sleep(D1_READ_BACKOFF_MS[retry] ?? 200)
    }
  }
}
