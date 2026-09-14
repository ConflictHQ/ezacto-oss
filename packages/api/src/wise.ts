/**
 * Wise, as an operator meets it (issue 543).
 *
 * The app-token shape. An earlier pass mounted an OAuth connect button for each
 * contractor to authorise their own account; that is gone, because the token
 * authenticates as the business that actually sends the money and a contractor
 * supplies a destination rather than a grant.
 *
 * So the authorization rule inverts from the one that flow needed. Choosing
 * which Wise recipient a person is paid through is a decision about the
 * organisation's money, made with the organisation's token, against a list only
 * the organisation can see. That sits with administrators and accounting, the
 * same people who raise invoices -- not with everyone who can edit their own
 * time.
 */

import type { Hono } from 'hono'
import { requireSessionPrincipal } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError, validationError } from './errors.js'
import { readObjectBody } from './resources/support.js'

export interface WiseConnectionStatus {
  profileId: string
  profileName: string | null
  payableRecipients: number
  webhooksVerifiable: boolean
}

/**
 * A destination the organisation can pay.
 *
 * No account number, and that is the point rather than an omission. Wise hands
 * one over in a field called `accountSummary`; the client does not carry it, so
 * it cannot reach this screen.
 */
export interface WiseRecipientView {
  id: string
  holderName: string | null
  currency: string
  type: string
  /** Masked -- the "ending in 1234" form. */
  maskedSummary: string | null
  email: string | null
}

export type WiseLinkRefusal =
  | 'unknown_recipient'
  | 'recipient_is_ours'
  | 'recipient_inactive'
  | 'already_linked'
  | 'recipient_taken'
  | 'unknown_user'

export type WiseLinkOutcome =
  | { outcome: 'linked'; recipient: WiseRecipientView }
  | { outcome: WiseLinkRefusal }

/**
 * Where a person is paid, as a screen shows it.
 *
 * No identifier on purpose. A contact id and a recipient id are both opaque,
 * and neither tells a person anything they could check. What is worth seeing is
 * that a destination exists, whether Wise confirmed it, and when.
 */
export interface WiseDestinationView {
  id: number
  kind: 'account' | 'contact'
  linkedAt: string
  linkedByUserId: number
  verifiedAt: string | null
}

/**
 * A pairing somebody should look at, never one this applies.
 *
 * Matching a person to a payout account by address is a guess, and the failure
 * mode of a wrong guess is paying the wrong person (#421). So this route reads
 * and suggests; storing it is the link call, made by a human who said yes,
 * which is what leaves a name on the decision.
 */
export interface WiseProposalView {
  userId: number
  name: string
  payrollEmail: string | null
  matches: readonly WiseRecipientView[]
}

export interface WiseContactView {
  id: string
  name: string | null
}

/**
 * Somebody telling us where to pay them.
 *
 * `not_discoverable` is the ordinary refusal -- a mistyped Wisetag, or a Wise
 * profile whose owner has discoverability switched off. Both are theirs to fix,
 * and neither is this deployment failing at something.
 */
export type WiseShareOutcome =
  | { outcome: 'linked'; contact: WiseContactView }
  | { outcome: 'not_discoverable' }
  | { outcome: WiseLinkRefusal }
  | { outcome: 'not_configured' }

export type WiseOnboardOutcome =
  | { outcome: 'linked'; recipient: WiseRecipientView }
  | { outcome: 'created_not_linked'; recipient: WiseRecipientView; refusal: WiseLinkRefusal }
  | { outcome: 'already_linked' }
  | { outcome: 'not_configured' }

export interface WiseService {
  configured(): boolean
  readStatus(): Promise<WiseConnectionStatus | null>
  listRecipients(): Promise<readonly WiseRecipientView[]>
  linkRecipient(input: {
    userId: number
    recipientId: string
    linkedByUserId: number
  }): Promise<WiseLinkOutcome>
  onboardRecipient(input: {
    userId: number
    email: string
    legalName: string
    currency: string
    linkedByUserId: number
  }): Promise<WiseOnboardOutcome>
  shareWiseProfile(input: {
    userId: number
    identifier: string
    currency: string
    linkedByUserId: number
  }): Promise<WiseShareOutcome>
  proposeDestinations(): Promise<readonly WiseProposalView[]>
  readDestination(userId: number): Promise<WiseDestinationView | null>
  detachFor(userId: number): Promise<boolean>
  unlink(accountId: number): Promise<boolean>
}

