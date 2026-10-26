import ICAL from 'ical.js'
import { describe, expect, it } from 'vitest'
import { CalendarFeedInputError, calendarFeedFacts, foldCalendarLine, maximumCalendarFeedEvents, maximumCalendarFeedStateBytes, reconcileCalendarFeed, serializeCalendarFeed } from '../src/resource-calendar-feed.js'
import type { ResourceCalendarProjection } from '../src/resource-calendar.js'

const namespace = 'owned_calendar_feed_1194'
const now = '2026-10-25T12:00:00.000Z'
const projection = (): ResourceCalendarProjection => ({
  context: { timeZone: 'America/New_York', weekStartDay: 'monday', today: '2026-10-25', currentWeekStart: '2026-10-19' },
  view: 'project', revision: 'owned', weekStarts: ['2026-10-19'], nextCursor: null, unassigned: [], unassignedTruncated: false, hasOtherScope: true,
  people: [{ personId: 7, name: 'Private person label', weeks: [{ weekStart: '2026-10-19', plannedSeconds: 4442, availableSeconds: 12600, personPlannedSeconds: 7200, personOtherScopePlannedSeconds: 2758, trackedSeconds: 9876, overAllocated: false, projects: [{ projectId: 81, plannedSeconds: 4442 }], otherScopePlannedSeconds: 2758, otherScopeTrackedSeconds: 0 }] }],
})
const facts = () => calendarFeedFacts(projection(), { includeNames: false })
const parse = (text: string) => new ICAL.Component(ICAL.parse(text)).getAllSubcomponents('vevent')

