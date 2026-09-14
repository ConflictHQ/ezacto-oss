/**
 * Where a person is paid, on whichever screen is asking (issues 421 and 543).
 *
 * Two screens ask: their own account settings, and the person record an
 * administrator opens. Same answer, same wording, same refusals -- so the
 * reading of it lives here rather than twice.
 */

/**
 * What a payout panel knows.
 *
 * No identifier. A Wise contact id and a recipient id are both opaque, and
 * neither tells a person anything they could check. `kind` is the part worth
 * showing: "we hold your Wise profile" and "we hold an account somebody entered
 * for you" are different promises about where money lands.
 */
export interface PayoutDestinationState {
  readonly configured: boolean
  readonly destination: {
    readonly kind: 'account' | 'contact'
    readonly linkedAt: string
    readonly verifiedAt: string | null
  } | null
}

/**
 * The date a destination was set, in the reader's own reading of it.
 *
 * Deliberately not the time. What matters is "when did somebody tell us this",
 * and a timestamp to the second implies a precision nobody needs to act on.
 */
export const payoutDate = (value: string): string => {
  const stamp = Date.parse(value)
  return Number.isNaN(stamp)
    ? 'an unknown date'
    : new Date(stamp).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
}

/**
 * What went wrong, said to the person who can fix it.
 *
 * Nearly every refusal here is theirs to act on -- a tag with a typo, a Wise
 * profile that is not discoverable, somebody who already has a destination --
 * and "the request failed" sends them to ask an administrator about something
 * no administrator can see.
 */
export const payoutFailure = (error: unknown): string => {
  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? (error as { status: unknown }).status
      : null
  const body =
    typeof error === 'object' && error !== null && 'body' in error
      ? (error as { body: unknown }).body
      : null
  const fields =
    typeof body === 'object' && body !== null && 'error' in body
      ? ((body as { error: { fields?: readonly { code?: string }[] } }).error.fields ?? [])
      : []
  if (fields.some((field) => field.code === 'not_discoverable')) {
    return 'Wise has no discoverable profile with that identifier. Check the spelling, and check they have discoverability switched on in Wise.'
  }
  switch (status) {
    case 409:
      return 'That is already a payout destination — either this person has one, or that Wise profile belongs to somebody else here.'
    case 422:
      return 'Enter a Wisetag, email or phone, and a three-letter currency.'
    case 403:
      return 'You cannot set this payout destination.'
    case 503:
      return 'Wise is not connected on this instance.'
    default:
      return 'The payout destination could not be saved.'
  }
}

/** How a set destination reads, in one sentence. */
export const payoutSummary = (destination: {
  readonly kind: 'account' | 'contact'
  readonly linkedAt: string
}): string =>
  destination.kind === 'contact'
    ? `Paid to the Wise profile shared on ${payoutDate(destination.linkedAt)}. Wise holds the bank details; this instance never sees them.`
    : `Paid to a Wise recipient account added on ${payoutDate(destination.linkedAt)}.`
