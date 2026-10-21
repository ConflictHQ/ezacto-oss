import { apiErrorMessage } from '../module-settings/model.js'
import {
  EzactoApiError,
  type ClientRateCard,
  type ClientRateCardVersionInput,
  type GeneralResource,
  type Whoami,
} from '@conflict-hq/ezacto-client'
import { rateCardMaxAmountCents, rateCardMaxLines } from '@ezacto/core'
import { canManageClientTerms } from '../commercial-terms.js'
import { renderDataTable } from '../components/data-table.js'
import { markMoney } from '../money-display.js'
import { parseTeamMoneyCents } from '../team/model.js'
import { clientMoney, clientProfileCanWrite } from './model.js'

import type { ClientRateCardApi } from './rate-card-model.js'
export type { ClientRateCardApi } from './rate-card-model.js'

export interface RateCardContext {
  identity: Whoami
  signal: AbortSignal
  client: GeneralResource
  clients: readonly GeneralResource[]
  failed(error: unknown, paint: () => void): void
}
const dateValid = (date: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(date) &&
  !Number.isNaN(Date.parse(date)) &&
  new Date(date).toISOString().slice(0, 10) === date
const notFound = (error: unknown): boolean =>
  error instanceof EzactoApiError && error.status === 404
const errorText = (error: unknown): string =>
  apiErrorMessage(error, 'The rate card could not be loaded.')
const decimal = (cents: number): string =>
  `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`

export const createClientRateCardController = (
  api: ClientRateCardApi,
): { activate(context: RateCardContext): Promise<void> } => {
  const section = document.querySelector<HTMLElement>('[data-client-rate-card]')
  if (!section) return { activate: async () => {} }
  const query = <T extends Element>(selector: string): T => section.querySelector<T>(selector)!
  const status = query<HTMLElement>('[data-rate-card-status]')
  const history = query<HTMLElement>('[data-rate-card-history]')
  const create = query<HTMLFormElement>('[data-rate-card-create]')
  const version = query<HTMLFormElement>('[data-rate-card-version]')
  const preview = query<HTMLFormElement>('[data-rate-card-preview]')
  const lines = query<HTMLElement>('[data-rate-card-lines]')
  const add = query<HTMLButtonElement>('[data-rate-card-add]')
  const result = query<HTMLElement>('[data-rate-card-preview-result]')
  const field = <T extends HTMLElement>(form: HTMLFormElement, name: string): T =>
    form.elements.namedItem(name) as T
  let context: RateCardContext | null = null
  let generation = 0
  let previewGeneration = 0
  let card: ClientRateCard | null = null
  let tasks: readonly GeneralResource[] = []
  let pending = false
  let loaded = false
  const current = (active: RateCardContext, request: number): boolean =>
    context === active && generation === request && !active.signal.aborted
  const writable = (): boolean =>
    loaded &&
    !!context &&
    clientProfileCanWrite(context.identity.profile) &&
    context.client.is_active !== false
  const clear = (): void => {
    section.hidden = true
    history.replaceChildren()
    lines.replaceChildren()
    create.reset()
    version.reset()
    preview.reset()
    field<HTMLSelectElement>(preview, 'task_id').replaceChildren()
    query<HTMLElement>('[data-rate-card-name]').textContent = ''
    status.textContent = ''
    result.textContent = ''
    loaded = false
    card = null
    tasks = []
    create.hidden = true
    version.hidden = true
  }
  const busy = (value: boolean): void => {
    pending = value
    for (const control of section.querySelectorAll<
      HTMLButtonElement | HTMLInputElement | HTMLSelectElement
    >('button, input, select'))
      control.disabled = value
    query<HTMLFieldSetElement>('[data-rate-card-edit-lines]').disabled =
      value || field<HTMLInputElement>(version, 'retire').checked
  }
  const taskOptions = (
    select: HTMLSelectElement,
    selected: number | null,
    includeDefault: boolean,
  ): void => {
    select.replaceChildren()
    const option = (label: string, value: string): HTMLOptionElement => {
      const item = document.createElement('option')
      item.textContent = label
      item.value = value
      return item
    }
    if (includeDefault) select.add(option('Default for other tasks', ''))
    for (const task of tasks)
      select.add(option(String(task.name ?? `Task #${task.id}`), String(task.id)))
    if (selected !== null && !tasks.some((task) => task.id === selected))
      select.add(option(`Task #${selected} (not active)`, String(selected)))
    select.value =
      selected !== null ? String(selected) : includeDefault ? '' : String(tasks[0]?.id ?? '')
  }
  const addLine = (taskId: number | null = null, amount = ''): void => {
    const row = document.createElement('div')
    row.className = 'settings-form'
    row.dataset.rateCardLine = ''
    const taskLabel = document.createElement('label')
    taskLabel.textContent = 'Task'
    const task = document.createElement('select')
    task.dataset.rateCardTask = ''
    taskOptions(task, taskId, true)
    taskLabel.append(task)
    const rateLabel = document.createElement('label')
    rateLabel.textContent = 'Hourly amount'
    const rate = document.createElement('input')
    rate.type = 'text'
    rate.inputMode = 'decimal'
    rate.value = amount
    rate.dataset.rateCardAmount = ''
    rateLabel.append(rate)
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.textContent = 'Remove rate'
    remove.addEventListener('click', () => row.remove())
    row.append(taskLabel, rateLabel, remove)
    lines.append(row)
  }
  const render = (): void => {
    if (!context) return
    const currency = String(context.client.currency ?? '')
    query<HTMLElement>('[data-rate-card-currency]').textContent =
      `Amounts in this client’s billing currency${currency ? ` (${currency})` : ''}.`
    query<HTMLElement>('[data-rate-card-name]').textContent = card?.name ?? ''
    status.textContent = card
      ? card.name
      : 'No rate card is attached here. Preview a task to check inherited rates, or create a card to override them.'
    history.replaceChildren()
    if (card) {
      const rows = card.versions.flatMap<{
        key: string
        from: string
        task: string
        amount: number | null
      }>((v) =>
        v.lines.length
          ? v.lines.map((line, index) => ({
              key: `${v.id}-${index}`,
              from: v.start_date ?? 'All prior dates',
              task:
                line.task_id === null
                  ? 'Default for other tasks'
                  : String(
                      tasks.find((t) => t.id === line.task_id)?.name ?? `Task #${line.task_id}`,
                    ),
              amount: line.amount_cents,
            }))
          : [
              {
                key: String(v.id),
                from: v.start_date ?? 'All prior dates',
                task: 'Retired — inherit or use person default',
                amount: null,
              },
            ],
      )
      history.append(
        renderDataTable({
          caption: 'Rate card versions',
          table: 'client-rate-card-versions',
          rows,
          rowKey: (row) => row.key,
          empty: 'No rates published yet.',
          columns: [
            { key: 'from', label: 'Effective from', render: (row) => row.from },
            { key: 'task', label: 'Task', render: (row) => row.task },
            {
              key: 'amount',
              label: 'Hourly rate',
              numeric: true,
              render: (row) => {
                const value = document.createElement('span')
                value.textContent = row.amount === null ? '—' : clientMoney(row.amount, currency)
                markMoney(value, row.amount !== null)
                return value
              },
            },
          ],
        }),
      )
    }
    create.hidden = !writable() || card !== null
    version.hidden = !writable() || card === null
    version.reset()
    lines.replaceChildren()
    const latest = card?.versions.at(-1)
    const date = field<HTMLInputElement>(version, 'start_date')
    date.required = latest !== undefined
    if (latest?.start_date)
      date.min = new Date(Date.parse(latest.start_date) + 86400000).toISOString().slice(0, 10)
    else date.removeAttribute('min')
    query<HTMLElement>('[data-rate-card-date-hint]').textContent = latest
      ? 'Choose a date after every published version. Earlier versions remain in history.'
      : 'For the first version, leave the date blank to cover all prior work dates.'
    if (latest?.lines.length)
      for (const line of latest.lines) addLine(line.task_id, decimal(line.amount_cents))
    else addLine()
    const previousTask = field<HTMLSelectElement>(preview, 'task_id').value
    taskOptions(
      field<HTMLSelectElement>(preview, 'task_id'),
      previousTask ? Number(previousTask) : null,
      false,
    )
    field<HTMLInputElement>(preview, 'spent_date').value ||= new Date().toISOString().slice(0, 10)
    busy(false)
  }
  const load = async (): Promise<void> => {
    const active = context
    if (!active || active.signal.aborted || !api.getClientRateCard || !api.listRateCardTasks) return
    const request = ++generation
    previewGeneration++
    loaded = false
    result.textContent = ''
    history.replaceChildren()
    create.hidden = true
    version.hidden = true
    status.textContent = 'Loading rate card…'
    busy(true)
    try {
      const collected: GeneralResource[] = []
      let cursor: string | undefined
      do {
        const page = await api.listRateCardTasks(cursor, active.signal)
        collected.push(...page.data)
        cursor = page.page.next_cursor ?? undefined
        if (!current(active, request)) return
      } while (cursor)
      let selected: ClientRateCard | null = null
      try {
        selected = await api.getClientRateCard(active.client.id, active.signal)
      } catch (error) {
        if (!notFound(error)) throw error
      }
      if (!current(active, request)) return
      tasks = collected
      card = selected
      loaded = true
      render()
    } catch (error) {
      if (current(active, request))
        active.failed(error, () => {
          status.textContent = errorText(error)
        })
    } finally {
      if (current(active, request)) busy(false)
    }
  }
  const write = async (
    action: (active: RateCardContext) => Promise<ClientRateCard>,
  ): Promise<void> => {
    const active = context
    const request = generation
    if (!active || pending || !writable()) return
    busy(true)
    status.textContent = 'Saving rate card…'
    try {
      const saved = await action(active)
      if (!current(active, request)) return
      card = saved
      render()
      result.textContent = ''
      previewGeneration++
      status.textContent = 'Saved. Existing hours and invoices are unchanged.'
    } catch (error) {
      if (current(active, request))
        active.failed(error, () => {
          status.textContent = errorText(error)
        })
    } finally {
      if (current(active, request)) busy(false)
    }
  }
  query<HTMLButtonElement>('[data-rate-card-reload]').addEventListener('click', () => {
    if (!pending) void load()
  })
  add.addEventListener('click', () => {
    if (writable() && !pending && lines.children.length < rateCardMaxLines) addLine()
  })
  field<HTMLInputElement>(version, 'retire').addEventListener('change', () => busy(pending))
  create.addEventListener('submit', (event) => {
    event.preventDefault()
    const name = field<HTMLInputElement>(create, 'name').value.trim()
    if (!name) {
      status.textContent = 'Enter a card name.'
      return
    }
    if (api.createClientRateCard)
      void write((active) => api.createClientRateCard!(active.client.id, name, active.signal))
  })
  version.addEventListener('submit', (event) => {
    event.preventDefault()
    if (!writable() || pending || !card || !api.createClientRateCardVersion) return
    try {
      const date = field<HTMLInputElement>(version, 'start_date').value
      const latest = card.versions.at(-1)
      if (
        (date && !dateValid(date)) ||
        (latest && (!date || (latest.start_date && date <= latest.start_date)))
      )
        throw new Error('Choose an effective date after every published version.')
      const retired = field<HTMLInputElement>(version, 'retire').checked
      const input: ClientRateCardVersionInput = { start_date: date || null, lines: [] }
      const seen = new Set<number | null>()
      if (!retired)
        for (const row of lines.querySelectorAll<HTMLElement>('[data-rate-card-line]')) {
          const raw = row.querySelector<HTMLSelectElement>('[data-rate-card-task]')!.value
          const task = raw ? Number(raw) : null
          if (seen.has(task)) throw new Error('Choose each task and the default rate only once.')
          seen.add(task)
          const amount = parseTeamMoneyCents(
            row.querySelector<HTMLInputElement>('[data-rate-card-amount]')!.value.trim(),
          )
          if (amount > rateCardMaxAmountCents) throw new Error('That hourly amount is too large.')
          input.lines.push({ task_id: task, amount_cents: amount })
        }
      if (!retired && !input.lines.length)
        throw new Error('Add at least one rate, or select Retire this card.')
      void write((active) =>
        api.createClientRateCardVersion!(active.client.id, input, active.signal),
      )
    } catch (error) {
      status.textContent = errorText(error)
    }
  })
  for (const event of ['input', 'change'])
    preview.addEventListener(event, () => {
      previewGeneration++
      result.textContent = ''
    })
  preview.addEventListener('submit', (event) => {
    event.preventDefault()
    const active = context
    const request = generation
    const attempt = ++previewGeneration
    const task = Number(field<HTMLSelectElement>(preview, 'task_id').value)
    const date = field<HTMLInputElement>(preview, 'spent_date').value
    if (!active || !loaded || pending || !api.getClientEffectiveRateCard) return
    if (!Number.isSafeInteger(task) || task < 1 || !dateValid(date)) {
      result.textContent = 'Choose a task and work date.'
      return
    }
    result.textContent = 'Checking the matching card…'
    void api
      .getClientEffectiveRateCard(active.client.id, task, date, active.signal)
      .then((match) => {
        if (!current(active, request) || attempt !== previewGeneration) return
        const source = active.clients.find((c) => c.id === match.supplied_by_client_id)
        const amount = document.createElement('span')
        amount.textContent = clientMoney(match.amount_cents, String(active.client.currency ?? ''))
        markMoney(amount, true)
        result.replaceChildren(
          document.createTextNode(
            `${match.card_name} from ${String(source?.name ?? `Client #${match.supplied_by_client_id}`)}${match.depth ? ' (inherited)' : ''}: `,
          ),
          amount,
          document.createTextNode(
            ` per hour, ${match.task_id === null ? 'card default' : 'task rate'}.`,
          ),
        )
      })
      .catch((error: unknown) => {
        if (current(active, request) && attempt === previewGeneration)
          active.failed(error, () => {
            result.textContent = notFound(error)
              ? 'No card matches. The person’s default rate applies unless their assignment overrides it.'
              : errorText(error)
          })
      })
  })
  return {
    async activate(active: RateCardContext) {
      context = active
      generation++
      previewGeneration++
      clear()
      active.signal.addEventListener(
        'abort',
        () => {
          if (context === active) {
            generation++
            previewGeneration++
            clear()
            context = null
          }
        },
        { once: true },
      )
      if (
        active.signal.aborted ||
        !canManageClientTerms(active.identity) ||
        !api.getClientRateCard ||
        !api.listRateCardTasks
      )
        return
      section.hidden = false
      await load()
    },
  }
}