describe('advisory weekly calendar feed', () => {
  it('reuses exact weekly totals and availability; omits actuals, labels and private identifiers by default', () => {
    const snapshot = reconcileCalendarFeed(namespace, [], facts(), now)
    const text = serializeCalendarFeed(snapshot.events), events = parse(text)
    expect(events).toHaveLength(2)
    expect(events.map(event => event.getFirstPropertyValue('summary'))).toEqual(expect.arrayContaining(['1h 14m 2s planned', '3h 30m available']))
    for (const event of events) {
      const value = new ICAL.Event(event)
      expect(value.startDate.isDate).toBe(true); expect(value.startDate.toString()).toBe('2026-10-19')
      expect(value.endDate.isDate).toBe(true); expect(value.endDate.toString()).toBe('2026-10-26')
      expect(event.getFirstPropertyValue('transp')).toBe('TRANSPARENT')
      expect(event.getFirstPropertyValue('class')).toBe('PRIVATE')
      expect(event.getAllProperties().map(property => property.name).sort()).toEqual(['uid', 'sequence', 'dtstamp', 'last-modified', 'dtstart', 'dtend', 'status', 'transp', 'class', 'summary', 'description'].sort())
    }
    expect(events.some(event => String(event.getFirstPropertyValue('description')).includes('2h planned across all work'))).toBe(true)
    expect(text).not.toContain('2h 44m 36s'); expect(text).not.toContain('Private person label')
    expect(JSON.stringify(snapshot.state)).not.toContain('planned'); expect(JSON.stringify(snapshot.state)).not.toContain('Private person label')
  })
  it('only includes names after an explicit choice and preserves Unicode through RFC folding', () => {
    const current = projection(), name = 'Owned 📅 漢字,semicolon;backslash\\ '.repeat(15)
    const named = { ...current, people: [{ ...current.people[0]!, name }] }
    const snapshot = reconcileCalendarFeed(namespace, [], calendarFeedFacts(named, { includeNames: true }), now)
    const text = serializeCalendarFeed(snapshot.events), events = parse(text)
    expect(events.map(event => event.getFirstPropertyValue('summary'))).toContain(`1h 14m 2s planned · ${name}`)
    for (const line of text.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75)
    expect(text).toContain('\r\n '); expect(text).not.toContain('\uFFFD')
    expect(text.replaceAll('\r\n', '')).not.toContain('\n')
  })
  it('cannot turn CRLF label data into another event or property', () => {
    const attack = 'Owned\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:injected\r\nSUMMARY:unsafe'
    const input = facts().map(fact => ({ ...fact, summary: attack, description: 'Text;with,slashes\\and\nnewlines' }))
    const events = parse(serializeCalendarFeed(reconcileCalendarFeed(namespace, [], input, now).events))
    expect(events).toHaveLength(2)
    expect(events[0]!.getFirstPropertyValue('summary')).toBe(attack.replaceAll('\r\n', '\n'))
    expect(events[0]!.getFirstPropertyValue('description')).toBe('Text;with,slashes\\and\nnewlines')
    expect(() => foldCalendarLine('SUMMARY:unsafe\r\nUID:injected')).toThrow(CalendarFeedInputError)
  })
  it('keeps UIDs and sequences stable on reload; increments change, cancellation and reappearance monotonically', () => {
    const original = facts(), first = reconcileCalendarFeed(namespace, [], original, now)
    const again = reconcileCalendarFeed(namespace, first.state, original, '2026-10-26T12:00:00.000Z')
    expect(again).toEqual(first)
    const updated = reconcileCalendarFeed(namespace, first.state, original.map(fact => ({ ...fact, summary: `${fact.summary} changed` })), '2026-10-26T12:00:00.000Z')
    expect(updated.events.map(event => event.uid)).toEqual(first.events.map(event => event.uid))
    expect(updated.events.every(event => event.sequence === 1)).toBe(true)
    const cancelled = reconcileCalendarFeed(namespace, updated.state, [], '2026-10-27T12:00:00.000Z')
    expect(cancelled.events.every(event => event.cancelled && event.sequence === 2)).toBe(true)
    for (const event of parse(serializeCalendarFeed(cancelled.events))) expect(event.getFirstPropertyValue('status')).toBe('CANCELLED')
    expect(reconcileCalendarFeed(namespace, cancelled.state, [], '2026-10-28T12:00:00.000Z')).toEqual(cancelled)
    const restored = reconcileCalendarFeed(namespace, cancelled.state, original, '2026-10-28T12:00:00.000Z')
    expect(restored.events.every(event => !event.cancelled && event.sequence === 3)).toBe(true)
    expect(restored.events.map(event => event.uid)).toEqual(first.events.map(event => event.uid))
  })
  it('uses different opaque UIDs for distinct feeds and preserves floating week dates over DST', () => {
    const current = projection(), week = { ...current.people[0]!.weeks[0]!, weekStart: '2026-10-26' }
    const input = calendarFeedFacts({ ...current, weekStarts: ['2026-10-26'], people: [{ ...current.people[0]!, weeks: [week] }] }, { includeNames: false })
    const first = reconcileCalendarFeed(namespace, [], input, now), second = reconcileCalendarFeed('another_owned_feed_1194', [], input, now)
    expect(first.events.map(event => event.uid)).not.toEqual(second.events.map(event => event.uid))
    for (const component of parse(serializeCalendarFeed(first.events))) {
      const event = new ICAL.Event(component)
      expect(event.startDate.toString()).toBe('2026-10-26'); expect(event.endDate.toString()).toBe('2026-11-02')
      expect(component.getFirstProperty('dtstart')!.getParameter('tzid')).toBeUndefined()
    }
  })
  it('keeps authorized unassigned demand separate from person availability and reconciles assignment removal', () => {
    const data = { ...projection(), unassigned: [{ placeholderId: 19, projectId: 81, name: 'Owned design role', weekStart: '2026-10-19', plannedSeconds: 3600 }] }
    const first = reconcileCalendarFeed(namespace, [], calendarFeedFacts(data, { includeNames: false }), now)
    expect(parse(serializeCalendarFeed(first.events)).map(event => event.getFirstPropertyValue('summary'))).toContain('1h unassigned planned work')
    expect(serializeCalendarFeed(first.events)).not.toContain('Owned design role')
    const removed = reconcileCalendarFeed(namespace, first.state, facts(), '2026-10-26T12:00:00.000Z')
    expect(removed.events.filter(event => event.cancelled)).toHaveLength(1)
    expect(removed.events.filter(event => !event.cancelled)).toHaveLength(2)
    expect(() => calendarFeedFacts({ ...data, unassignedTruncated: true }, { includeNames: false })).toThrow('Narrow')
  })
  it('refuses incomplete, duplicate or corrupt input instead of emitting a partial calendar', () => {
    expect(() => calendarFeedFacts({ ...projection(), nextCursor: 7 }, { includeNames: false })).toThrow('Narrow')
    expect(() => reconcileCalendarFeed(namespace, [], [...facts(), ...facts()], now)).toThrow(CalendarFeedInputError)
    expect(() => reconcileCalendarFeed(namespace, [], facts(), '2026-99-01T00:00:00.000Z')).toThrow(CalendarFeedInputError)
    const first = reconcileCalendarFeed(namespace, [], facts(), now)
    expect(() => reconcileCalendarFeed(namespace, first.state.map(event => ({ ...event, sequence: Number.MAX_SAFE_INTEGER })), [], now)).toThrow(CalendarFeedInputError)
    expect(() => serializeCalendarFeed([...first.events, ...first.events])).toThrow(CalendarFeedInputError)
  })
  it('limits sequences to RFC 5545 signed integers without wrapping or changing an exhausted event', () => {
    const original = facts(), first = reconcileCalendarFeed(namespace, [], original, now)
    const maximum = first.state.map(event => ({ ...event, sequence: 2_147_483_647 }))
    const unchanged = reconcileCalendarFeed(namespace, maximum, original, now)
    expect(unchanged.events.every(event => event.sequence === 2_147_483_647)).toBe(true)
    for (const event of parse(serializeCalendarFeed(unchanged.events))) expect(event.getFirstPropertyValue('sequence')).toBe(2_147_483_647)
    expect(() => reconcileCalendarFeed(namespace, maximum, [], now)).toThrow(CalendarFeedInputError)
    expect(() => reconcileCalendarFeed(namespace, maximum, original.map(event => ({ ...event, summary: 'Changed' })), now)).toThrow(CalendarFeedInputError)
    expect(() => reconcileCalendarFeed(namespace, first.state.map(event => ({ ...event, sequence: 2_147_483_648 })), original, now)).toThrow(CalendarFeedInputError)
    expect(() => serializeCalendarFeed(first.events.map(event => ({ ...event, sequence: 2_147_483_648 })))).toThrow(CalendarFeedInputError)
  })
  it('bounds native reconciliation storage and emits the maximum complete scope through a real parser', () => {
    const input = Array.from({ length: maximumCalendarFeedEvents }, (_, id) => ({ ...facts()[0]!, key: id.toString(16).padStart(64, '0') }))
    const current = reconcileCalendarFeed(namespace, [], input, now)
    expect(new TextEncoder().encode(JSON.stringify(current.state)).byteLength).toBeLessThanOrEqual(maximumCalendarFeedStateBytes)
    expect(parse(serializeCalendarFeed(current.events))).toHaveLength(maximumCalendarFeedEvents)
    expect(() => reconcileCalendarFeed(namespace, [], [...input, { ...input[0]!, key: 'f'.repeat(64) }], now)).toThrow(CalendarFeedInputError)
    expect(() => reconcileCalendarFeed(namespace, current.state, [{ ...input[0]!, key: 'f'.repeat(64) }], now)).toThrow(CalendarFeedInputError)
  })
})
