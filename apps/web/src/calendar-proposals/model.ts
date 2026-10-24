import {
  calendarProposalEntryFields,
  dateInTimeZone,
  timeInTimeZone,
  usableTimeZone,
} from '@ezacto/core'
import type { CalendarProposal } from '@conflict-hq/ezacto-client'

export const proposalTimeZone = (profile: {
  timezone: string
  effective_timezone?: string
}): string | null => {
  if (profile.effective_timezone !== undefined && usableTimeZone(profile.effective_timezone))
    return profile.effective_timezone
  return profile.timezone !== 'UTC' && usableTimeZone(profile.timezone) ? profile.timezone : null
}

export interface ProposalBlock {
  readonly proposal: CalendarProposal
  readonly date: string
  readonly start: number
  readonly end: number
  readonly continuesBefore: boolean
  readonly continuesAfter: boolean
}
const minutes = (instant: string, zone: string): number => {
  const [hour, minute] = timeInTimeZone(instant, zone).split(':').map(Number)
  return hour! * 60 + minute!
}

/** Visual day segments only. Acceptance always sends the original proposal ID. */
export const proposalBlocks = (
  proposals: readonly CalendarProposal[],
  dates: readonly string[],
  zone: string,
): readonly ProposalBlock[] =>
  proposals.flatMap((proposal) => {
    const first = dateInTimeZone(proposal.starts_at, zone)
    const last = dateInTimeZone(proposal.ends_at, zone)
    return dates
      .filter((date) => date >= first && date <= last)
      .flatMap((date) => {
        const start = date === first ? minutes(proposal.starts_at, zone) : 0
        const end = date === last ? minutes(proposal.ends_at, zone) : 1440
        if (end === 0 && date !== first) return []
        // A repeated DST clock can end before it starts on the same local date.
        // Keep a marker at the real start; its label retains both source instants.
        return [
          {
            proposal,
            date,
            start,
            end: Math.max(start + 1, end),
            continuesBefore: date > first,
            continuesAfter: date < last,
          },
        ]
      })
  })

export const proposalSourceLabel = (proposal: CalendarProposal, zone: string): string => {
  const format = new Intl.DateTimeFormat(undefined, {
    timeZone: zone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'shortOffset',
  })
  return `${format.format(new Date(proposal.starts_at))} – ${format.format(new Date(proposal.ends_at))} (${zone})`
}

export const proposalReviewFields = (proposal: CalendarProposal, zone: string) => ({
  date: dateInTimeZone(proposal.starts_at, zone),
  seconds: Math.round((Date.parse(proposal.ends_at) - Date.parse(proposal.starts_at)) / 1000),
  times: {
    started: timeInTimeZone(proposal.starts_at, zone),
    ended: timeInTimeZone(proposal.ends_at, zone),
  },
})

/** Preview only a conversion the same core server contract can represent. */
export const proposalBillingSeconds = (
  proposal: CalendarProposal,
  mode: 'duration' | 'start_end',
  zone: string,
): number => {
  calendarProposalEntryFields({
    mode,
    startsAt: proposal.starts_at,
    endsAt: proposal.ends_at,
    timeZone: zone,
  })
  return Math.round((Date.parse(proposal.ends_at) - Date.parse(proposal.starts_at)) / 1000)
}
