import { EzactoApiError, type ActivityLogActor } from '@conflict-hq/ezacto-client'
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

export interface ActivityQuery {
  readonly from?: string
  readonly to?: string
  readonly event_type?: string
  readonly actor_id?: number
  readonly aggregate_type?: string
  readonly aggregate_id?: number
  /** Where the previous page ended; absent on the first page. */
  readonly cursor?: string
}

/** The filters the export honours: the list's, without a place in the traversal. */
export type ActivityExportQuery = Omit<ActivityQuery, 'cursor'>

export interface ActivityApi {
  listActivityLog(
    query: ActivityQuery,
    signal?: AbortSignal,
  ): Promise<{
    readonly data: readonly ActivityRow[]
    readonly page?: { readonly next_cursor: string | null }
  }>
  /** The filtered view as a file. Absent where the build cannot export, which hides the button. */
  exportActivityLog?(
    query: ActivityExportQuery,
    signal?: AbortSignal,
  ): Promise<{ readonly blob: Blob; readonly filename: string; readonly truncated: boolean }>
  /** The people the actor picker offers. Absent where the build cannot list them. */
  listActors?(signal?: AbortSignal): Promise<readonly { readonly id: number; readonly name: string }[]>
}

export interface ActivityViewer {
  /**
   * Whether the reader may open the records the log points at. The records
   * behind these links are an administrator's to open, so anyone else sees the
   * subject named and no link to a page that would refuse them.
   */
  readonly administrator: boolean
}

export interface ActivityController {
  activate(signal: AbortSignal, viewer?: ActivityViewer): Promise<void>
}

/** What the event picker suggests. A suggestion, not a limit: any event type can be typed. */
export const KNOWN_ACTIVITY_EVENT_TYPES: readonly string[] = [
  'auth.signed_in',
  'auth.signed_out',
  'api_token.created',
  'api_token.revoked',
  'backup.exported',
  'backup.restored',
  'account.deletion_requested',
  'timesheet.submitted',
  'timesheet.approved',
  'timesheet.rejected',
  'timesheet.withdrawn',
  'timesheet.locked',
  'timesheet.unlocked',
  'invoice.created',
]

/** The kinds of record an entry can be about, with the words the picker uses. */
export const ACTIVITY_ENTITY_KINDS: readonly (readonly [type: string, label: string])[] = [
  ['invoice', 'Invoice'],
  ['timesheet_submission', 'Timesheet approval'],
  ['timesheet_lock', 'Timesheet lock'],
  ['user_authentication', 'Sign-in'],
  ['api_token', 'API token'],
  ['backup_run', 'Backup'],
  ['backup_restore', 'Restore'],
  ['user_account', 'Account'],
]

/**
 * Where a subject lives, for the kinds that have a page of their own. A
 * timesheet approval is a row in the approvals queue and has no page per
 * submission, so it points at the queue.
 */
export const subjectHref = (aggregate: { readonly type: string; readonly id: number }): string | null => {
  switch (aggregate.type) {
    case 'invoice':
      return `/invoices/by-id/${aggregate.id}`
    case 'timesheet_submission':
      return '/approvals'
    case 'user_authentication':
    case 'user_account':
      return `/team/${aggregate.id}`
    default:
      return null
  }
}

