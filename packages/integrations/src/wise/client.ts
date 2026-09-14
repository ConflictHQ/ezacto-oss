/**
 * Wise, reached with the organisation's own API token (issue 543).
 *
 * This replaces the OAuth client. The two answer different questions and only
 * one of them is the product we want: OAuth lets a *contractor* authorise their
 * own Wise account, and an API token authenticates as *us*, which is what
 * actually sends money out of the business account.
 *
 * The practical difference is who has to do something. OAuth needs an app
 * registered with Wise, a consent screen, and every contractor to hold a Wise
 * account and complete a flow. A token needs one value on the deployment. For
 * one firm paying its own contractors, the token is the whole of it.
 *
 * What a payout still needs from the person is a destination -- a Wise recipient
 * account -- and that is a separate fact stored against them in
 * `user_payout_accounts`, exactly as before. Dropping OAuth changes where the
 * identifier comes from, not the rule that a payout resolves to a stored
 * identifier rather than a guess about somebody's email (#421).
 */

/** Wise's own address. There is one, and it is not configurable -- see `oauth.ts`'s note. */
export const WISE_API_BASE = 'https://api.wise.com'

export class WiseApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'WiseApiError'
    this.status = status
  }
}

export interface WiseProfileSummary {
  /** Wise's identifier, as a string: it arrives as a JSON number. */
  readonly id: string
  readonly type: 'personal' | 'business'
  readonly name: string | null
}

const asObject = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/**
 * Quotes every id before the parse.
 *
 * `JSON.parse` rounds an integer past 2^53 before a reviver or any later
 * `String(...)` can see the original digits, so reading an id "as a string" off
 * the parsed object stringifies a number that is already the wrong one.
 */
const quoteIds = (body: string): string => body.replace(/"id"\s*:\s*(-?\d+)/gu, '"id":"$1"')

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== ''
    ? value
    : typeof value === 'number'
      ? String(value)
      : null

/**
 * Wise answers with these UPPERCASE -- 'BUSINESS' and 'PERSONAL', confirmed
 * against the live API. Comparing in lower case read every business profile as
 * personal, and the payout profile is chosen by preferring business.
 */
const profileType = (value: unknown): 'personal' | 'business' =>
  typeof value === 'string' && value.toLowerCase() === 'business' ? 'business' : 'personal'

/**
 * A place the organisation can send money to.
 *
 * What is *not* here is the point. Wise returns `accountSummary` and
 * `details.accountNumber`, both of which are the recipient's full bank account
 * number -- confirmed against the live API, where `accountSummary` reads as a
 * twelve digit number rather than anything masked. Neither is carried on this
 * type, so neither can reach a screen, a log or a database by accident.
 *
 * `maskedSummary` is Wise's `longAccountSummary`, which is the one that ends in
 * the last four digits. That is enough for a person to recognise an account
 * they already know, which is all an operator linking one actually needs.
 */
export interface WiseRecipient {
  readonly id: string
  readonly holderName: string | null
  readonly currency: string
  /** Wise's own word for the rails: `Aba`, `SwiftCode`, `email`, and so on. */
  readonly type: string
  /** Masked. Never the full number. */
  readonly maskedSummary: string | null
  readonly email: string | null
  readonly active: boolean
  /** True where this is one of our own accounts rather than somebody we pay. */
  readonly ownedByUs: boolean
}

export interface CreateEmailRecipientInput {
  readonly profileId: string
  /** The address on the contractor's own Wise account. */
  readonly email: string
  /** As it should read on the payment. */
  readonly legalName: string
  readonly currency: string
}

export interface WiseClient {
  /** Every profile the token can act for. The call that proves a token works. */
  profiles(): Promise<readonly WiseProfileSummary[]>
  /** Everyone this profile can pay. */
  recipients(profileId: string): Promise<readonly WiseRecipient[]>
  /**
   * Creates a recipient we pay by email rather than by bank details.
   *
   * The reason this is the shape worth having: Wise then collects the account
   * details from the contractor directly, and they never pass through here. We
   * hold an email address and an id, and no account number exists in this
   * system to be leaked, logged, or backed up.
   *
   * That is not theoretical. Wise returns a field called `accountSummary` whose
   * value is a full account number, which is exactly the sort of thing that
   * ends up on a screen because of what it is called.
   */
  createEmailRecipient(input: Readonly<CreateEmailRecipientInput>): Promise<WiseRecipient>
}