const assertMoneyWriter = <Bindings extends object>(
  context: Parameters<typeof requireSessionPrincipal<Bindings>>[0],
): { userId: number } => {
  const principal = requireSessionPrincipal(context)
  // Where a contractor gets paid is the organisation's money leaving the
  // organisation's account. It sits with the people who raise invoices.
  if (!['administrator', 'accounting', 'executive_manager'].includes(principal.profile)) {
    throw new ApiError({
      status: 403,
      code: 'profile_forbidden',
      message: 'Only administrators and accounting can manage Wise payout destinations.',
    })
  }
  return { userId: principal.userId }
}

/**
 * Setting where *you* are paid, which is a different decision from setting
 * where somebody else is.
 *
 * Choosing another person's destination is the organisation's money going
 * somewhere the organisation chose, so it stays with the people who raise
 * invoices. Choosing your own is telling us your own Wisetag, and the whole
 * point of asking for one is that the person who has it can supply it. Who did
 * it is recorded either way -- a destination with no author is one nobody can
 * be asked about.
 */
const assertMayDestineFor = <Bindings extends object>(
  context: Parameters<typeof requireSessionPrincipal<Bindings>>[0],
  userId: number,
): { userId: number } => {
  const principal = requireSessionPrincipal(context)
  if (principal.userId === userId) return { userId: principal.userId }
  return assertMoneyWriter(context)
}

const requireConfigured = (service: Readonly<WiseService>): void => {
  if (!service.configured()) {
    throw new ApiError({
      status: 503,
      code: 'service_unavailable',
      message: 'Wise is not configured for this deployment. An API token is required.',
    })
  }
}

const serializeRecipient = (recipient: WiseRecipientView) => ({
  id: recipient.id,
  holder_name: recipient.holderName,
  currency: recipient.currency,
  type: recipient.type,
  masked_summary: recipient.maskedSummary,
  email: recipient.email,
})

/**
 * Each refusal is a different thing to go and do, which is the only reason to
 * tell them apart. A recipient that is ours, one that is deactivated, and one
 * that does not exist all look identical from a screen that only sees "no".
 */
const LINK_REFUSALS: Record<
  WiseLinkRefusal,
  { status: 404 | 409; message: string } | { field: string; message: string }
> = {
  unknown_recipient: { status: 404, message: 'No Wise recipient with that id.' },
  // These two are a 422 naming `recipient_id`, because that is what is wrong
  // with the request and this codebase reserves 422 for errors somebody can act
  // on field by field. A refusal nobody can locate is just a refusal.
  recipient_is_ours: {
    field: 'recipient_id',
    message: 'That is one of the organisation’s own accounts, not somebody it can pay.',
  },
  recipient_inactive: {
    field: 'recipient_id',
    message: 'That Wise recipient is deactivated and cannot receive a payout.',
  },
  already_linked: { status: 409, message: 'That person already has a Wise payout destination.' },
  recipient_taken: {
    status: 409,
    message: 'That Wise recipient is already somebody else’s payout destination.',
  },
  unknown_user: { status: 404, message: 'The requested resource does not exist.' },
}

