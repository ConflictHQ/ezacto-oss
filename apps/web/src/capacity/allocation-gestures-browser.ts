import { EzactoApiError } from '@conflict-hq/ezacto-client'
import { addCalendarDays, hoursText, type AllocationRow, type PlanningApi } from './model.js'
import { allocationReviewPage, allocationReviewWeeks, gestureDates, previewAllocationWeeks, validAllocationDates, type AllocationDates, type AllocationGesture } from './allocation-gesture-model.js'
import type { CalendarAllocation, CalendarQuery, ResourceCalendarApi } from './resource-calendar-model.js'

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
  const result = document.createElement(tag)
  if (text !== undefined) result.textContent = text
  return result
}

/** Planning-only date commands. Pointer motion changes a ghost, never the destination. */
export const createAllocationGestures = (host: HTMLElement, calendar: ResourceCalendarApi, planning: PlanningApi, saved: (allocationId: number) => void, refused: () => void) => {
  let lifetime = new AbortController(), editor: AbortController | null = null
  let restoreGhost: (() => void) | null = null
  const close = (focus = true) => {
    editor?.abort(); editor = null
    restoreGhost?.(); restoreGhost = null
    const trigger = returnFocus; returnFocus = null
    host.replaceChildren()
    if (focus && trigger?.isConnected) trigger.focus()
  }
  let returnFocus: HTMLElement | null = null
  const reset = () => { lifetime.abort(); lifetime = new AbortController(); close(false) }
  const open = async (allocation: CalendarAllocation, dates: AllocationDates, trigger: HTMLElement, session: AbortSignal) => {
    close(false)
    if (session.aborted || !planning.getAllocation) return
    const current = new AbortController(); editor = current; returnFocus = trigger
    const abort = () => close(false)
    session.addEventListener('abort', abort, { once: true })
    current.signal.addEventListener('abort', () => session.removeEventListener('abort', abort), { once: true })
    const live = () => editor === current && !current.signal.aborted && !session.aborted
    const heading = node('h3', `Review allocation dates · ${allocation.project_name}`)
    const form = node('form'); form.className = 'capacity-form allocation-date-review'; form.dataset.allocationDateReview = ''
    form.setAttribute('aria-label', 'Review allocation dates')
    const status = node('p', 'Reading the current allocation…'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite')
    const field = (name: string, value: string) => {
      const label = node('label', name), input = node('input'); input.type = 'date'; input.value = value; input.required = true
      label.append(input); form.append(label); return input
    }
    const start = field('New start date', dates.start_date), end = field('New end date', dates.end_date)
    const explanation = node('p', `${hoursText(allocation.planned_seconds_per_week)} (${allocation.planned_seconds_per_week} seconds) per touched week. Date changes keep this full weekly amount; edit weekly hours in the allocation form.`)
    const preview = node('div'); preview.dataset.allocationDatePreview = ''
    const button = (text: string) => { const result = node('button', text); result.type = 'button'; form.append(result); return result }
    const review = button('Preview dates'), next = button('Review next weeks'), save = button('Save date change'), cancel = button('Cancel date change')
    review.disabled = true; save.disabled = true; next.hidden = true
    form.append(explanation, preview, status); host.replaceChildren(heading, form)
    let source: AllocationRow | null = null, weeks: string[] = [], offset = 0, revision: string | null = null
    let reviewed: AllocationDates | null = null, command: { key: string; dates: AllocationDates; version: number } | null = null
    let busy = false, stale = false, submitted = false, previewEpoch = 0
    const values = () => ({ start_date: start.value, end_date: end.value })
    const invalidate = () => {
      previewEpoch++
      reviewed = null; weeks = []; offset = 0; revision = null; save.disabled = true; next.hidden = true; preview.replaceChildren()
      status.textContent = 'Preview the changed dates before saving.'
    }
    start.addEventListener('input', invalidate); end.addEventListener('input', invalidate)
    cancel.addEventListener('click', () => close())
    form.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); if (!submitted || !busy) close() } })
    const showFailure = (error: unknown) => {
      if (!live()) return
      if (error instanceof EzactoApiError && [401, 403].includes(error.status)) { close(false); refused(); return }
      const conflict = error instanceof EzactoApiError && error.status === 409
      if (conflict) { stale = true; save.disabled = true; review.disabled = true; next.hidden = true }
      status.textContent = conflict
        ? 'The saved allocation changed or this command cannot be replayed. Your dates are kept. Cancel and refresh the calendar before retrying.'
        : error instanceof Error ? error.message : 'The date change could not be completed.'
    }
    const readPage = async () => {
      if (!source || !reviewed || busy || stale || !live()) return
      const epoch = previewEpoch, candidate = reviewed
      busy = true; review.disabled = true; next.disabled = true; save.disabled = true; status.textContent = 'Reading whole-person availability…'
      try {
        const page = allocationReviewPage(weeks, offset)
        const response = await calendar.read({ view: 'team', person_id: source.user_id, from: page[0]!, to: addCalendarDays(page.at(-1)!, 6) }, undefined, current.signal)
        if (!live() || epoch !== previewEpoch) return
        if (response.page.next_cursor !== null || (revision !== null && revision !== response.data.revision)) throw new Error('The calendar changed while reviewing. Preview the dates again.')
        revision = response.data.revision
        const rows = previewAllocationWeeks(source, candidate, page, response.data)
        const table = node('table'); table.className = 'data-table'; table.append(node('caption', `Affected weeks ${offset + 1}–${offset + page.length} of ${weeks.length}`))
        const head = node('thead'), labels = node('tr')
        for (const label of ['Week starting', 'This allocation', 'All work planned', 'Available', 'Warning']) { const th = node('th', label); th.scope = 'col'; labels.append(th) }
        head.append(labels); table.append(head)
        const body = node('tbody')
        for (const row of rows) {
          const tr = node('tr')
          for (const text of [row.week, `${hoursText(row.allocationSeconds)} (${row.allocationSeconds}s)`, `${hoursText(row.personSeconds)} (${row.personSeconds}s)`, `${hoursText(row.availableSeconds)} (${row.availableSeconds}s)`, row.overAllocated ? 'Over-allocated — warning only' : 'Within availability']) tr.append(node('td', text))
          body.append(tr)
        }
        table.append(body); const scroll = node('div'); scroll.className = 'data-table-scroll'; scroll.tabIndex = 0; scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', 'Allocation availability preview'); scroll.append(table); preview.replaceChildren(scroll)
        offset += page.length; next.hidden = offset === weeks.length; save.disabled = offset !== weeks.length
        status.textContent = offset === weeks.length ? 'All affected weeks reviewed. Over-allocation is a warning; no actual time or money will change.' : 'Review the remaining weeks before saving.'
      } catch (error) { if (epoch === previewEpoch) { showFailure(error); reviewed = null; next.hidden = true } }
      finally { if (live()) { busy = false; review.disabled = stale || submitted; next.disabled = false } }
    }
    review.addEventListener('click', () => {
      if (busy || stale || submitted || !source || !live()) return
      if (!validAllocationDates(values())) { status.textContent = 'Choose a valid ordered date range.'; return }
      if (start.value === source.start_date && end.value === source.end_date) { status.textContent = 'The dates are unchanged.'; return }
      reviewed = values(); weeks = allocationReviewWeeks(source, reviewed, contextDay); offset = 0; revision = null
      void readPage()
    })
    form.addEventListener('submit', event => { event.preventDefault(); review.click() })
    next.addEventListener('click', () => void readPage())
    save.addEventListener('click', async () => {
      if (busy || stale || !source || !reviewed || offset !== weeks.length || !live() || save.disabled) return
      command ??= { key: crypto.randomUUID(), dates: reviewed, version: source.version }
      submitted = true; busy = true; start.disabled = true; end.disabled = true; review.disabled = true; next.hidden = true; save.disabled = true; cancel.disabled = true
      status.textContent = 'Saving allocation dates…'
      try {
        await planning.updateAllocation(source.id, { ...command.dates, version: command.version }, current.signal, command.key)
        if (!live()) return
        close(false); saved(source.id)
      } catch (error) { showFailure(error); if (live() && !stale) { save.textContent = 'Retry same date change'; save.disabled = false } }
      finally { if (live()) { busy = false; cancel.disabled = false } }
    })
    let contextDay: 'saturday' | 'sunday' | 'monday' = 'monday'
    try {
      const [fresh, context] = await Promise.all([planning.getAllocation(allocation.id, current.signal), calendar.context(current.signal)])
      if (!live()) return
      if (fresh.version !== allocation.version || fresh.user_id !== allocation.user_id || fresh.project_id !== allocation.project_id || fresh.start_date !== allocation.start_date || fresh.end_date !== allocation.end_date || fresh.planned_seconds_per_week !== allocation.planned_seconds_per_week) throw new EzactoApiError(409, { error: { code: 'allocation_changed', message: 'The allocation changed.' } }, null)
      source = fresh; contextDay = context.data.week_start_day; review.disabled = false; status.textContent = 'Preview the changed dates before saving.'; start.focus()
    } catch (error) { showFailure(error) }
  }
  const attach = (item: HTMLElement, track: HTMLElement, bar: HTMLElement, allocation: CalendarAllocation, query: CalendarQuery, session: AbortSignal) => {
    if (!planning.getAllocation || session.aborted) return
    const actions = node('div'); actions.className = 'allocation-date-actions'; actions.setAttribute('aria-label', 'Allocation date actions')
    let suppressClick = false
    const bind = (target: HTMLElement, action: AllocationGesture) => {
      target.addEventListener('pointerdown', event => {
        if (event.button !== 0 || !event.isPrimary || session.aborted || editor) return
        suppressClick = false
        const width = track.getBoundingClientRect().width
        if (width <= 0) return
        const totalDays = (Date.parse(query.to) - Date.parse(query.from)) / 86_400_000 + 1
        const startX = event.clientX, startY = event.clientY, pointer = event.pointerId, drag = new AbortController()
        let moving = false, days = 0
        const originalMargin = bar.style.marginInlineStart, originalWidth = bar.style.width
        const restore = () => { bar.style.marginInlineStart = originalMargin; bar.style.width = originalWidth; delete bar.dataset.gesturePreview }
        restoreGhost?.(); restoreGhost = restore
        const stop = () => { drag.abort(); restore(); if (restoreGhost === restore) restoreGhost = null }
        const abort = () => stop()
        lifetime.signal.addEventListener('abort', abort, { once: true }); session.addEventListener('abort', abort, { once: true })
        drag.signal.addEventListener('abort', () => { lifetime.signal.removeEventListener('abort', abort); session.removeEventListener('abort', abort) }, { once: true })
        document.addEventListener('pointermove', next => {
          if (next.pointerId !== pointer) return
          const dx = next.clientX - startX, dy = next.clientY - startY
          if (!moving && Math.abs(dy) > 8 && Math.abs(dy) >= Math.abs(dx)) { stop(); return }
          if (!moving && Math.abs(dx) < 8) return
          moving = true; next.preventDefault(); days = Math.round(dx / width * totalDays)
          if (!Number.isSafeInteger(days) || Math.abs(days) > 3_650_000) return
          const candidate = gestureDates(allocation, action, days)
          if (!validAllocationDates(candidate)) return
          const day = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000
          const start = Math.max(day(candidate.start_date), day(query.from)), end = Math.min(day(candidate.end_date), day(query.to))
          bar.style.marginInlineStart = `${(start - day(query.from)) / totalDays * 100}%`; bar.style.width = `${Math.max(0, end - start + 1) / totalDays * 100}%`; bar.dataset.gesturePreview = 'true'
        }, { signal: drag.signal, passive: false })
        document.addEventListener('pointerup', next => {
          if (next.pointerId !== pointer) return
          stop()
          if (!moving || !days || session.aborted) return
          suppressClick = true; setTimeout(() => { suppressClick = false }, 0)
          if (!Number.isSafeInteger(days) || Math.abs(days) > 3_650_000) return
          const dates = gestureDates(allocation, action, days)
          if (validAllocationDates(dates)) void open(allocation, dates, target, session)
        }, { signal: drag.signal })
        document.addEventListener('pointercancel', next => { if (next.pointerId === pointer) stop() }, { signal: drag.signal })
        document.addEventListener('keydown', key => { if (key.key === 'Escape') { suppressClick = true; stop(); target.focus() } }, { signal: drag.signal })
        document.addEventListener('scroll', stop, { signal: drag.signal, capture: true, once: true })
      }, { signal: lifetime.signal })
    }
    for (const [action, label] of [['move', 'Move dates'], ['start', 'Resize start'], ['end', 'Resize end']] as const) {
      const button = node('button', label); button.type = 'button'; button.dataset.allocationGesture = action
      button.addEventListener('click', event => { if (suppressClick && event.detail > 0) { suppressClick = false; return } void open(allocation, allocation, button, session) }, { signal: lifetime.signal })
      bind(button, action); actions.append(button)
    }
    bind(bar, 'move'); item.append(actions)
  }
  return { reset, attach }
}
