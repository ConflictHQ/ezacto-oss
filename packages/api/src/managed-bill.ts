import {
  ManagedBillConnectionError,
  validateManagedBillCredentials,
  type ManagedBillAuthority,
  type ManagedBillConnectionState,
  type ManagedBillConnectionStore,
  type ManagedBillCredentials,
  type ManagedBillVault,
} from '@ezacto/core'
import { createApiApp } from './app.js'
import {
  requireSessionPrincipal,
  type ApiAuthentication,
  type ApiSessionResolver,
} from './auth.js'
import { ApiError } from './errors.js'

export type ManagedBillConnectionOptions = {
  store: ManagedBillConnectionStore
  vault: ManagedBillVault
  now?: () => string
  /** Original unexpected cause, trusted in-process only. Expected 4xx are not reported. */
  reportError?: (error: Error, requestId: string) => void | Promise<void>
} & (
  | { authentication: ApiAuthentication; guardedUserId?: never }
  /** Fresh trusted host identity bound to the current tenant; never a caller-supplied
   * header/body/boolean. The store resolves current administrator authority itself. */
  | {
      guardedUserId: (request: Request) => Promise<number | null | Response>
      authentication?: never
    }
)

export interface ManagedBillConnectCommand {
  commandId: string
  expectedGeneration: number
  credentials: ManagedBillCredentials
}
export interface ManagedBillDisconnectInput {
  commandId: string
  expectedGeneration: number
}

const message = 'The BILL connection or administrator authority changed. Restart from settings.'
const expectedFailure = (error: unknown): ApiError | null => {
  if (!(error instanceof ManagedBillConnectionError)) return null
  return new ApiError({
    status: error.kind === 'forbidden' ? 403 : error.kind === 'invalid' ? 422 : 409,
    code: `managed_bill_${error.kind}`,
    message,
    ...(error.kind === 'invalid'
      ? { fields: [{ field: 'credentials', code: 'invalid', message: 'Check the BILL details and retry.' }] }
      : {}),
  })
}

/** Private in-process commands. Lifecycle credentials are arguments of one call,
 * never a public HTTP/SDK/activity payload and never read back: results carry
 * only state. They apply native session policy and exact-origin CSRF (even
 * `status`), require a fresh active administrator, and perform no provider I/O. */
export const createManagedBillConnectionCommands = (options: ManagedBillConnectionOptions) => {
  const clock = () => options.now?.() ?? new Date().toISOString()
  const invoke = async <T extends ManagedBillConnectionState>(
    request: Request,
    work: (authority: ManagedBillAuthority, now: string) => Promise<T>,
  ) => {
    let result: (T & { actorUserId: number }) | undefined
    let original: Error | undefined
    let guardedRefusal: Response | undefined
    const fail = (error: unknown): never => {
      const expected = expectedFailure(error)
      if (expected) throw expected
      original = error instanceof Error ? error : new Error('Managed BILL command failed')
      throw new ApiError({
        status: 503,
        code: 'managed_bill_unavailable',
        message: 'The BILL connection could not be confirmed. Retry the same command.',
      })
    }
    const sessions: ApiSessionResolver = {
      resolve: async (incoming) => {
        try {
          if (!options.guardedUserId)
            return (await options.authentication?.sessions?.resolve(incoming)) ?? null
          const userId = await options.guardedUserId(incoming)
          if (userId instanceof Response) {
            if (userId.status < 400 || userId.status > 599)
              throw new Error('Managed BILL identity returned a non-failure response')
            guardedRefusal = userId
            return null
          }
          if (userId === null || !Number.isSafeInteger(userId) || userId < 1) return null
          await options.store.prepare({ kind: 'guarded-session', userId }, clock())
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
          void Promise.resolve(options.reportError?.(original ?? error, requestId)).catch(
            () => undefined,
          )
        } catch {
          // A trusted observer cannot alter the command response.
        }
      },
      installApi: (api) => {
        api.post('/_managed/bill/connection', async (context) => {
          const principal = requireSessionPrincipal(context)
          if (principal.profile !== 'administrator')
            throw new ApiError({
              status: 403,
              code: 'profile_forbidden',
              message: 'An administrator session is required.',
            })
          const sessionId = Number(principal.authentication.sessionId)
          if (!options.guardedUserId && (!Number.isSafeInteger(sessionId) || sessionId < 1))
            throw new ApiError({
              status: 403,
              code: 'profile_forbidden',
              message: 'A native administrator session is required.',
            })
          const authority: ManagedBillAuthority = options.guardedUserId
            ? { kind: 'guarded-session', userId: principal.userId }
            : { kind: 'native-session', userId: principal.userId, sessionId }
          try {
            result = { ...(await work(authority, clock())), actorUserId: principal.userId }
          } catch (error) {
            return fail(error)
          }
          return context.body(null, 204)
        })
      },
    })
    // Always unsafe so even status needs exact origin. The body is never copied.
    const response = await app.fetch(
      new Request(new URL('/api/v1/_managed/bill/connection', request.url), {
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
    status: (request: Request) =>
      invoke(request, (authority, now) => options.store.prepare(authority, now)),
    /** Connects or rotates the tenant's own credential. */
    configure: (request: Request, command: ManagedBillConnectCommand) =>
      invoke(request, async (authority, now) => {
        const { credentials } = command
        validateManagedBillCredentials(credentials)
        const generation = command.expectedGeneration + 1
        const fingerprint = await options.vault.fingerprint([
          'connect',
          command.commandId,
          authority.userId,
          command.expectedGeneration,
          credentials.companyId,
          credentials.username,
          credentials.password,
          credentials.replyToUserId,
          credentials.environment,
        ])
        return options.store.apply(
          {
            action: 'connect',
            commandId: command.commandId,
            expectedActorUserId: authority.userId,
            expectedGeneration: command.expectedGeneration,
            fingerprint,
            companyId: credentials.companyId,
            environment: credentials.environment,
            canSendFromBill: credentials.replyToUserId !== null,
            sealed: await options.vault.seal(credentials, generation),
          },
          authority,
          now,
        )
      }),
    disconnect: (request: Request, command: ManagedBillDisconnectInput) =>
      invoke(request, async (authority, now) =>
        options.store.apply(
          {
            action: 'disconnect',
            commandId: command.commandId,
            expectedActorUserId: authority.userId,
            expectedGeneration: command.expectedGeneration,
            fingerprint: await options.vault.fingerprint([
              'disconnect',
              command.commandId,
              authority.userId,
              command.expectedGeneration,
            ]),
          },
          authority,
          now,
        ),
      ),
  }
}
