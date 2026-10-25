import type { ResourceCalendar, ResourceCalendarContext } from '@conflict-hq/ezacto-client'
import { EzactoApiError } from '@conflict-hq/ezacto-client'
import type { CapacityApi } from './model.js'
import { addCalendarDays, hoursText, shortDate, weekHeading } from './model.js'
import { createPlanningEntry } from './planning-browser.js'
import { createPlaceholderPlanningController } from './placeholders-browser.js'
import { calendarPages, calendarWindow, timelinePosition, type CalendarAllocation, type CalendarProject, type CalendarQuery, type ResourceCalendarApi } from './resource-calendar-model.js'

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = text
  return node
}

export const createResourceCalendarController = (api: ResourceCalendarApi, legacy: CapacityApi) => {
  const page = document.querySelector<HTMLElement>('[data-capacity-page]')!
  const find = <T extends HTMLElement>(selector: string) => page.querySelector<T>(selector)!
  const grid = find<HTMLElement>('[data-capacity-grid]'), status = find<HTMLElement>('[data-capacity-status]')
  const label = find<HTMLElement>('[data-capacity-label]'), retry = find<HTMLButtonElement>('[data-capacity-retry]')
  const controls = element('div'); controls.className = 'resource-calendar-controls capacity-form'
  controls.setAttribute('aria-label', 'Calendar view')
  const select = (name: string, entries: readonly [string, string][]) => {
    const label = element('label', name), input = element('select')
    for (const [value, text] of entries) { const option = element('option', text); option.value = value; input.append(option) }
    label.append(input); controls.append(label)
    return input
  }
  const scope = select('Scope', [['team', 'Team'], ['project', 'Project']])
  const project = select('Project', []); project.parentElement!.hidden = true
  const person = select('Person', [['', 'All people']])
  const mode = select('Display', [['week', 'Week'], ['timeline', 'Timeline']])
  const notice = element('p'); notice.dataset.calendarNotice = ''; notice.className = 'capacity-intro'
  const more = element('button', 'Load more people'); more.type = 'button'; more.hidden = true; more.dataset.calendarMore = ''
  const timeline = element('section'); timeline.className = 'resource-calendar-timeline'; timeline.hidden = true
  timeline.setAttribute('aria-label', 'Dated allocations')
  grid.before(controls, notice); grid.after(timeline, more)
  let active: AbortSignal | null = null, operation: AbortController | null = null
  let release: (() => void) | null = null, generation = 0, offset = 0, administrator = false, scheduleManager = false
  let context: ResourceCalendarContext | null = null, report: ResourceCalendar | null = null, query: CalendarQuery | null = null
  let directory: readonly CalendarProject[] = [], allocations: readonly CalendarAllocation[] = []
  let nextCursor: string | null = null, paging = false
  const seenCursors = new Set<string>()
  const peopleOptions = new Map<number, string>()
  const fillPeople = () => {
    const selected = person.value
    const choices: [string, string][] = [['', 'All people'], ...[...peopleOptions].map(([id, name]): [string, string] => [String(id), name])]
    person.replaceChildren(...choices.map(([value, name]) => {
      const option = element('option', name); option.value = value; return option
    }))
    if ([...person.options].some(option => option.value === selected)) person.value = selected
  }
  const planningHost = find<HTMLElement>('[data-capacity-planning]'), placeholderHost = find<HTMLElement>('[data-capacity-placeholders]')
  const planning = legacy.planning ? createPlanningEntry(planningHost, {
    ...legacy.planning,
    listProjects: async () => directory.filter(row => row.is_active),
    listAllocations: async () => allocations.filter(row => report?.people.some(person => person.person_id === row.user_id)),
    listTimeOff: async (range, signal) => (await legacy.planning!.listTimeOff(range, signal)).filter(row => report?.people.some(person => person.person_id === row.user_id)),
  }, () => void load(true)) : null
  const placeholders = legacy.placeholders ? createPlaceholderPlanningController(placeholderHost, legacy.placeholders, () => void load()) : null
  const clear = () => {
    generation++; operation?.abort(); operation = null
    planning?.unmount(); placeholders?.clear()
    report = null; query = null; context = null; directory = []; allocations = []; nextCursor = null; paging = false; seenCursors.clear()
    grid.replaceChildren(); timeline.replaceChildren(); project.replaceChildren(); notice.textContent = ''; label.textContent = '—'; status.textContent = ''
    peopleOptions.clear(); person.value = ''; fillPeople()
    more.hidden = true; retry.hidden = true
  }
  const current = (version: number, signal: AbortSignal) => version === generation && !signal.aborted && active !== null && !active.aborted
  const draw = () => {
    if (!report || !query) return
    const table = element('table'); table.className = 'data-table'; table.dataset.resourceCalendar = ''
    table.append(element('caption', `${scope.value === 'project' ? 'Project' : 'Team'} plan, availability and rounded actuals`))
    const head = element('thead'), header = element('tr'); header.append(element('th', 'Person'))
    for (const week of report.week_starts) header.append(element('th', weekHeading(week)))
    head.append(header); table.append(head)
    const body = element('tbody')
    for (const person of report.people) {
      const row = element('tr'), name = element('th', person.name); row.dataset.calendarPerson = String(person.person_id); name.scope = 'row'; row.append(name)
      for (const week of person.weeks) {
        const td = element('td'), content = element('span'); td.dataset.calendarWeek = week.week_start; content.className = 'capacity-cell'
        content.append(element('strong', `${hoursText(week.planned_seconds)} planned`), element('span', `${hoursText(week.available_seconds)} available`), element('span', `${hoursText(week.tracked_seconds)} tracked (rounded)`))
        if (week.over_allocated) { content.dataset.overAllocated = 'true'; content.append(element('em', 'Over-allocated')) }
        if (week.person_planned_seconds !== week.planned_seconds) content.append(element('span', `${hoursText(week.person_planned_seconds)} planned across all work`))
        if (week.person_other_scope_planned_seconds || week.other_scope_tracked_seconds) content.append(element('span', `Other scope: ${hoursText(week.person_other_scope_planned_seconds)} planned, ${hoursText(week.other_scope_tracked_seconds)} tracked`))
        td.append(content); row.append(td)
      }
      body.append(row)
    }
    table.append(body)
    const scroll = element('div'); scroll.className = 'data-table-scroll'; scroll.tabIndex = 0; scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', 'Weekly calendar; scroll to see later weeks'); scroll.append(table)
    const children: Node[] = report.people.length ? [scroll] : [element('p', 'No people in this calendar scope.')]
    const demand = element('section'); demand.setAttribute('aria-label', 'Unassigned demand'); demand.append(element('h2', 'Unassigned demand'))
    const list = element('ul')
    for (const row of report.unassigned) list.append(element('li', `${row.name} · ${directory.find(item => item.id === row.project_id)?.name ?? 'Project'} · ${weekHeading(row.week_start)} · ${hoursText(row.planned_seconds)} planned`))
    demand.append(report.unassigned.length ? list : element('p', 'No unassigned demand in these weeks.'))
    if (report.unassigned_truncated) demand.append(element('p', 'More unassigned demand exists. Narrow the project scope to see it.'))
    children.push(demand); grid.replaceChildren(...children)
    timeline.replaceChildren(element('h2', 'Dated allocations'))
    const visiblePeople = new Map(report.people.map(person => [person.person_id, person.name]))
    for (const allocation of allocations.filter(row => visiblePeople.has(row.user_id))) {
      const position = timelinePosition(query.from, query.to, allocation.start_date, allocation.end_date)
      if (!position) continue
      const item = element('article'); item.className = 'resource-calendar-allocation'
      item.append(element('h3', `${visiblePeople.get(allocation.user_id)} · ${allocation.project_name}`), element('p', `${shortDate(allocation.start_date)} to ${shortDate(allocation.end_date)} · ${hoursText(allocation.planned_seconds_per_week)} per touched week`))
      const track = element('div'); track.className = 'resource-calendar-track'; track.setAttribute('aria-hidden', 'true')
      const bar = element('span'); bar.style.marginInlineStart = `${position.start}%`; bar.style.width = `${position.width}%`; track.append(bar); item.append(track); timeline.append(item)
    }
    if (timeline.childElementCount === 1) timeline.append(element('p', 'No dated allocations for the people shown.'))
    timeline.hidden = mode.value !== 'timeline'
    more.hidden = nextCursor === null; more.disabled = paging
    label.textContent = `${shortDate(query.from)} to ${shortDate(query.to)}`
    notice.textContent = `${administrator ? 'Administrator entry is below.' : 'Read-only calendar.'} Availability is the whole person’s capacity after leave and holidays. Plans are not actual work. ${report.has_other_scope ? 'Other-scope work is included without private project names. ' : ''}Dates follow ${report.context.time_zone}; weeks start ${report.context.week_start_day}.`
  }
  const load = async (preservePlanningDraft = false) => {
    if (!active || active.aborted || page.hidden) return
    const version = ++generation
    operation?.abort(); operation = new AbortController()
    const signal = operation.signal
    if (!preservePlanningDraft) planning?.unmount()
    placeholders?.clear(); grid.replaceChildren(); timeline.replaceChildren(); report = null; nextCursor = null; seenCursors.clear(); more.hidden = true
    status.textContent = 'Loading calendar…'; retry.hidden = true
    try {
      const [bootstrap, projects] = await Promise.all([api.context(signal), calendarPages(cursor => api.projects(cursor, signal), signal)])
      if (!current(version, signal)) return
      context = bootstrap.data; directory = projects
      const oldProject = project.value
      project.replaceChildren(...projects.map(row => { const option = element('option', `${row.name}${row.is_active ? '' : ' (archived)'}`); option.value = String(row.id); return option }))
      if (projects.some(row => String(row.id) === oldProject)) project.value = oldProject
      const range = calendarWindow(context, offset)
      if (scope.value === 'project' && project.value === '') { status.textContent = 'No projects are available in this scope.'; return }
      query = { ...range, view: scope.value === 'project' ? 'project' : 'team', ...(scope.value === 'project' ? { project_id: Number(project.value) } : {}), ...(person.value === '' ? {} : { person_id: Number(person.value) }) }
      const selectedQuery = query
      const summary = api.read(selectedQuery, undefined, signal).then(response => {
        if (current(version, signal)) {
          peopleOptions.clear(); for (const row of response.data.people) peopleOptions.set(row.person_id, row.name); fillPeople()
        }
        return response
      })
      const [response, dated] = await Promise.all([summary, calendarPages(cursor => api.allocations(selectedQuery, cursor, signal), signal)])
      if (!current(version, signal)) return
      report = response.data; allocations = dated; nextCursor = response.page.next_cursor
      peopleOptions.clear(); for (const row of report.people) peopleOptions.set(row.person_id, row.name); fillPeople()
      draw()
      const planningRange = { from: report.week_starts[0] ?? range.from, to: report.week_starts.length ? addCalendarDays(report.week_starts.at(-1)!, 6) : range.to }
      const people = report.people.map(person => ({ id: person.person_id, name: person.name }))
      if (administrator && planning) { planning.mount(); await planning.refresh(people, planningRange, signal) }
      if (!current(version, signal)) return
      if (scheduleManager && placeholders) await placeholders.refresh({ signal, range: planningRange, weeks: report.week_starts, people, projects: directory.filter(row => row.is_active), administrator })
      if (current(version, signal)) status.textContent = ''
    } catch (error) {
      if (!current(version, signal)) return
      const refused = error instanceof EzactoApiError && (error.status === 401 || error.status === 403)
      if (refused) clear()
      grid.replaceChildren(); timeline.replaceChildren(); planning?.unmount(); placeholders?.clear(); more.hidden = true
      status.textContent = refused ? 'Calendar access is unavailable. Sign in again or retry.' : error instanceof Error ? error.message : 'The calendar could not be loaded.'; retry.hidden = false
    }
  }
  const move = (delta: number) => { offset = delta === 0 ? 0 : offset + delta; void load() }
  find<HTMLButtonElement>('[data-capacity-previous]').addEventListener('click', () => move(-1))
  find<HTMLButtonElement>('[data-capacity-next]').addEventListener('click', () => move(1))
  find<HTMLButtonElement>('[data-capacity-current]').addEventListener('click', () => move(0))
  retry.addEventListener('click', () => void load())
  const resetPeople = () => { peopleOptions.clear(); person.value = ''; fillPeople() }
  scope.addEventListener('change', () => { resetPeople(); project.parentElement!.hidden = scope.value !== 'project'; void load() })
  project.addEventListener('change', () => { resetPeople(); void load() })
  person.addEventListener('change', () => void load())
  mode.addEventListener('change', draw)
  more.addEventListener('click', async () => {
    const signal = operation?.signal, version = generation, cursor = nextCursor, selectedQuery = query
    if (!signal || !selectedQuery || !cursor || !report || paging || !current(version, signal)) return
    paging = true; more.disabled = true; status.textContent = 'Loading more people…'
    try {
      if (seenCursors.has(cursor)) throw new Error('The calendar returned a repeated page. Refresh the calendar.')
      const response = await api.read(selectedQuery, cursor, signal)
      if (!current(version, signal)) return
      if (response.data.view !== report.view || JSON.stringify(response.data.week_starts) !== JSON.stringify(report.week_starts) || response.data.people.some(person => report!.people.some(previous => previous.person_id === person.person_id))) throw new Error('The calendar changed while paging. Refresh the calendar.')
      seenCursors.add(cursor)
      report = { ...report, people: [...report.people, ...response.data.people], has_other_scope: report.has_other_scope || response.data.has_other_scope }
      for (const row of response.data.people) peopleOptions.set(row.person_id, row.name); fillPeople()
      nextCursor = response.page.next_cursor; status.textContent = ''; draw()
    } catch (error) {
      if (!current(version, signal)) return
      const refused = error instanceof EzactoApiError && (error.status === 401 || error.status === 403)
      if (refused) { clear(); retry.hidden = false }
      status.textContent = refused ? 'Calendar access is unavailable. Sign in again or retry.' : error instanceof Error ? error.message : 'More people could not be loaded.'
    } finally { if (current(version, signal)) { paging = false; more.disabled = false } }
  })
  return {
    async activate(signal: AbortSignal, options: { administrator?: boolean; scheduleManager?: boolean } = {}) {
      const nextAdministrator = options.administrator === true, nextManager = nextAdministrator || options.scheduleManager === true
      if (active !== signal || administrator !== nextAdministrator || scheduleManager !== nextManager) { clear(); offset = 0 }
      release?.(); active = signal; administrator = nextAdministrator; scheduleManager = nextManager
      const abort = () => { if (active === signal) { clear(); active = null } }
      signal.addEventListener('abort', abort, { once: true }); release = () => signal.removeEventListener('abort', abort)
      if (signal.aborted) { abort(); return }
      await load()
    },
  }
}
