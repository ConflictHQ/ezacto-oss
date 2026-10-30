/** Only for operations whose complete effect is safe to repeat, never arbitrary jobs. */
export const retryTransientD1IdempotentOperation = async <T>(
  operation: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> => {
  const delays = [50, 200]
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation()
    } catch (error) {
      // Drizzle wraps the D1 exception. Walk a bounded, cycle-safe cause chain;
      // constraint, SQL, configuration and provider failures are never retried.
      let cause: unknown = error
      const seen = new Set<unknown>()
      let transient = false
      for (let depth = 0; depth < 8 && cause instanceof Error && !seen.has(cause); depth++) {
        seen.add(cause)
        if (cause.message.includes('D1_ERROR: Network connection lost')) transient = true
        cause = cause.cause
      }
      if (!transient || attempt >= delays.length) throw error
      await sleep(delays[attempt]!)
    }
  }
}
