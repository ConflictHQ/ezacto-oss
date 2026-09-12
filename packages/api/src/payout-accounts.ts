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
): void => {
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
    const externalId = body['external_id']
    if (typeof externalId !== 'string' || externalId.trim() === '') {
      throw validationError([
        {
          field: 'external_id',
          code: 'required',
          message: 'external_id must be the identifier the provider gave for this person.',
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
