/**
 * Linking a person to their account at a payout provider (#421, #433).
 *
 * The link is explicit because the alternative is a guess. Matching a person to
 * a payout record by email address fails when they have a personal and a work
 * address, and matches the wrong record when the provider holds an address we
 * do not -- and the failure mode of a wrong match is paying the wrong person.
 * So what is stored is the identifier the provider itself gave, and it is
 * attached deliberately by somebody.
 *
 * Who may attach one: the person themselves, or an administrator. A payout
 * destination is money leaving for a named person, which makes it narrower than
 * ordinary profile data -- a project manager who can edit a team member has no
 * business changing where that person is paid.
 */

import type { Context, Hono } from 'hono'
import { requireSessionPrincipal } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError, validationError } from './errors.js'
import { readObjectBody } from './resources/support.js'
import { AUTOMATIC_PREFERENCE_NOTE, StaffPaymentError } from '@ezacto/core'

export type PayoutProvider = 'deel' | 'wise'

export interface PayoutAccount {
  id: number
  userId: number
  provider: PayoutProvider
  externalId: string
  linkedByUserId: number
  linkedAt: string
  verifiedAt: string | null
}

export type PayoutLinkResult =
  | { outcome: 'linked'; account: PayoutAccount }
  | { outcome: 'already_linked' | 'external_id_taken' | 'unknown_user' }

export interface PayoutAccountService {
  listForUser(userId: number): Promise<readonly PayoutAccount[]>
  link(input: {
    userId: number
    provider: PayoutProvider
    externalId: string
    linkedByUserId: number
  }): Promise<PayoutLinkResult>
  /** The account, so the route can check whose it is before detaching it. */
  read(id: number): Promise<PayoutAccount | null>
  detach(id: number): Promise<boolean>
}

const providers = new Set<string>(['deel', 'wise'])

/** What an administrator has made available. Injected so the routes stay storage-free. */
export interface PayoutProviderEnablement {
  list(): Promise<readonly { provider: string; enabled: boolean }[]>
  setEnabled(provider: string, enabled: boolean, userId: number, now: string): Promise<boolean>
}

/** A person's default payout provider, and the organization's (issue 1152). */
export type PayoutPreferenceSource = 'person' | 'administrator' | 'automatic'

export interface PayoutPreferenceService {
  read(userId: number): Promise<{
    userId: number
    provider: PayoutProvider | null
    version: number
    source: PayoutPreferenceSource | null
  }>
  orgDefault(): Promise<PayoutProvider>
  set(input: {
    id: string
    userId: number
    provider: PayoutProvider | null
    expectedVersion: number
    note: string
    actorId: number
    requestId: string
    now: string
  }): Promise<void>
  roster(): Promise<
    readonly {
      userId: number
      name: string
      provider: PayoutProvider | null
      version: number
      source: PayoutPreferenceSource | null
      linked: readonly PayoutProvider[]
    }[]
  >
}

export interface PayoutAccountRouteOptions {
  /** Absent means every provider is available, which is the default for an instance. */
  enablement?: PayoutProviderEnablement
  /** Absent means defaults are not offered here; linking then changes no default. */
  preferences?: PayoutPreferenceService
  clock?: () => string
}

const newPreferenceId = (): string => `pref-${crypto.randomUUID()}`

const isConflict = (error: unknown): boolean =>
  error instanceof StaffPaymentError && error.code === 'conflict'

const requirePreferences = (options: PayoutAccountRouteOptions): PayoutPreferenceService => {
  if (options.preferences === undefined) {
    throw new ApiError({ status: 503, code: 'unavailable', message: 'Payout defaults are not available here.' })
  }
  return options.preferences
}

// Deel matches a person by the email they use there (the payroll address the
// Deel sync matches on), so that is the identifier stored for Deel.
const emailShape = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u

/**
 * The person, or an administrator acting for them.
 *
 * Deliberately not `canManageTeam`: editing somebody's profile and changing
 * where their money goes are different powers, and the second is the one worth
 * keeping narrow.
 */
const requireSelfOrAdministrator = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
  userId: number,
): number => {
  const principal = requireSessionPrincipal(context)
  if (principal.userId !== userId && principal.profile !== 'administrator') {
    throw new ApiError({
      status: 403,
      code: 'profile_forbidden',
      message: 'Only the person themselves or an administrator can change a payout account.',
    })
  }
  return principal.userId
}

const pathId = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
  name: string,
): number => {
  const parsed = Number(context.req.param(name) ?? '')
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw validationError([
      { field: name, code: 'invalid', message: `${name} must be a positive integer.` },
    ])
  }
  return parsed
}

