import type { ActivityLogActor } from '@conflict-hq/ezacto-client'
import { renderDataTable, type CellContent } from '../components/data-table.js'

export interface ActivityRow {
  readonly event_id: string
  readonly event_type: string
  readonly aggregate: { readonly type: string; readonly id: number }
  /** Named by the server, so this page and an export agree (issue 862). */
  readonly actor: ActivityLogActor | null
  readonly occurred_at: string
  readonly recorded_at: string
}

export interface ActivityApi {
  listActivityLog(
    query: {
      readonly from?: string
      readonly to?: string
      readonly event_type?: string
    },
    signal?: AbortSignal,
  ): Promise<{ readonly data: readonly ActivityRow[] }>
}

export interface ActivityController {
  activate(signal: AbortSignal): Promise<void>
}

const required = <ElementType extends Element>(selector: string): ElementType => {
  const element = document.querySelector<ElementType>(selector)
  if (element === null) throw new Error(`activity element missing: ${selector}`)
  return element
}

/**
 * Who caused an event, in words.
 *
 * A system event carries no actor id, and it must not read as though a person
 * did it: the nightly export is not something the administrator who configured
 * the schedule performed at three in the morning. So `system` is named as
 * itself rather than resolved to whoever set it up.
 *
 * Anyone else is named (issue 862), and keeps the id as the cell's title so
 * two people who share a name can still be told apart. An id nobody carries
 * any more, such as a deleted contact's, reads as the id: it is all the log
 * still knows, and better than a blank.
 */
const actorCell = (actor: ActivityLogActor | null): CellContent => {
  if (actor?.type === 'system') return 'System'
  if (actor === null || actor.id === null) return 'Unknown'
  const reference = `${actor.type === 'contact' ? 'Contact' : 'User'} #${actor.id}`
  if (actor.name === null) return reference
  const name = document.createElement('span')
  name.textContent = actor.name
  name.title = reference
  return name
}

/** `api_token.created` reads as "Api token created" without a lookup table to drift. */
const eventLabel = (eventType: string): string => {
  const words = eventType.replace(/[._]/gu, ' ')
  return words.charAt(0).toLocaleUpperCase('en-US') + words.slice(1)
}

export const createActivityController = (api: ActivityApi): ActivityController => {
  const page = document.querySelector<HTMLElement>('[data-activity-log-page]')
  if (page === null) return { activate: async () => {} }
  const list = required<HTMLElement>('[data-activity-log-list]')
  const status = required<HTMLElement>('[data-activity-log-status]')
  const from = required<HTMLInputElement>('[data-activity-from]')
  const to = required<HTMLInputElement>('[data-activity-to]')
  // Not `required<HTMLSelectElement>`: the worker's tsconfig uses workers-types,
  // where HTMLSelectElement does not satisfy the DOM `Element` this generic is
  // constrained to. Narrowed at the use site instead, which is the same check
  // one layer down and compiles under both lib sets.
  const type = required('[data-activity-type]') as unknown as HTMLInputElement

  let active: AbortSignal | null = null

  const render = (rows: readonly ActivityRow[]): void => {
    list.replaceChildren(
      renderDataTable<ActivityRow>({
        caption: 'Activity',
        rows: [...rows],
        rowKey: (row) => row.event_id,
        empty: 'Nothing matches these filters.',
        columns: [
          { key: 'when', label: 'When', fit: true, render: (row) => row.occurred_at },
          { key: 'event', label: 'Event', render: (row) => eventLabel(row.event_type) },
          { key: 'who', label: 'Who', render: (row) => actorCell(row.actor) },
          {
            key: 'subject',
            label: 'Subject',
            render: (row) => `${row.aggregate.type} #${row.aggregate.id}`,
          },
        ],
      }),
    )
  }

  const load = async (): Promise<void> => {
    const signal = active
    if (signal === null) return
    status.textContent = 'Loading activity…'
    try {
      // Empty inputs are omitted rather than sent blank: the API validates a
      // bound it is given, and "" is not a date, so sending it would turn an
      // untouched filter into a 422.
      const page = await api.listActivityLog(
        {
          ...(from.value === '' ? {} : { from: from.value }),
          ...(to.value === '' ? {} : { to: to.value }),
          ...(type.value === '' ? {} : { event_type: type.value }),
        },
        signal,
      )
      if (signal.aborted) return
      render(page.data)
      status.textContent =
        page.data.length === 0
          ? ''
          : `${page.data.length} ${page.data.length === 1 ? 'entry' : 'entries'}.`
    } catch (error) {
      if (signal.aborted) return
      // The log is what you read when something has gone wrong, so a failure to
      // read it says so plainly rather than rendering an empty table that looks
      // like a quiet period.
      list.replaceChildren()
      status.textContent =
        error instanceof Error ? error.message : 'Activity could not be loaded.'
    }
  }

  for (const control of [from, to, type]) {
    control.addEventListener('change', () => void load())
  }

  return {
    async activate(signal) {
      active = signal
      if (page.hidden) return
      await load()
    },
  }
}