export interface WiseClientOptions {
  readonly token: string
  readonly fetchImplementation?: typeof fetch
}

/**
 * One recipient, carrying only what is safe to carry.
 *
 * `accountSummary` and `details.accountNumber` are both the full account
 * number, and neither is on the type -- so neither can reach a screen, a log or
 * a row through here.
 */
const recipientOf = (entry: unknown): WiseRecipient => {
  const account = asObject(entry)
  const id = text(account.id)
  if (id === null) throw new WiseApiError('a Wise recipient carried no id', 200)
  return {
    id,
    holderName: text(asObject(account.name).fullName) ?? text(account.accountHolderName),
    currency: text(account.currency) ?? '',
    type: text(account.type) ?? '',
    // Deliberately `longAccountSummary`. `accountSummary` is the full account
    // number, whatever the name suggests.
    maskedSummary: text(account.longAccountSummary),
    email: text(account.email) ?? text(asObject(account.details).email),
    active: account.active !== false,
    ownedByUs: account.ownedByCustomer === true,
  }
}

export const createWiseClient = (options: Readonly<WiseClientOptions>): WiseClient => {
  const call = options.fetchImplementation ?? fetch

  const request = async (path: string, body?: unknown): Promise<unknown> => {
    const response = await call(`${WISE_API_BASE}${path}`, {
      ...(body === undefined
        ? {}
        : { method: 'POST', body: JSON.stringify(body) }),
      headers: {
        authorization: `Bearer ${options.token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
    })
    if (!response.ok) {
      // The status is carried because 401 and 403 mean different things to an
      // operator: a token that is wrong, and a token that is right but not
      // permitted. "Wise refused" alone sends them to the wrong place.
      throw new WiseApiError(`Wise refused ${path} (${String(response.status)})`, response.status)
    }
    return JSON.parse(quoteIds(await response.text())) as unknown
  }

  return {
    profiles: async () => {
      const body = await request('/v2/profiles')
      if (!Array.isArray(body)) throw new WiseApiError('profile response was not an array', 200)
      return body.map((entry) => {
        const profile = asObject(entry)
        const id = text(profile.id)
        if (id === null) throw new WiseApiError('a Wise profile carried no id', 200)
        return {
          id,
          type: profileType(profile.type),
          name:
            text(profile.fullName) ??
            text(profile.name) ??
            text(asObject(profile.details).name),
        }
      })
    },

    recipients: async (profileId) => {
      // v2 rather than v1: v1 spells the rails `swift_code` and v2 spells the
      // same thing `SwiftCode`, and only v2 carries the masked summary. Picking
      // one and pinning it beats reading whichever arrives.
      const body = await request(`/v2/accounts?profileId=${encodeURIComponent(profileId)}`)
      const items = Array.isArray(body) ? body : asObject(body).content
      if (!Array.isArray(items)) throw new WiseApiError('recipient response was not a list', 200)
      return items.map(recipientOf)
    },

    createEmailRecipient: async (input) => {
      const email = input.email.trim()
      const legalName = input.legalName.trim()
      // Refused here rather than at Wise, so the caller hears which field is
      // wrong instead of a vendor validation error about `details.email`.
      if (email === '' || !email.includes('@')) {
        throw new WiseApiError('an email recipient needs an email address', 400)
      }
      if (legalName === '') {
        throw new WiseApiError('an email recipient needs the name to pay', 400)
      }
      const created = await request('/v1/accounts', {
        profile: input.profileId,
        accountHolderName: legalName,
        currency: input.currency.toUpperCase(),
        // Wise's own word for "pay them by email and let them supply the rest".
        type: 'email',
        details: { email },
      })
      return recipientOf(created)
    },
  }
}

/**
 * Which profile pays.
 *
 * A business profile is the one a firm invoices and pays from; a personal
 * profile on the same login is the operator's own money. Preferring business is
 * not a tidiness choice -- paying contractors out of somebody's personal
 * balance is a different act with different consequences.
 *
 * A configured id wins over any of this. An account with two business profiles
 * is a question this cannot answer, and guessing would be the same class of
 * mistake as matching a person by their email address.
 */
export const choosePayingProfile = (
  profiles: readonly WiseProfileSummary[],
  configuredId?: string | null,
): WiseProfileSummary | null => {
  const wanted = configuredId?.trim()
  if (wanted !== undefined && wanted !== '') {
    return profiles.find((profile) => profile.id === wanted) ?? null
  }
  return profiles.find((profile) => profile.type === 'business') ?? null
}