const subjectCell = (aggregate: ActivityRow['aggregate'], linked: boolean): CellContent => {
  const label = `${aggregate.type} #${aggregate.id}`
  const href = linked ? subjectHref(aggregate) : null
  if (href === null) return label
  const link = document.createElement('a')
  link.href = href
  link.textContent = label
  return link
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

export const isModuleDisabled = (error: unknown): boolean => {
  if (!(error instanceof EzactoApiError) || error.status !== 403) return false
  if (typeof error.body !== 'object' || error.body === null) return false
  const detail: unknown = Reflect.get(error.body, 'error')
  return typeof detail === 'object' && detail !== null && Reflect.get(detail, 'code') === 'module_disabled'
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
  const typeSuggestions = required<HTMLElement>('[data-activity-type-options]')
  const actor = required('[data-activity-actor]') as unknown as HTMLInputElement
  const entity = required('[data-activity-entity]') as unknown as HTMLInputElement
  const entityId = required<HTMLInputElement>('[data-activity-entity-id]')
  const clear = required<HTMLButtonElement>('[data-activity-clear]')
  const exportButton = required<HTMLButtonElement>('[data-activity-export]')
  const more = required<HTMLButtonElement>('[data-activity-more]')
  const controls = [from, to, type, actor, entity, entityId, clear, exportButton, more]
  exportButton.hidden = api.exportActivityLog === undefined

  typeSuggestions.replaceChildren(
    ...KNOWN_ACTIVITY_EVENT_TYPES.map((value) => {
      const suggestion = document.createElement('option')
      suggestion.value = value
      return suggestion
    }),
  )
  entity.replaceChildren(
    ...[['', 'Anything'] as const, ...ACTIVITY_ENTITY_KINDS].map(([value, label]) => {
      const choice = document.createElement('option')
      choice.value = value
      choice.textContent = label
      return choice
    }),
  )

  let active: AbortSignal | null = null
  let viewer: ActivityViewer = { administrator: false }
  let shown: ActivityRow[] = []
  let nextCursor: string | null = null
  let actorsLoaded = false

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
            render: (row) => subjectCell(row.aggregate, viewer.administrator),
          },
        ],
      }),
    )
  }

  const filters = (): ActivityQuery => ({
    ...(from.value === '' ? {} : { from: from.value }),
    ...(to.value === '' ? {} : { to: to.value }),
    ...(type.value.trim() === '' ? {} : { event_type: type.value.trim() }),
    ...(actor.value === '' ? {} : { actor_id: Number(actor.value) }),
    ...(entity.value === '' ? {} : { aggregate_type: entity.value }),
    // An id with no kind names no record, so it is not sent on its own.
    ...(entity.value === '' || entityId.value === ''
      ? {}
      : { aggregate_id: Number(entityId.value) }),
  })

  const loadActors = async (signal: AbortSignal): Promise<void> => {
    if (actorsLoaded || api.listActors === undefined) return
    actorsLoaded = true
    try {
      const people = await api.listActors(signal)
      if (signal.aborted) return
      const anyone = document.createElement('option')
      anyone.value = ''
      anyone.textContent = 'Anyone'
      actor.replaceChildren(
        anyone,
        ...people.map((person) => {
          const choice = document.createElement('option')
          choice.value = String(person.id)
          choice.textContent = person.name
          return choice
        }),
      )
    } catch {
      // The picker stays at "Anyone"; the log itself is unaffected.
      actorsLoaded = false
    }
  }

  /** A new filter starts a new traversal; "Load more" continues the current one. */
  const load = async (append = false): Promise<void> => {
    const signal = active
    if (signal === null) return
    status.textContent = 'Loading activity…'
    try {
      // Empty inputs are omitted rather than sent blank: the API validates a
      // bound it is given, and "" is not a date, so sending it would turn an
      // untouched filter into a 422.
      const page = await api.listActivityLog(
        { ...filters(), ...(append && nextCursor !== null ? { cursor: nextCursor } : {}) },
        signal,
      )
      if (signal.aborted) return
      shown = append ? [...shown, ...page.data] : [...page.data]
      nextCursor = page.page?.next_cursor ?? null
      more.hidden = nextCursor === null
      render(shown)
      status.textContent =
        shown.length === 0 ? '' : `${shown.length} ${shown.length === 1 ? 'entry' : 'entries'}.`
    } catch (error) {
      if (signal.aborted) return
      // The log is what you read when something has gone wrong, so a failure to
      // read it says so plainly rather than rendering an empty table that looks
      // like a quiet period.
      list.replaceChildren()
      more.hidden = true
      // A switched-off module is a decision, not a failure, and its own words
      // say so; the filters have nothing left to filter.
      if (isModuleDisabled(error)) {
        for (const control of controls) control.disabled = true
        status.textContent = 'The Activity log module is switched off for this organization.'
        return
      }
      status.textContent =
        error instanceof Error ? error.message : 'Activity could not be loaded.'
    }
  }

  for (const control of [from, to, type, actor, entity, entityId]) {
    control.addEventListener('change', () => void load())
  }
  more.addEventListener('click', () => void load(true))
  // The file holds the filters as they stand now, not the page already drawn:
  // the export walks the log itself, so "Load more" is not a precondition.
  exportButton.addEventListener('click', () => {
    const signal = active
    const download = api.exportActivityLog
    if (signal === null || download === undefined) return
    status.textContent = 'Preparing the export…'
    void download(filters(), signal)
      .then(({ blob, filename, truncated }) => {
        if (signal.aborted) return
        const href = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = href
        link.download = filename
        link.click()
        // On the next task: revoking at once can cancel the download.
        setTimeout(() => URL.revokeObjectURL(href), 0)
        status.textContent = truncated
          ? `Downloaded ${filename}. The file holds only the newest entries; narrow the period or the filters to export the rest.`
          : `Downloaded ${filename}.`
      })
      .catch((error: unknown) => {
        if (signal.aborted) return
        if (isModuleDisabled(error)) {
          for (const control of controls) control.disabled = true
          status.textContent = 'The Activity log module is switched off for this organization.'
          return
        }
        status.textContent = error instanceof Error ? error.message : 'The export could not be prepared.'
      })
  })
  clear.addEventListener('click', () => {
    for (const control of [from, to, type, entityId]) control.value = ''
    for (const control of [actor, entity]) control.value = ''
    void load()
  })

  return {
    async activate(signal, presentedViewer) {
      active = signal
      viewer = presentedViewer ?? { administrator: false }
      if (page.hidden) return
      await Promise.all([load(), loadActors(signal)])
    },
  }
}
