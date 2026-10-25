import {
  ManagedQuickBooksGrantError,
  type ManagedQuickBooksAuthority,
  type ManagedQuickBooksGrantCommand,
  type ManagedQuickBooksGrantProbe,
  type ManagedQuickBooksFenceCommand,
  type ManagedQuickBooksGrantStore,
  type ManagedQuickBooksLifecycleStore,
} from '@ezacto/core'
import { createApiApp } from './app.js'
import {
  requireSessionPrincipal,
  type ApiAuthentication,
  type ApiSessionResolver,
} from './auth.js'
import { ApiError } from './errors.js'

export type ManagedQuickBooksGrantOptions = {
  store: ManagedQuickBooksGrantStore
  /** Required only for `fence`; revocation custody stays in this trusted store. */
  lifecycle?: ManagedQuickBooksLifecycleStore
  now?: () => string
  /** Original unexpected cause, trusted in-process only. Expected4xx are not reported. */
  reportError?: (error: Error, requestId: string) => void | Promise<void>
} & (
  | { authentication: ApiAuthentication; guardedUserId?: never }
  /** Fresh trusted host identity, never a caller-supplied user ID/header/boolean.
   * The canonical store resolves CURRENT active-administrator authority and the
   * insert repeats its SQL fence. The host owns external session/tenant proof. */
  | {
      guardedUserId: (request: Request) => Promise<number | null | Response>
      authentication?: never
    }
)

const expectedFailure = (error: unknown): ApiError | null => {
  if (
    !(error instanceof ManagedQuickBooksGrantError) ||
    !['forbidden', 'invalid', 'conflict', 'expired'].includes(error.kind)
  )
    return null
  return new ApiError({
    status:
      error.kind === 'forbidden' ? 403 : error.kind === 'invalid' ? 422 : 409,
    code: `managed_quickbooks_${error.kind}`,
    message:
      'The QuickBooks grant or administrator authority changed. Restart the connection from settings.',
    ...(error.kind === 'invalid'
      ? {
          fields: [
            {
              field: 'grant',
              code: 'invalid',
              message: 'Restart the connection from settings.',
            },
          ],
        }
      : {}),
  })
}

/** Private in-process commands: native auth/CSRF, no token-bearing public route.
 * Payload and unexpected cause stay in this invocation's closure. Original
 * unexpected errors reach the optional trusted reporter, never console/body.
 */
export const createManagedQuickBooksGrantCommands = (
  options: ManagedQuickBooksGrantOptions,
) => {
  const clock = () => options.now?.() ?? new Date().toISOString()
  const invoke = async <T>(
    request: Request,
    work: (authority: ManagedQuickBooksAuthority, now: string) => Promise<T>,
  ) => {
    let result: (T & { actorUserId: number; setCookie?: string }) | undefined
    let original: Error | undefined
    let guardedRefusal: Response | undefined
    const fail = (error: unknown): never => {
      const expected = expectedFailure(error)
      if (expected) throw expected
      original =
        error instanceof Error
          ? error
          : new Error('Managed QuickBooks command failed')
      throw new ApiError({
        status: 503,
        code: 'managed_quickbooks_unavailable',
        message:
          'The QuickBooks connection could not be confirmed. Retry the same confirmation.',
      })
    }
    const sessions: ApiSessionResolver = {
      resolve: async (incoming) => {
        try {
          if (!options.guardedUserId)
            return (
              (await options.authentication?.sessions?.resolve(incoming)) ??
              null
            )
          const userId = await options.guardedUserId(incoming)
          if (userId instanceof Response) {
            if (userId.status < 400 || userId.status > 599)
              throw new Error(
                'Managed QuickBooks identity returned a non-failure response',
              )
            guardedRefusal = userId
            return null
          }
          if (userId === null || !Number.isSafeInteger(userId) || userId < 1)
            return null
          await options.store.prepare(
            { kind: 'guarded-session', userId },
            clock(),
          )
          return {
            type: 'user',
            userId,
            profile: 'administrator',
            managerGrants: [],
            authentication: { kind: 'session', sessionId: 'managed-host' },
          }
        } catch (error) {
          return fail(error)
        }
      },
    }
    const app = createApiApp({
      authentication: { sessions },
      reportError: (error, requestId) => {
        try {
          void Promise.resolve(
            options.reportError?.(original ?? error, requestId),
          ).catch(() => undefined)
        } catch {
          // A trusted observer cannot alter the original command response.
        }
      },
      installApi: (api) => {
        api.post('/_managed/quickbooks/grant', async (context) => {
          const principal = requireSessionPrincipal(context)
          if (principal.profile !== 'administrator')
            throw new ApiError({
              status: 403,
              code: 'profile_forbidden',
              message: 'An administrator session is required.',
            })
          const sessionId = Number(principal.authentication.sessionId)
          if (
            !options.guardedUserId &&
            (!Number.isSafeInteger(sessionId) || sessionId < 1)
          )
            throw new ApiError({
              status: 403,
              code: 'profile_forbidden',
              message: 'A native administrator session is required.',
            })
          const authority: ManagedQuickBooksAuthority = options.guardedUserId
            ? { kind: 'guarded-session', userId: principal.userId }
            : { kind: 'native-session', userId: principal.userId, sessionId }
          try {
            result = {
              ...(await work(authority, clock())),
              actorUserId: principal.userId,
            }
          } catch (error) {
            return fail(error)
          }
          return context.body(null, 204)
        })
      },
    })
    // Always unsafe: session rotation and private handoff acknowledgement require
    // exact origin, including calls named prepare/inspect. Never copy the body.
    const response = await app.fetch(
      new Request(new URL('/api/v1/_managed/quickbooks/grant', request.url), {
        method: 'POST',
        headers: request.headers,
      }),
    )
    if (guardedRefusal) return guardedRefusal
    if (response.status !== 204 || result === undefined) return response
    const setCookie = response.headers.get('set-cookie')
    return { ...result, ...(setCookie === null ? {} : { setCookie }) }
  }
  return {
    prepare: (request: Request) =>
      invoke(request, (authority, now) =>
        options.store.prepare(authority, now),
      ),
    inspect: (request: Request, probe: ManagedQuickBooksGrantProbe) =>
      invoke(request, (authority, now) =>
        options.store.inspect(probe, authority, now),
      ),
    accept: (request: Request, command: ManagedQuickBooksGrantCommand) =>
      invoke(request, (authority, now) =>
        options.store.accept(command, authority, now),
      ),
    /** Fresh administrator authority fences the connection and records revocation intent. */
    fence: (request: Request, command: ManagedQuickBooksFenceCommand) => {
      const lifecycle = options.lifecycle
      if (!lifecycle) throw new Error('Managed QuickBooks lifecycle store is not configured')
      return invoke(request, (authority, now) => lifecycle.fence(command, authority, now))
    },
  }
}
