import { isAllocationDate } from './allocation.js'
import { TrackedResourceInputError } from './tracked-state.js'

export interface OrganizationHolidayFields {
  date: string
  name: string
}
export interface OrganizationHoliday extends OrganizationHolidayFields {
  id: number
  version: number
  createdAt: string
  updatedAt: string
}
export interface OrganizationHolidayFilter {
  from?: string
  to?: string
}
export interface OrganizationHolidayWindow {
  afterId: number | null
  throughId: number
  take: number
}
export interface OrganizationHolidaySource {
  highWatermark(): Promise<number | null>
  list(window: OrganizationHolidayWindow): Promise<OrganizationHoliday[]>
}
export interface OrganizationHolidayRepository {
  entries(filter: OrganizationHolidayFilter): OrganizationHolidaySource
  get(id: number): Promise<OrganizationHoliday | null>
  create(
    actorId: number,
    fields: OrganizationHolidayFields,
    now: string,
  ): Promise<OrganizationHoliday>
  update(
    actorId: number,
    id: number,
    fields: OrganizationHolidayFields,
    version: number,
    now: string,
  ): Promise<OrganizationHoliday>
  remove(actorId: number, id: number, version: number, now: string): Promise<OrganizationHoliday>
}
export class OrganizationHolidayError extends Error {
  constructor(
    readonly code:
      'holiday_not_found' | 'holiday_forbidden' | 'holiday_changed' | 'holiday_date_exists',
  ) {
    super(
      {
        holiday_not_found: 'This holiday no longer exists.',
        holiday_forbidden: 'Only an active administrator can change organization holidays.',
        holiday_changed: 'The holiday changed. Refresh before trying again.',
        holiday_date_exists: 'The organization already has a holiday on this date.',
      }[code],
    )
    this.name = 'OrganizationHolidayError'
  }
}
export const assertOrganizationHolidayFields = (fields: OrganizationHolidayFields): void => {
  if (!isAllocationDate(fields.date))
    throw new TrackedResourceInputError(
      'date',
      'invalid_date',
      'Use a real YYYY-MM-DD calendar date.',
    )
  if (
    typeof fields.name !== 'string' ||
    fields.name.length < 1 ||
    fields.name.length > 120 ||
    fields.name !== fields.name.trim() ||
    [...fields.name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw new TrackedResourceInputError(
      'name',
      'invalid_name',
      'Use a holiday name of 1–120 characters without surrounding whitespace or control characters.',
    )
}
