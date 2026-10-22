import type { TwoFactorEmailCodeMailer } from './two-factor-challenge.js'
import type { ElevatedInvoiceTimeUnlink, ElevatedInvoiceTimeUnlinkResult } from '@ezacto/core'
import {
  canElevateInvoiceEdits,
  InvoiceElevationError,
  invoiceElevationHeader,
  invoiceElevationScope,
  type InvoiceEditElevation,
  type InvoiceElevationBinding,
  type InvoiceElevationPending,
} from '@ezacto/core'
import type { Context, Hono } from 'hono'
import { requireApiScope, type TwoFactorService } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError, readJsonBody, validationError } from './errors.js'
import { translateAuthError, type PasswordAuthService } from './password-auth.js'
import type { SignInMethodPolicy } from './sign-in-methods.js'
import { assertFields, isJsonObject, unknownFieldErrors } from './resources/support.js'
export interface InvoiceElevationActor {
  userId: number
  tokenId: number
}
export interface InvoiceElevationStore {
  createRequest(
    binding: InvoiceElevationBinding,
    challenge: string,
    expiresAt: string,
    now: string,
  ): Promise<void>
  pending(
    challenge: string,
    actor: InvoiceElevationActor,
    now: string,
  ): Promise<InvoiceElevationPending | null>
  mint(
    binding: InvoiceElevationBinding,
    now: string,
    challenge?: string,
  ): Promise<{ credential: string; elevation: InvoiceEditElevation }>
  verify(
    credential: string,
    actor: InvoiceElevationActor,
    invoiceId: number,
    now: string,
  ): Promise<InvoiceEditElevation | null>
  revoke(id: string, actor: InvoiceElevationActor, now: string): Promise<void>
}
export type ElevatedInvoiceTimeUnlinkPort = (
  command: ElevatedInvoiceTimeUnlink,
  elevation: InvoiceEditElevation,
  now: string,
) => Promise<ElevatedInvoiceTimeUnlinkResult>
export interface InvoiceElevationRouteOptions {
  unlinkTime?: ElevatedInvoiceTimeUnlinkPort
  store: InvoiceElevationStore
  passwords: PasswordAuthService
  policy: SignInMethodPolicy
  secondFactor: Pick<
    TwoFactorService,
    'isEnrolled' | 'isEmailFactorEnabled' | 'issueChallenge' | 'redeemChallenge' | 'resendEmailCode'
  >
  emailCodeMailer?: TwoFactorEmailCodeMailer
  emailCodesReady: boolean
  clock(): string
  clientKey(request: Request): string
}
const required = (): never => {
  throw new ApiError({
    status: 403,
    code: 'invoice_elevation_required',
    message:
      'Use ez sudo as an administrator to edit this draft invoice. Elevation is temporary and must belong to this API token and invoice.',
  })
}
const tokenActor = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): InvoiceElevationActor => {
  requireApiScope(context, 'invoices:write')
  const principal = context.get('principal')
  if (!canElevateInvoiceEdits(principal.profile)) return required()
  const authentication = principal.authentication
  if (authentication.kind !== 'token') return required()
  return { userId: principal.userId, tokenId: authentication.tokenId }
}
/** Browser sessions retain their existing policy; every API-token edit needs this proof. */
export const requireInvoiceTokenElevation = async <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
  invoiceId: number,
  store: InvoiceElevationStore | undefined,
  now: string,
): Promise<InvoiceEditElevation | undefined> => {
  const principal = context.get('principal')
  if (principal.authentication.kind === 'session') return undefined
  const actor = tokenActor(context)
  if (!store) required()
  const elevation = await store!.verify(
    context.req.header(invoiceElevationHeader) ?? '',
    actor,
    invoiceId,
    now,
  )
  if (!elevation) required()
  return elevation!
}
const guarded = async <T>(action: () => Promise<T>): Promise<T> => {
  try {
    return await action()
  } catch (error) {
    if (error instanceof InvoiceElevationError) {
      const status =
        error.code === 'invalid_invoice_time_selection'
          ? 422
          : error.code === 'invoice_time_conflict' || error.code === 'invoice_draft_required'
            ? 409
            : 403
      throw new ApiError({
        status,
        code: error.code,
        message: error.message,
        ...(status === 422
          ? { fields: [{ field: 'entry_ids', code: error.code, message: error.message }] }
          : {}),
      })
    }
    return translateAuthError(error)
  }
}
const body = async <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
  keys: readonly string[],
  maxBytes = 16 * 1024,
) => {
  const value = await readJsonBody<unknown>(context, { maxBytes })
  if (!isJsonObject(value))
    throw validationError([{ field: 'body', code: 'invalid', message: 'Expected an object.' }])
  assertFields(unknownFieldErrors(value, new Set(keys)))
  return value
}
export const installInvoiceElevationRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  options: InvoiceElevationRouteOptions,
): void => {
  const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }
  const issued = (value: { credential: string; elevation: InvoiceEditElevation }) => ({
    credential: value.credential,
    id: value.elevation.id,
    invoice_id: value.elevation.invoiceId,
    expires_at: value.elevation.expiresAt,
    scope: invoiceElevationScope,
  })
  api.post('/invoice-elevations', async (context) => {
    const actor = tokenActor(context)
    if (!(await options.policy.isLive('password', context.env)))
      throw new ApiError({
        status: 403,
        code: 'invoice_elevation_unavailable',
        message:
          'Password reauthentication is unavailable on this instance. Use the authenticated web workflow.',
      })
    const input = await body(context, ['invoice_id', 'email', 'password'])
    const fields = []
    if (!Number.isSafeInteger(input.invoice_id) || (input.invoice_id as number) < 1)
      fields.push({ field: 'invoice_id', code: 'invalid', message: 'Choose a draft invoice.' })
    for (const key of ['email', 'password'])
      if (typeof input[key] !== 'string' || input[key] === '')
        fields.push({
          field: key,
          code: 'required',
          message: 'Provide your own reauthentication credentials.',
        })
    assertFields(fields)
    return guarded(async () => {
      const result = await options.passwords.signIn({
        email: input.email as string,
        password: input.password as string,
        clientKey: options.clientKey(context.req.raw),
      })
      if (
        result.status !== 'authenticated' ||
        result.principal.userId !== actor.userId ||
        !canElevateInvoiceEdits(result.principal.profile)
      )
        throw new ApiError({
          status: 403,
          code: 'invalid_reauthentication',
          message: 'Reauthentication did not verify the administrator who owns this API token.',
        })
      const binding = {
          ...actor,
          invoiceId: input.invoice_id as number,
          credentialVersion: result.credentialVersion,
        },
        now = options.clock()
      const [totp, email] = await Promise.all([
        options.secondFactor.isEnrolled(actor.userId),
        options.secondFactor.isEmailFactorEnabled(actor.userId),
      ])
      if (totp || email) {
        if (!totp && (!options.emailCodesReady || !options.emailCodeMailer))
          throw new ApiError({
            status: 503,
            code: 'second_factor_unavailable',
            message: 'The second factor is temporarily unavailable.',
          })
        const challenge = await options.secondFactor.issueChallenge(actor.userId, {
          emailCodeAllowed: true,
        })
        await options.store.createRequest(binding, challenge.token, challenge.expiresAt, now)
        return context.json(
          {
            data: {
              status: 'challenge_required' as const,
              challenge_token: challenge.token,
              expires_at: challenge.expiresAt,
              methods: [
                ...(totp ? ['totp' as const] : []),
                ...(email && options.emailCodesReady && options.emailCodeMailer
                  ? ['email' as const]
                  : []),
              ],
            },
          },
          202,
          headers,
        )
      }
      return context.json(
        {
          data: { status: 'elevated' as const, ...issued(await options.store.mint(binding, now)) },
        },
        201,
        headers,
      )
    })
  })
  api.post('/invoice-elevations/email-code', async (context) => {
    const actor = tokenActor(context),
      input = await body(context, ['challenge_token'])
    if (typeof input.challenge_token !== 'string')
      throw validationError([
        {
          field: 'challenge_token',
          code: 'invalid',
          message: 'Provide the current bound challenge.',
        },
      ])
    if (!options.emailCodesReady || !options.emailCodeMailer)
      throw new ApiError({
        status: 503,
        code: 'second_factor_unavailable',
        message: 'The second factor is temporarily unavailable.',
      })
    return guarded(async () => {
      const binding = await options.store.pending(
        input.challenge_token as string,
        actor,
        options.clock(),
      )
      if (!binding) return required()
      const offer = await options.secondFactor.resendEmailCode(input.challenge_token as string)
      if (offer.status === 'rate_limited')
        throw new ApiError({
          status: 429,
          code: 'rate_limit_exceeded',
          message: 'Wait before requesting another verification email.',
        })
      if (offer.status !== 'sent' || offer.userId !== actor.userId)
        throw new ApiError({
          status: 403,
          code: 'invalid_two_factor_challenge',
          message:
            'The challenge expired or email verification is unavailable. Reauthenticate before retrying.',
        })
      const expiresAt = new Date(
        Math.min(Date.parse(offer.expiresAt), Date.parse(binding.challengeExpiresAt)),
      ).toISOString()
      await options.store.createRequest(binding, offer.token, expiresAt, options.clock())
      await options.emailCodeMailer!.enqueue({
        to: offer.emailTo,
        code: offer.emailCode,
        expiresAt,
      })
      return context.json(
        {
          data: {
            status: 'challenge_required' as const,
            challenge_token: offer.token,
            expires_at: expiresAt,
            methods: [
              ...((await options.secondFactor.isEnrolled(actor.userId)) ? ['totp' as const] : []),
              'email' as const,
            ],
          },
        },
        200,
        headers,
      )
    })
  })
  api.post('/invoice-elevations/verify', async (context) => {
    const actor = tokenActor(context),
      input = await body(context, ['challenge_token', 'code'])
    if (
      typeof input.challenge_token !== 'string' ||
      typeof input.code !== 'string' ||
      input.code.length < 1 ||
      input.code.length > 64
    )
      throw validationError([
        {
          field: 'code',
          code: 'invalid',
          message: 'Provide the current bound challenge and verification code.',
        },
      ])
    return guarded(async () => {
      const binding = await options.store.pending(
        input.challenge_token as string,
        actor,
        options.clock(),
      )
      if (!binding) required()
      const verdict = await options.secondFactor.redeemChallenge(
        input.challenge_token as string,
        input.code as string,
      )
      if (verdict.status === 'locked')
        throw new ApiError({
          status: 429,
          code: 'two_factor_locked',
          message: 'Too many incorrect verification codes. Try again later.',
        })
      if (verdict.status !== 'accepted' || verdict.userId !== actor.userId)
        throw new ApiError({
          status: 403,
          code: 'invalid_two_factor_code',
          message: 'The verification code is invalid or its challenge expired.',
        })
      const result = await options.store.mint(
        binding!,
        options.clock(),
        input.challenge_token as string,
      )
      return context.json(
        { data: { status: 'elevated' as const, ...issued(result) } },
        201,
        headers,
      )
    })
  })
  if (options.unlinkTime)
    api.post('/invoices/:id/unlink-time', async (context) => {
      tokenActor(context)
      requireApiScope(context, 'time_entries:write')
      const invoiceId = Number(context.req.param('id'))
      if (!Number.isSafeInteger(invoiceId) || invoiceId < 1)
        throw new ApiError({
          status: 404,
          code: 'invoice_not_found',
          message: 'The invoice does not exist.',
        })
      const elevation = await requireInvoiceTokenElevation(
        context,
        invoiceId,
        options.store,
        options.clock(),
      )
      if (!elevation) return required()
      const input = await body(context, ['expected_version', 'entry_ids', 'confirmed'], 64 * 1024),
        key = context.req.header('Idempotency-Key') ?? ''
      if (
        input.confirmed !== true ||
        !Number.isSafeInteger(input.expected_version) ||
        (input.expected_version as number) < 0 ||
        !Array.isArray(input.entry_ids) ||
        input.entry_ids.length < 1 ||
        input.entry_ids.length > 1000 ||
        input.entry_ids.some((id) => !Number.isSafeInteger(id) || id < 1) ||
        !/^[A-Za-z0-9._:-]{1,128}$/.test(key)
      )
        throw validationError([
          {
            field: 'entry_ids',
            code: 'invalid',
            message:
              'Confirm 1–1000 selected linked entries, the current draft version and an idempotency key.',
          },
        ])
      return guarded(async () => {
        const result = await options.unlinkTime!(
          {
            invoiceId,
            commandId: key,
            expectedVersion: input.expected_version as number,
            entryIds: input.entry_ids as number[],
          },
          elevation,
          options.clock(),
        )
        return context.json(
          {
            data: {
              invoice_id: result.invoiceId,
              command_id: result.commandId,
              elevation_id: result.elevationId,
              released_entry_ids: result.releasedEntryIds,
              recorded_at: result.recordedAt,
              replayed: result.replayed,
            },
          },
          200,
          headers,
        )
      })
    })
  api.delete('/invoice-elevations/:id', async (context) => {
    const actor = tokenActor(context)
    await options.store.revoke(context.req.param('id'), actor, options.clock())
    context.header('cache-control', 'no-store')
    return context.body(null, 204)
  })
}