const serialize = (account: PayoutAccount) => ({
  id: account.id,
  user_id: account.userId,
  provider: account.provider,
  external_id: account.externalId,
  linked_by_user_id: account.linkedByUserId,
  linked_at: account.linkedAt,
  verified_at: account.verifiedAt,
})

export const installPayoutAccountRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  service: Readonly<PayoutAccountService>,
  options: PayoutAccountRouteOptions = {},
): void => {
  api.get('/payout-providers', async (context) => {
    requireSessionPrincipal(context)
    const settings =
      options.enablement === undefined
        ? [...providers].map((provider) => ({ provider, enabled: true }))
        : await options.enablement.list()
    return context.json(
      { data: settings.filter((row) => providers.has(row.provider)) },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  api.patch('/payout-providers/:provider', async (context) => {
    const principal = requireSessionPrincipal(context)
    if (principal.profile !== 'administrator') {
      throw new ApiError({
        status: 403,
        code: 'profile_forbidden',
        message: 'Only administrators can change which payout providers are enabled.',
      })
    }
    const provider = context.req.param('provider') ?? ''
    if (!providers.has(provider)) {
      throw new ApiError({ status: 404, code: 'not_found', message: 'That payout provider does not exist.' })
    }
    const body = await readObjectBody(context)
    if (typeof body['enabled'] !== 'boolean') {
      throw validationError([{ field: 'enabled', code: 'invalid', message: 'enabled must be true or false.' }])
    }
    if (options.enablement === undefined) {
      throw new ApiError({ status: 503, code: 'unavailable', message: 'Payout provider settings are not available here.' })
    }
    const now = (options.clock ?? (() => new Date().toISOString()))()
    const found = await options.enablement.setEnabled(provider, body['enabled'], principal.userId, now)
    if (!found) {
      throw new ApiError({ status: 404, code: 'not_found', message: 'That payout provider does not exist.' })
    }
    return context.body(null, 204, { 'cache-control': 'no-store' })
  })

  api.get('/users/:id/payout-preference', async (context) => {
    const userId = pathId(context, 'id')
    requireSelfOrAdministrator(context, userId)
    const preferences = requirePreferences(options)
    const [current, organizationDefault, accounts] = await Promise.all([
      preferences.read(userId),
      preferences.orgDefault(),
      service.listForUser(userId),
    ])
    return context.json(
      {
        data: {
          user_id: userId,
          provider: current.provider,
          effective_provider: current.provider ?? organizationDefault,
          organization_default: organizationDefault,
          version: current.version,
          set_by: current.source,
          linked_providers: accounts.map((account) => account.provider),
        },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  // A person chooses their own default; an administrator may choose it for them.
  // Only a provider the person holds and the instance has enabled can be chosen,
  // and `null` returns them to the organization default.
  api.patch('/users/:id/payout-preference', async (context) => {
    const userId = pathId(context, 'id')
    const actorUserId = requireSelfOrAdministrator(context, userId)
    const body = await readObjectBody(context)
    const provider = body['provider']
    if (provider !== null && (typeof provider !== 'string' || !providers.has(provider))) {
      throw validationError([
        { field: 'provider', code: 'invalid', message: 'provider must be deel, wise, or null for the organization default.' },
      ])
    }
    const expectedVersion = body['expected_version']
    if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      throw validationError([{ field: 'expected_version', code: 'invalid', message: 'expected_version must be a whole number.' }])
    }
    const preferences = requirePreferences(options)
    if (provider !== null) {
      const accounts = await service.listForUser(userId)
      if (!accounts.some((account) => account.provider === provider)) {
        throw validationError([
          { field: 'provider', code: 'not_linked', message: `Link an account at ${provider} before choosing it as the default.` },
        ])
      }
      if (options.enablement !== undefined) {
        const setting = (await options.enablement.list()).find((row) => row.provider === provider)
        if (setting?.enabled !== true) {
          throw validationError([{ field: 'provider', code: 'disabled', message: `${provider} is not enabled for payouts on this instance.` }])
        }
      }
    }
    const isSelf = requireSessionPrincipal(context).userId === userId
    try {
      await preferences.set({
        id: newPreferenceId(),
        userId,
        provider: provider as PayoutProvider | null,
        expectedVersion,
        note: isSelf ? 'Chosen by the person.' : 'Set by an administrator.',
        actorId: actorUserId,
        requestId: context.get('requestId'),
        now: (options.clock ?? (() => new Date().toISOString()))(),
      })
    } catch (error) {
      if (isConflict(error)) {
        throw new ApiError({ status: 409, code: 'conflict', message: 'This default changed. Reload and try again.' })
      }
      throw error
    }
    return context.body(null, 204, { 'cache-control': 'no-store' })
  })

  // Every person and their default, for the team page. Administrators only.
  api.get('/payout-preferences', async (context) => {
    const principal = requireSessionPrincipal(context)
    if (principal.profile !== 'administrator') {
      throw new ApiError({ status: 403, code: 'profile_forbidden', message: 'Only administrators can see every default.' })
    }
    const preferences = requirePreferences(options)
    const [roster, organizationDefault] = await Promise.all([preferences.roster(), preferences.orgDefault()])
    return context.json(
      {
        data: {
          organization_default: organizationDefault,
          people: roster.map((row) => ({
            user_id: row.userId,
            name: row.name,
            provider: row.provider,
            version: row.version,
            set_by: row.source,
            linked_providers: [...row.linked],
          })),
        },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  api.get('/users/:id/payout-accounts', async (context) => {
    const userId = pathId(context, 'id')
    requireSelfOrAdministrator(context, userId)
    return context.json(
      { data: (await service.listForUser(userId)).map(serialize) },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  api.post('/users/:id/payout-accounts', async (context) => {
    const userId = pathId(context, 'id')
    const actorUserId = requireSelfOrAdministrator(context, userId)
    const body = await readObjectBody(context)

    const provider = body['provider']
    if (typeof provider !== 'string' || !providers.has(provider)) {
      throw validationError([
        {
          field: 'provider',
          code: 'invalid',
          message: 'provider must be one of: deel, wise.',
        },
      ])
    }
    if (options.enablement !== undefined) {
      const setting = (await options.enablement.list()).find((row) => row.provider === provider)
      if (setting?.enabled !== true) {
        throw validationError([
          {
            field: 'provider',
            code: 'disabled',
            message: `${provider} is not enabled for payouts on this instance.`,
          },
        ])
      }
    }
    const rawExternalId = body['external_id']
    if (typeof rawExternalId !== 'string' || rawExternalId.trim() === '') {
      throw validationError([
        {
          field: 'external_id',
          code: 'required',
          message: 'external_id must be the identifier the provider gave for this person.',
        },
      ])
    }
    const externalId =
      provider === 'deel' ? rawExternalId.trim().toLowerCase() : rawExternalId.trim()
    if (provider === 'deel' && !emailShape.test(externalId)) {
      throw validationError([
        {
          field: 'external_id',
          code: 'invalid',
          message: 'Enter the email address this person uses in Deel.',
        },
      ])
    }

    const result = await service.link({
      userId,
      provider: provider as PayoutProvider,
      externalId,
      linkedByUserId: actorUserId,
    })
    if (result.outcome === 'unknown_user') {
      throw new ApiError({ status: 404, code: 'not_found', message: 'That person does not exist.' })
    }
    // Told apart because they send an operator to different places: one person
    // already has an account here, or somebody else already holds that id.
    if (result.outcome === 'already_linked') {
      throw new ApiError({
        status: 409,
        code: 'already_linked',
        message: `This person already has a ${provider} account linked. Detach it first.`,
      })
    }
    if (result.outcome !== 'linked') {
      throw new ApiError({
        status: 409,
        code: 'external_id_taken',
        message: `Another person is already linked to that ${provider} identifier.`,
      })
    }
    // A first account sets the default, so nobody has to choose a provider they
    // already have. A default someone chose already is left alone.
    if (options.preferences !== undefined) {
      const current = await options.preferences.read(userId)
      if (current.version === 0) {
        try {
          await options.preferences.set({
            id: newPreferenceId(),
            userId,
            provider: provider as PayoutProvider,
            expectedVersion: 0,
            note: AUTOMATIC_PREFERENCE_NOTE,
            actorId: actorUserId,
            requestId: context.get('requestId'),
            now: (options.clock ?? (() => new Date().toISOString()))(),
          })
        } catch (error) {
          if (!isConflict(error)) throw error
        }
      }
    }
    return context.json({ data: serialize(result.account) }, 201, {
      'cache-control': 'no-store',
    })
  })

  // Detaching is final; re-attaching is a new link. The schema enforces that,
  // and this route is where somebody decides to do it.
  api.delete('/payout-accounts/:id', async (context) => {
    const id = pathId(context, 'id')
    const account = await service.read(id)
    if (account === null) {
      throw new ApiError({
        status: 404,
        code: 'not_found',
        message: 'That payout account does not exist.',
      })
    }
    // Checked against the account's owner rather than a path parameter, so a
    // person cannot detach somebody else's by guessing an id.
    requireSelfOrAdministrator(context, account.userId)
    if (!(await service.detach(id))) {
      throw new ApiError({
        status: 404,
        code: 'not_found',
        message: 'That payout account is already detached.',
      })
    }
    return context.body(null, 204, { 'cache-control': 'no-store' })
  })
}
