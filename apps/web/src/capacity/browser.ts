import { renderDataTable, type CellContent } from '../components/data-table.js'
import { EzactoApiError } from '@conflict-hq/ezacto-client'
import {
  addCalendarDays,
  capacityCellText,
  capacityRange,
  shortDate,
  weekHeading,
  type CapacityApi,
  type CapacityData,
  type CapacityPersonData,
} from './model.js'
import { createPlanningEntry } from './planning-browser.js'
import { createPlaceholderPlanningController } from './placeholders-browser.js'

export interface CapacityController {
  activate(signal: AbortSignal, options?: { readonly administrator?: boolean; readonly scheduleManager?: boolean }): Promise<void>
}

const required = <ElementType extends Element>(selector: string): ElementType => {
  const element = document.querySelector<ElementType>(selector)
  if (element === null) throw new Error(`capacity element missing: ${selector}`)
  return element
}

const localToday = (): string => {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

const cell = (person: CapacityPersonData, weekStart: string): CellContent => {
  const week = person.weeks.find((candidate) => candidate.week_start === weekStart)
  if (week === undefined) return ''
  const text = capacityCellText(week)
  const wrapper = document.createElement('span')
  wrapper.className = 'capacity-cell'
  if (text.flag !== null) wrapper.dataset.overAllocated = 'true'
  const main = document.createElement('strong')
  main.textContent = text.main
  const detail = document.createElement('span')
  detail.textContent = text.detail
  wrapper.append(main, detail)
  if (text.timeOff !== null) {
    const away = document.createElement('span')
    away.textContent = text.timeOff
    wrapper.append(away)
  }
  if (text.flag !== null) {
    const flag = document.createElement('em')
    flag.textContent = text.flag
    wrapper.append(flag)
  }
  return wrapper
}

export const createCapacityController = (api: CapacityApi): CapacityController => {
  const page = document.querySelector<HTMLElement>('[data-capacity-page]')
  if (page === null) return { activate: async () => {} }
  const label = required<HTMLElement>('[data-capacity-label]')
  const status = required<HTMLElement>('[data-capacity-status]')
  const grid = required<HTMLElement>('[data-capacity-grid]')
  const retry = required<HTMLButtonElement>('[data-capacity-retry]')
  const previous = required<HTMLButtonElement>('[data-capacity-previous]')
  const next = required<HTMLButtonElement>('[data-capacity-next]')
  const current = required<HTMLButtonElement>('[data-capacity-current]')

  const planningHost = page.querySelector<HTMLElement>('[data-capacity-planning]')
  const placeholderHost = page.querySelector<HTMLElement>('[data-capacity-placeholders]')
  const placeholders = api.placeholders && placeholderHost
    ? createPlaceholderPlanningController(placeholderHost, api.placeholders, () => void load()) : null
  const planning =
    api.planning === undefined || planningHost === null
      ? null
      : createPlanningEntry(planningHost, api.planning, () => void load())

  let active: AbortSignal | null = null
  let releaseActivation: (() => void) | null = null
  let windows = 0
  let administrator = false
  let scheduleManager = false
  let readRevision = 0

  const render = (report: CapacityData): void => {
    const first = report.weeks[0]
    const last = report.weeks[report.weeks.length - 1]
    label.textContent =
      first === undefined || last === undefined ? '—' : `${shortDate(first)} to ${shortDate(last)}`
    grid.replaceChildren(
      renderDataTable<CapacityPersonData>({
        caption: 'Capacity by person and week',
        table: 'capacity',
        defaultSort: { column: 'person', direction: 'ascending' },
        rows: [...report.people],
        rowKey: (person) => String(person.user_id),
        empty: 'No one to show for these weeks.',
        columns: [
          {
            key: 'person',
            label: 'Person',
            sortValue: (person) => `${person.first_name} ${person.last_name}`,
            render: (person) => `${person.first_name} ${person.last_name}`,
          },
          ...report.weeks.map((weekStart) => ({
            key: `week-${weekStart}`,
            label: weekHeading(weekStart),
            sortDescription: `Sort people by planned hours for ${weekHeading(weekStart)}`,
            sortValue: (person: CapacityPersonData) => person.weeks.find(week => week.week_start === weekStart)?.planned_seconds ?? null,
            render: (person: CapacityPersonData) => cell(person, weekStart),
          })),
        ],
      }),
    )
  }

  const load = async (): Promise<void> => {
    const signal = active
    if (signal === null || signal.aborted) return
    const request = ++readRevision
    status.textContent = 'Loading capacity…'
    retry.hidden = true
    try {
      const range = capacityRange(localToday(), windows)
      const response = await api.getCapacity(range, signal)
      if (signal.aborted || active !== signal || request !== readRevision) return
      render(response.data)
      status.textContent = ''
      const planningRange = { from: response.data.weeks[0] ?? range.from,
        to: response.data.weeks.length ? addCalendarDays(response.data.weeks.at(-1)!, 6) : range.to }
      const people = response.data.people.map(person => ({ id: person.user_id, name: `${person.first_name} ${person.last_name}` }))
      await Promise.all([planning?.refresh(
        response.data.people.map((person) => ({
          id: person.user_id,
          name: `${person.first_name} ${person.last_name}`,
        })),
        // Entry lists cover the same complete weeks as the capacity grid.
        planningRange,
        signal,
      ), (async () => {
        if (!scheduleManager || !placeholders) return
        const projects = administrator && api.planning ? await api.planning.listProjects(signal) : []
        if (signal.aborted || active !== signal || request !== readRevision) return
        await placeholders.refresh({ signal, range: planningRange, weeks: response.data.weeks, people, projects, administrator })
      })()])
    } catch (error) {
      if (signal.aborted || active !== signal || request !== readRevision) return
      grid.replaceChildren()
      if (error instanceof EzactoApiError && (error.status === 401 || error.status === 403)) placeholders?.clear()
      retry.hidden = false
      status.textContent = error instanceof Error ? error.message : 'Capacity could not be loaded.'
    }
  }

  const move = (delta: number): void => {
    windows = delta === 0 ? 0 : windows + delta
    void load()
  }
  previous.addEventListener('click', () => move(-1))
  next.addEventListener('click', () => move(1))
  current.addEventListener('click', () => move(0))
  retry.addEventListener('click', () => void load())

  return {
    async activate(signal, options = {}) {
      if (active !== signal) {
        releaseActivation?.()
        planning?.unmount()
        placeholders?.clear()
        grid.replaceChildren()
        label.textContent = '—'
        status.textContent = ''
        retry.hidden = true
        windows = 0
      }
      active = signal
      if (administrator !== (options.administrator === true)) placeholders?.clear()
      administrator = options.administrator === true
      scheduleManager = administrator || options.scheduleManager === true
      const clear = (): void => {
        if (active !== signal) return
        active = null
        planning?.unmount()
        placeholders?.clear()
        readRevision++
        grid.replaceChildren()
        label.textContent = '—'
        status.textContent = ''
        retry.hidden = true
      }
      releaseActivation?.()
      signal.addEventListener('abort', clear, { once: true })
      releaseActivation = () => signal.removeEventListener('abort', clear)
      if (signal.aborted) { clear(); return }
      // Entry is for an administrator only; anyone else gets no control at all.
      if (options.administrator === true) planning?.mount()
      else planning?.unmount()
      if (!scheduleManager) placeholders?.clear()
      if (page.hidden) return
      await load()
    },
  }
}
