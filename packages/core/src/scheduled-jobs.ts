/** Company month-end jobs propose concrete work; they never authorize it. */
export interface ScheduledJobConfig {
  action: 'month_end_pack'
  name: string
  scope: { client_ids: number[] }
  cadence: string
  confirmation: 'required'
  confirm_within_minutes: number
  is_active: boolean
}
export interface ScheduledJob extends Omit<ScheduledJobConfig, 'scope' | 'confirmation'> {
  scope: unknown
  confirmation: 'required' | 'none'
  id: number
  version: number
  created_by: number
  created_at: string
  updated_at: string
  last_checked_at: string | null
  last_error: string | null
  last_run_id: number | null
}
export class ScheduledJobError extends Error {
  constructor(
    readonly code: 'invalid' | 'not_found' | 'state_conflict' | 'profile_forbidden',
    message: string,
    readonly field = 'job',
  ) {
    super(message)
    this.name = 'ScheduledJobError'
  }
}
export interface ScheduledJobsService {
  snapshot(): Promise<number>
  list(window: { throughId: number; afterId: number | null; take: number }): Promise<ScheduledJob[]>
  read(id: number): Promise<ScheduledJob | null>
  create(actorId: number, config: ScheduledJobConfig, now: string): Promise<ScheduledJob>
  update(
    actorId: number,
    id: number,
    version: number,
    patch: unknown,
    now: string,
  ): Promise<ScheduledJob>
}

export const monthlyCadence = (value: string): { minute: number; hour: number; day: number } => {
  const match = /^(\d{1,2}) (\d{1,2}) (\d{1,2}) \* \*$/.exec(value.trim().replace(/\s+/g, ' '))
  const minute = Number(match?.[1]),
    hour = Number(match?.[2]),
    day = Number(match?.[3])
  if (!match || minute > 59 || hour > 23 || day < 1 || day > 31)
    throw new ScheduledJobError(
      'invalid',
      'Use a monthly cadence M H D * * (minute 0–59, hour 0–23, day 1–31).',
      'cadence',
    )
  return { minute, hour, day }
}

export const scheduledJobConfig = (input: unknown, base?: unknown): ScheduledJobConfig => {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new ScheduledJobError('invalid', 'Provide job settings.')
  const fields = input as Record<string, unknown>
  const allowed = new Set([
    'action',
    'name',
    'scope',
    'cadence',
    'confirmation',
    'confirm_within_minutes',
    'is_active',
  ])
  for (const key of Object.keys(fields))
    if (!allowed.has(key)) throw new ScheduledJobError('invalid', 'Unknown job setting.', key)
  const previous = base && typeof base === 'object' && !Array.isArray(base) ? base : {}
  const merged: Record<string, unknown> = {
    action: 'month_end_pack',
    name: '',
    scope: { client_ids: [] },
    cadence: '0 9 1 * *',
    confirmation: 'required',
    confirm_within_minutes: 1440,
    is_active: true,
    ...previous,
    ...fields,
  }
  if (merged.action !== 'month_end_pack')
    throw new ScheduledJobError('invalid', 'This job supports the month_end_pack action.', 'action')
  if (typeof merged.name !== 'string' || !merged.name.trim() || merged.name.trim().length > 200)
    throw new ScheduledJobError('invalid', 'Give the job a name (1–200 characters).', 'name')
  if (typeof merged.cadence !== 'string')
    throw new ScheduledJobError('invalid', 'Provide a monthly cadence.', 'cadence')
  const cadence = monthlyCadence(merged.cadence.trim())
  if (merged.confirmation !== 'required')
    throw new ScheduledJobError(
      'invalid',
      'Month-end packs require authenticated confirmation.',
      'confirmation',
    )
  if (
    !Number.isSafeInteger(merged.confirm_within_minutes) ||
    Number(merged.confirm_within_minutes) < 1 ||
    Number(merged.confirm_within_minutes) > 20160
  )
    throw new ScheduledJobError(
      'invalid',
      'The confirmation window must be 1–20160 minutes.',
      'confirm_within_minutes',
    )
  if (typeof merged.is_active !== 'boolean')
    throw new ScheduledJobError('invalid', 'Choose whether the job is active.', 'is_active')
  const scope = merged.scope
  if (
    !scope ||
    typeof scope !== 'object' ||
    Array.isArray(scope) ||
    Object.keys(scope).some((key) => key !== 'client_ids')
  )
    throw new ScheduledJobError('invalid', 'Scope accepts only client_ids.', 'scope')
  const clientIds = (scope as Record<string, unknown>).client_ids ?? []
  if (!Array.isArray(clientIds) || clientIds.some((id) => !Number.isSafeInteger(id) || id < 1))
    throw new ScheduledJobError(
      'invalid',
      'Client IDs must be positive integers.',
      'scope.client_ids',
    )
  return {
    action: 'month_end_pack',
    name: merged.name.trim(),
    scope: { client_ids: [...new Set(clientIds)].sort((a, b) => a - b) },
    cadence: `${cadence.minute} ${cadence.hour} ${cadence.day} * *`,
    confirmation: 'required',
    confirm_within_minutes: Number(merged.confirm_within_minutes),
    is_active: merged.is_active,
  }
}

/** Catch up a due monthly occurrence once, using the organization's local clock. */
export const dueMonthEndOccurrence = (
  now: string,
  timeZone: string,
  expression: string,
): string | null => {
  const instant = new Date(now)
  if (!Number.isFinite(instant.valueOf()))
    throw new ScheduledJobError('invalid', 'Invalid scheduler time.')
  const cadence = monthlyCadence(expression)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant)
  const number = (key: string) => Number(parts.find((part) => part.type === key)?.value)
  const year = number('year'),
    month = number('month'),
    day = number('day')
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  if (
    cadence.day > daysInMonth ||
    day < cadence.day ||
    (day === cadence.day &&
      number('hour') * 60 + number('minute') < cadence.hour * 60 + cadence.minute)
  )
    return null
  const prior = new Date(Date.UTC(year, month - 1, 0))
  return `${prior.getUTCFullYear()}-${String(prior.getUTCMonth() + 1).padStart(2, '0')}`
}