export const installWiseRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  service: Readonly<WiseService>,
): void => {
  api.get('/integrations/wise', async (context) => {
    assertMoneyWriter(context)
    const status = service.configured() ? await service.readStatus() : null
    return context.json(
      {
        data: {
          configured: service.configured(),
          connection:
            status === null
              ? null
              : {
                  profile_id: status.profileId,
                  profile_name: status.profileName,
                  payable_recipients: status.payableRecipients,
                  // Whether a delivery can be believed. False is a connection
                  // that can send money and cannot be told what became of it.
                  webhooks_verifiable: status.webhooksVerifiable,
                },
        },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  api.get('/integrations/wise/recipients', async (context) => {
    assertMoneyWriter(context)
    requireConfigured(service)
    const recipients = await service.listRecipients()
    return context.json(
      { data: recipients.map(serializeRecipient) },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  /**
   * Who has nowhere to be paid, and who at Wise they might be.
   *
   * The assist for the contractor who never gets round to sharing a Wisetag.
   * Everyone without a destination is listed whether or not anything matched:
   * the people nothing matches are the ones somebody has to chase, and leaving
   * them out hides the work rather than finishing it.
   *
   * Nothing here is stored. Confirming a proposal is the link call below.
   */
  api.get('/integrations/wise/proposals', async (context) => {
    assertMoneyWriter(context)
    requireConfigured(service)
    const proposals = await service.proposeDestinations()
    return context.json(
      {
        data: proposals.map((proposal) => ({
          user_id: proposal.userId,
          name: proposal.name,
          // The address the guess was made on, shown so whoever confirms can
          // see what it was made on rather than trusting that it was made.
          payroll_email: proposal.payrollEmail,
          matches: proposal.matches.map(serializeRecipient),
        })),
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  /**
   * Points a person at the destination they told us to pay.
   *
   * The recipient is read back from Wise before the link is made, so what gets
   * stored is an identifier the provider confirmed rather than a string somebody
   * typed. That read is the whole difference between a payout destination and a
   * claim, and it is what #421 is about.
   */
  api.post('/integrations/wise/recipients/link', async (context) => {
    const { userId: linkedByUserId } = assertMoneyWriter(context)
    requireConfigured(service)
    const body = await readObjectBody(context)
    const userId = Number(body['user_id'])
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      throw validationError([
        { field: 'user_id', code: 'invalid', message: 'user_id must be a positive integer.' },
      ])
    }
    const recipientId = body['recipient_id']
    if (typeof recipientId !== 'string' || recipientId.trim() === '') {
      throw validationError([
        { field: 'recipient_id', code: 'invalid', message: 'recipient_id is required.' },
      ])
    }
    const result = await service.linkRecipient({ userId, recipientId, linkedByUserId })
    if (result.outcome !== 'linked') {
      const refusal = LINK_REFUSALS[result.outcome]
      if ('field' in refusal) {
        throw validationError([
          { field: refusal.field, code: result.outcome, message: refusal.message },
        ])
      }
      throw new ApiError({
        status: refusal.status,
        code: result.outcome,
        message: refusal.message,
      })
    }
    return context.json(
      { data: { user_id: userId, recipient: serializeRecipient(result.recipient) } },
      201,
      { 'cache-control': 'no-store' },
    )
  })

  /**
   * Onboards somebody the organisation has never paid.
   *
   * All we ask for is the email address on their Wise account. Wise collects
   * the bank details from them directly, which is the point rather than a
   * convenience: no account number ever exists here to be logged, backed up or
   * leaked, and the request body has nowhere to put one.
   */
  api.post('/integrations/wise/recipients', async (context) => {
    const { userId: linkedByUserId } = assertMoneyWriter(context)
    requireConfigured(service)
    const body = await readObjectBody(context)
    const userId = Number(body['user_id'])
    const email = typeof body['email'] === 'string' ? body['email'].trim() : ''
    const legalName = typeof body['legal_name'] === 'string' ? body['legal_name'].trim() : ''
    const currency = typeof body['currency'] === 'string' ? body['currency'].trim() : ''
    const problems: { field: string; code: string; message: string }[] = []
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      problems.push({ field: 'user_id', code: 'invalid', message: 'user_id must be a positive integer.' })
    }
    if (email === '' || !email.includes('@')) {
      problems.push({
        field: 'email',
        code: 'invalid',
        // Named for what it has to be: the address Wise knows them by, not
        // whatever address we happen to hold for them.
        message: 'email must be the address on the contractor’s Wise account.',
      })
    }
    if (legalName === '') {
      problems.push({
        field: 'legal_name',
        code: 'invalid',
        message: 'legal_name is required, and must match the name on their Wise account.',
      })
    }
    if (!/^[A-Za-z]{3}$/u.test(currency)) {
      problems.push({
        field: 'currency',
        code: 'invalid',
        message: 'currency must be a three-letter code.',
      })
    }
    if (problems.length > 0) throw validationError(problems)

    const result = await service.onboardRecipient({
      userId,
      email,
      legalName,
      currency,
      linkedByUserId,
    })
    if (result.outcome === 'not_configured') {
      throw new ApiError({
        status: 503,
        code: 'service_unavailable',
        message: 'Wise is not configured for this deployment. An API token is required.',
      })
    }
    if (result.outcome === 'already_linked') {
      throw new ApiError({
        status: 409,
        code: 'already_linked',
        message: 'That person already has a Wise payout destination.',
      })
    }
    if (result.outcome === 'created_not_linked') {
      // The recipient exists at Wise by now and cannot be removed from here.
      // Saying so, with its id, is the difference between a problem an operator
      // can finish and a destination nobody knows about.
      throw new ApiError({
        status: 409,
        code: 'created_not_linked',
        message: `Wise created recipient ${result.recipient.id}, but it could not be linked (${result.refusal}). Link it from the recipient list.`,
      })
    }
    return context.json(
      { data: { user_id: userId, recipient: serializeRecipient(result.recipient) } },
      201,
      { 'cache-control': 'no-store' },
    )
  })

  /**
   * A person telling us where to pay them, in the one detail they have to share.
   *
   * A Wisetag, or the email or phone on their Wise account. Wise resolves it to
   * a profile and we store that contact id; no bank details pass through here,
   * nothing has to be collected afterwards, and the destination still resolves
   * after they change bank -- which a stored account number would not.
   */
  api.post('/integrations/wise/contacts', async (context) => {
    const body = await readObjectBody(context)
    const userId = Number(body['user_id'])
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      throw validationError([
        { field: 'user_id', code: 'invalid', message: 'user_id must be a positive integer.' },
      ])
    }
    const { userId: linkedByUserId } = assertMayDestineFor(context, userId)
    requireConfigured(service)
    const identifier = typeof body['identifier'] === 'string' ? body['identifier'].trim() : ''
    const currency = typeof body['currency'] === 'string' ? body['currency'].trim() : ''
    const problems: { field: string; code: string; message: string }[] = []
    if (identifier === '') {
      problems.push({
        field: 'identifier',
        code: 'invalid',
        message: 'identifier is required: a Wisetag, or the email or phone on their Wise account.',
      })
    }
    if (!/^[A-Za-z]{3}$/u.test(currency)) {
      problems.push({
        field: 'currency',
        code: 'invalid',
        message: 'currency must be a three-letter code.',
      })
    }
    if (problems.length > 0) throw validationError(problems)

    const result = await service.shareWiseProfile({
      userId,
      identifier,
      currency,
      linkedByUserId,
    })
    if (result.outcome === 'not_configured') {
      throw new ApiError({
        status: 503,
        code: 'service_unavailable',
        message: 'Wise is not configured for this deployment. An API token is required.',
      })
    }
    if (result.outcome === 'not_discoverable') {
      // 422 on the field they typed: this is nearly always a typo, or a Wise
      // profile whose owner has discoverability switched off, and both are
      // fixed where the value was entered rather than anywhere near here.
      throw validationError([
        {
          field: 'identifier',
          code: 'not_discoverable',
          message: 'Wise has no discoverable profile with that identifier.',
        },
      ])
    }
    if (result.outcome !== 'linked') {
      const refusal = LINK_REFUSALS[result.outcome]
      if ('field' in refusal) {
        throw validationError([
          { field: 'identifier', code: result.outcome, message: refusal.message },
        ])
      }
      throw new ApiError({
        status: refusal.status,
        code: result.outcome,
        message: refusal.message,
      })
    }
    return context.json(
      {
        data: {
          user_id: userId,
          // Wise's own answer for who that identifier belongs to. Shown back
          // because a mistyped tag that resolves resolves to somebody else.
          contact: { id: result.contact.id, name: result.contact.name },
        },
      },
      201,
      { 'cache-control': 'no-store' },
    )
  })

  /**
   * Where one person is paid, for the person themselves or for accounting.
   *
   * Answers with `null` rather than 404 where there is none: "nobody has told
   * us where to pay you" is the state a screen has to render, and it is not an
   * error about a missing resource.
   */
  api.get('/integrations/wise/destinations/:userId', async (context) => {
    const userId = Number(context.req.param('userId') ?? '')
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      throw validationError([
        { field: 'userId', code: 'invalid', message: 'userId must be a positive integer.' },
      ])
    }
    assertMayDestineFor(context, userId)
    const destination = service.configured() ? await service.readDestination(userId) : null
    return context.json(
      {
        data: {
          configured: service.configured(),
          destination:
            destination === null
              ? null
              : {
                  id: destination.id,
                  kind: destination.kind,
                  linked_at: destination.linkedAt,
                  linked_by_user_id: destination.linkedByUserId,
                  // Null means Wise never confirmed the identifier resolves,
                  // and paying against that is the failure the store exists to
                  // prevent. Worth showing rather than implying.
                  verified_at: destination.verifiedAt,
                },
        },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  /**
   * Removes a person's destination, addressed by the person.
   *
   * So "may you remove this" has the same answer as "may you set it", and
   * somebody who has just entered a tag that resolved to the wrong person can
   * undo it without finding accounting first.
   */
  api.delete('/integrations/wise/destinations/:userId', async (context) => {
    const userId = Number(context.req.param('userId') ?? '')
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      throw validationError([
        { field: 'userId', code: 'invalid', message: 'userId must be a positive integer.' },
      ])
    }
    assertMayDestineFor(context, userId)
    if (!(await service.detachFor(userId))) {
      throw new ApiError({
        status: 404,
        code: 'not_found',
        message: 'That person has no Wise payout destination.',
      })
    }
    return context.body(null, 204)
  })

  api.delete('/integrations/wise/recipients/:accountId', async (context) => {
    assertMoneyWriter(context)
    const accountId = Number(context.req.param('accountId') ?? '')
    if (!Number.isSafeInteger(accountId) || accountId <= 0) {
      throw validationError([
        { field: 'accountId', code: 'invalid', message: 'accountId must be a positive integer.' },
      ])
    }
    if (!(await service.unlink(accountId))) {
      throw new ApiError({
        status: 404,
        code: 'not_found',
        message: 'The requested resource does not exist.',
      })
    }
    return context.body(null, 204)
  })
}

/**
 * What Wise pushes at us, at `/webhooks/wise`.
 *
 * Outside the authenticated surface, like Stripe's and for the same reason:
 * Wise has no session with us, so the signature is the whole of the
 * authorisation. It is checked before the body is treated as anything but
 * text, because the signature covers the raw bytes and a parse-then-verify
 * would be verifying something Wise never signed.
 *
 * 200 once the signature holds, even where the event is one we do not act on.
 * Wise retries a non-2xx, and retrying a delivery we have correctly decided to
 * ignore is work that can never succeed. A bad signature is a 401 -- the one
 * case where a retry is not wanted either, and the honest answer to a request
 * nobody proved Wise sent.
 */
export interface WiseWebhookService {
  receiveWebhook(input: {
    payload: string
    signature: string | null
    /** Wise's own id for the delivery; how a retry is recognised. */
    deliveryId: string | null
    /** Wise's ping when a subscription is created. Verified, then not acted on. */
    isTest: boolean
  }): Promise<{ accepted: boolean }>
}

export const installWiseWebhookRoute = <Bindings extends object>(
  app: Hono<ApiContext<Bindings>>,
  service: Readonly<WiseWebhookService>,
): void => {
  app.post('/webhooks/wise', async (context) => {
    const payload = await context.req.text()
    const result = await service.receiveWebhook({
      payload,
      signature: context.req.header('x-signature-sha256') ?? null,
      deliveryId: context.req.header('x-delivery-id') ?? null,
      // Wise spells the test ping with a header rather than an event type, so a
      // subscription can be proved end to end without inventing a transfer.
      isTest: (context.req.header('x-test-notification') ?? '').toLowerCase() === 'true',
    })
    if (!result.accepted) {
      return context.json({ error: { code: 'signature_invalid' } }, 401)
    }
    return context.json({ data: { received: true } }, 200)
  })
}
