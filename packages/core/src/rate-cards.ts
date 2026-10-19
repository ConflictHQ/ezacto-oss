import type { RateCardLine } from './rates.js'

/**
 * Client rate cards (issue 34): a named card attached to one client node whose
 * effective-dated, append-only versions hold task lines or a single rate. The
 * resolver in `rates.ts` decides what a card prices; this module is the
 * storage-facing vocabulary shared by the repository and the API.
 */

export const rateCardNameMaxLength = 200
export const rateCardMaxLines = 200
/** Ten million units an hour, in cents: far past any real rate, well inside safe integers. */
export const rateCardMaxAmountCents = 1_000_000_000

export interface RateCardVersionRecord {
  id: number
  startDate: string | null
  lines: readonly RateCardLine[]
  createdAt: string
}

export interface ClientRateCardRecord {
  id: number
  clientId: number
  name: string
  createdAt: string
  /** Oldest first. */
  versions: readonly RateCardVersionRecord[]
}

/** Which card priced a task on a date, and how far up the tree it sat. */
export interface EffectiveClientRateCard {
  clientId: number
  suppliedByClientId: number
  /** 0 when the client's own card supplied it. */
  depth: number
  cardId: number
  cardName: string
  versionStartDate: string | null
  /** The matching line's task, or null when the card default priced it. */
  taskId: number | null
  amountCents: number
}

export class RateCardClientNotFoundError extends Error {
  readonly code = 'client_not_found' as const

  constructor() {
    super('The requested client does not exist.')
    this.name = 'RateCardClientNotFoundError'
  }
}

export class RateCardNotFoundError extends Error {
  readonly code = 'rate_card_not_found' as const

  constructor() {
    super('No rate card applies here.')
    this.name = 'RateCardNotFoundError'
  }
}

export class RateCardExistsError extends Error {
  readonly code = 'rate_card_exists' as const

  constructor() {
    super('This client already has a rate card. Add a version to change its rates.')
    this.name = 'RateCardExistsError'
  }
}

export class RateCardVersionOrderError extends Error {
  readonly code = 'rate_card_version_order' as const

  constructor() {
    super('A new version must start after every existing version of the card.')
    this.name = 'RateCardVersionOrderError'
  }
}

export class RateCardTaskNotFoundError extends Error {
  readonly code = 'unknown_task' as const

  constructor(readonly taskId: number) {
    super(`Task ${taskId} does not exist.`)
    this.name = 'RateCardTaskNotFoundError'
  }
}

export const assertRateCardName = (name: string): void => {
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > rateCardNameMaxLength) {
    throw new RangeError(`rate card name must be 1 to ${rateCardNameMaxLength} characters`)
  }
}

/** Empty is allowed: an empty version retires the card. */
export const assertRateCardLines = (lines: readonly RateCardLine[]): void => {
  if (!Array.isArray(lines) || lines.length > rateCardMaxLines) {
    throw new RangeError(`rate card version takes at most ${rateCardMaxLines} lines`)
  }
  const seen = new Set<number | null>()
  for (const line of lines) {
    if (line.taskId !== null && (!Number.isSafeInteger(line.taskId) || line.taskId < 1)) {
      throw new RangeError('rate card line task must be null or a positive integer')
    }
    if (
      !Number.isSafeInteger(line.amountCents) ||
      line.amountCents < 0 ||
      line.amountCents > rateCardMaxAmountCents
    ) {
      throw new RangeError(`rate card line amount must be 0 to ${rateCardMaxAmountCents} cents`)
    }
    if (seen.has(line.taskId)) throw new RangeError('rate card version has duplicate lines')
    seen.add(line.taskId)
  }
}
