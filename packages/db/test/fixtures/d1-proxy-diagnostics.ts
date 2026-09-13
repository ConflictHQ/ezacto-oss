/**
 * Names what the D1 proxy was doing when it failed (issue 645).
 *
 * `Miniflare#getD1Database` returns a proxy stub, not a database: every
 * `.prepare(...).run()` in these tests is an HTTP round trip to the workerd
 * child process. Miniflare checks the response with a message-less assertion --
 *
 *   assert(res.status === 200)
 *
 * -- so when the runtime answers with anything else, Node prints
 * `AssertionError: The expression evaluated to a falsy value:` and nothing more.
 * No stack frame names the call, no message names the status, and there is no
 * `assert(` anywhere in this package to search for. That is why the flake this
 * wraps cost two CI reruns and an afternoon before anyone could say where it
 * came from.
 *
 * This cannot stop the failure. It can stop the failure being anonymous: the
 * statement that was in flight is attached, and the original error is kept as
 * the cause so nothing is hidden.
 *
 * Deliberately narrow. Only an `AssertionError` with miniflare's message is
 * re-thrown -- a real assertion from a test, or any other error, passes through
 * untouched. A wrapper that swallowed everything would be a worse version of the
 * problem it exists to solve.
 */

const MINIFLARE_BARE_ASSERTION = 'The expression evaluated to a falsy value'

const isProxyAssertion = (error: unknown): error is Error =>
  error instanceof Error &&
  error.name === 'AssertionError' &&
  error.message.includes(MINIFLARE_BARE_ASSERTION)

const describeCall = (method: string, args: readonly unknown[]): string => {
  const first = args[0]
  const sql = typeof first === 'string' ? first.replace(/\s+/gu, ' ').trim() : null
  return sql === null
    ? method
    : `${method}(${sql.length > 120 ? `${sql.slice(0, 119)}…` : sql})`
}

const annotate = (error: Error, call: string): Error => {
  const named = new Error(
    `miniflare D1 proxy refused a call during ${call}. The runtime answered the ` +
      'proxy with a non-200 and miniflare discards which status it was (issue 645).',
    { cause: error },
  )
  named.name = 'D1ProxyError'
  return named
}

/**
 * Wraps a D1 stub so a proxy failure says which call it happened on.
 *
 * Wraps `prepare` and the statement it returns, because those are where the
 * round trips are; everything else is passed straight through.
 */
export const withD1Diagnostics = <T extends object>(database: T, inherited = ''): T =>
  new Proxy(database, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown
      if (typeof value !== 'function') return value
      const method = String(property)
      return (...args: unknown[]) => {
        // The statement text arrives at `prepare` and the failure surfaces two
        // calls later on `run`, so the description is carried down the chain.
        // Without that this names `run()` and says nothing about which query.
        const own = describeCall(method, args)
        const call = inherited === '' ? own : `${inherited} → ${method}`
        const run = (): unknown => (value as (...rest: unknown[]) => unknown).apply(target, args)
        try {
          const result = run()
          if (result instanceof Promise) {
            return result.catch((error: unknown) => {
              throw isProxyAssertion(error) ? annotate(error, call) : error
            })
          }
          // `prepare` and `bind` answer synchronously and return another stub,
          // so the wrap has to follow them or the failure lands unnamed on the
          // call after this one.
          return typeof result === 'object' && result !== null
            ? withD1Diagnostics(result as object, call)
            : result
        } catch (error) {
          throw isProxyAssertion(error) ? annotate(error, call) : error
        }
      }
    },
  })
