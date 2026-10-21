import { EzactoApiError } from '@conflict-hq/ezacto-client'
import type { ScheduledRun } from '@ezacto/core'
import { renderDataTable } from '../components/data-table.js'
import { myPaymentsHours, myPaymentsMoney } from '../my-payments/model.js'
import type { ScheduledRunApi } from './model.js'

export const createScheduledRunController = (api: ScheduledRunApi) => {
  const page = document.querySelector<HTMLElement>('[data-scheduled-run-page]')
  const required = <T extends HTMLElement>(selector: string) => {
    const element = page?.querySelector<T>(selector)
    if (!element) throw new Error(`Scheduled run element missing: ${selector}`)
    return element
  }
  if (!page) return { activate: async () => {} }
  const status = required('[data-scheduled-run-status]')
  const content = required('[data-scheduled-run-content]')
  const summary = required('[data-scheduled-run-summary]')
  const items = required('[data-scheduled-run-items]')
  const actions = required('[data-scheduled-run-actions]')
  const confirm = required<HTMLButtonElement>('[data-scheduled-run-confirm]')
  const cancel = required<HTMLButtonElement>('[data-scheduled-run-cancel]')
  const refresh = required<HTMLButtonElement>('[data-scheduled-run-refresh]')
  let active: AbortSignal | null = null,
    generation = 0,
    run: ScheduledRun | null = null,
    busy = false
  const clear = () => {
    run = null
    actions.hidden = true
    content.hidden = true
    summary.replaceChildren()
    items.replaceChildren()
  }
  const pair = (label: string, value: string) => {
    const term = document.createElement('dt'),
      detail = document.createElement('dd')
    term.textContent = label
    detail.textContent = value
    return [term, detail]
  }
  const draw = (value: ScheduledRun) => {
    run = value
    summary.replaceChildren(
      ...pair('Work month', value.occurrence_key),
      ...pair('Status', value.state),
      ...pair(
        'Answer before',
        new Date(value.expires_at).toLocaleString(undefined, {
          dateStyle: 'medium',
          timeStyle: 'long',
        }),
      ),
      ...(value.confirmed_by === null
        ? []
        : pair('Confirmed by', `User #${value.confirmed_by} at ${value.confirmed_at}`)),
    )
    items.replaceChildren(
      renderDataTable<ScheduledRun['items'][number]>({
        caption: 'Concrete items in this manifest',
        table: 'scheduled-run-items',
        rows: value.items,
        rowKey: (item) => String(item.id),
        empty: 'This proposal has no items.',
        columns: [
          { key: 'client', label: 'Client', render: (item) => item.client_name ?? 'Not recorded' },
          { key: 'item', label: 'Item', render: (item) => item.description },
          {
            key: 'hours',
            label: 'Hours',
            render: (item) =>
              item.quantity_seconds === null
                ? 'Not recorded'
                : myPaymentsHours(item.quantity_seconds),
          },
          {
            key: 'amount',
            label: 'Amount',
            render: (item) =>
              item.amount_cents === null
                ? 'Not recorded'
                : myPaymentsMoney(item.amount_cents, item.currency!),
          },
          { key: 'target', label: 'Recipient', render: (item) => item.target ?? 'Not recorded' },
          { key: 'state', label: 'Result', render: (item) => item.failure_reason ?? item.state },
        ],
      }),
    )
    content.hidden = false
    actions.hidden =
      value.state !== 'proposed' ||
      !value.items.length ||
      Date.parse(value.expires_at) <= Date.now()
    status.textContent =
      value.state === 'confirmed'
        ? 'Confirmation recorded. Items below show the recorded results.'
        : value.state === 'completed'
          ? 'This run is complete.'
          : value.state === 'cancelled'
            ? 'This proposal was cancelled. No further action is available.'
            : !value.items.length
              ? 'This proposal has no concrete items and cannot be confirmed.'
              : value.state === 'expired' || actions.hidden
                ? 'This proposal has expired and cannot be confirmed.'
                : 'Review the complete manifest, then confirm or cancel it.'
  }
  const load = async (signal: AbortSignal) => {
    const request = ++generation
    clear()
    status.textContent = 'Loading proposal…'
    const id = Number(/^\/scheduled-runs\/([1-9]\d*)$/.exec(location.pathname)?.[1])
    if (!Number.isSafeInteger(id) || id < 1) {
      status.textContent = 'Choose a valid proposal link.'
      return
    }
    try {
      const response = await api.read(id, signal)
      if (!signal.aborted && request === generation) draw(response.data)
    } catch (error) {
      if (signal.aborted || request !== generation) return
      status.textContent =
        error instanceof EzactoApiError && error.status === 404
          ? 'This proposal could not be found.'
          : 'The proposal could not be loaded. Refresh to try again.'
    }
  }
  const answer = async (decision: 'confirm' | 'cancel') => {
    if (!active || active.aborted || !run || busy || actions.hidden) return
    const signal = active,
      request = ++generation,
      id = run.id
    busy = true
    confirm.disabled = cancel.disabled = refresh.disabled = true
    status.textContent = decision === 'confirm' ? 'Recording confirmation…' : 'Cancelling proposal…'
    try {
      const response = await api[decision](id, signal)
      if (!signal.aborted && request === generation) draw(response.data)
    } catch {
      if (signal.aborted || request !== generation) return
      clear()
      status.textContent =
        'The answer could not be verified. Refresh to check the recorded state before trying again.'
    } finally {
      if (request === generation) {
        busy = false
        confirm.disabled = cancel.disabled = refresh.disabled = false
      }
    }
  }
  confirm.addEventListener('click', () => {
    void answer('confirm')
  })
  cancel.addEventListener('click', () => {
    void answer('cancel')
  })
  refresh.addEventListener('click', () => {
    if (active && !active.aborted && !busy) void load(active)
  })
  return {
    async activate(signal: AbortSignal, administrator: boolean) {
      active = signal
      ++generation
      busy = false
      confirm.disabled = cancel.disabled = refresh.disabled = false
      clear()
      signal.addEventListener(
        'abort',
        () => {
          if (active === signal) {
            ++generation
            clear()
            status.textContent = 'Sign in to review this proposal.'
          }
        },
        { once: true },
      )
      if (!administrator) {
        status.textContent = 'Only administrators may review scheduled manifests.'
        return
      }
      await load(signal)
    },
  }
}
