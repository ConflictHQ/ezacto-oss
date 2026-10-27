/** A database claim insertion lost to a separately verified durable owner. */
export class IdempotencyClaimConflict extends Error {
  constructor() {
    super('Another request owns this idempotency claim.')
    this.name = 'IdempotencyClaimConflict'
  }
}

/** Drizzle may wrap a driver failure; only an actual typed signal is expected. */
export const isIdempotencyClaimConflict = (error: unknown): boolean => {
  const seen = new Set<unknown>()
  let current = error
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof IdempotencyClaimConflict) return true
    seen.add(current)
    current = current.cause
  }
  return false
}
