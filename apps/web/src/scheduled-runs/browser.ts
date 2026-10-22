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
  const warnings = required('[data-scheduled-run-warnings]')
  const acknowledge = required<HTMLInputElement>('[data-scheduled-run-ack]')
  const acknowledgeLabel = required('[data-scheduled-run-ack-label]')
  const retry = required<HTMLButtonElement>('[data-scheduled-run-retry]')
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
    retry.hidden = true
    warnings.hidden = acknowledgeLabel.hidden = true
    warnings.replaceChildren()
    acknowledge.checked = false
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
        defaultSort: { column: 'client', direction: 'ascending' },
        rows: value.items,
        rowKey: (item) => String(item.id),
        empty: 'This proposal has no items.',
        columns: [
          {
            key: 'client',
            label: 'Client',
            sortValue: (item) => item.client_name,
            render: (item) => item.client_name ?? 'Not recorded',
          },
          {
            key: 'item',
            label: 'Item',
            sortValue: (item) => item.description,
            render: (item) => item.description,
          },
          {
            key: 'people',
            label: 'People in report',
            sortValue: (item) => (item.report_people ?? []).map((person) => person.name).join(', '),
            render: (item) =>
              (item.report_people ?? [])
                .map((person) => `${person.name} — ${myPaymentsHours(person.seconds)}`)
                .join('; ') || 'No time recorded',
          },
          {
            key: 'report',
            label: 'Saved PDF',
            sortValue: (item) => item.report_name ?? '',
            render: (item) => {
              if (!item.report_name) return 'Not captured'
              const link = document.createElement('a')
              link.href = `/api/v1/scheduled-runs/${value.id}/items/${item.id}/report`
              link.textContent = 'Review saved PDF'
              link.target = '_blank'
              link.rel = 'noopener'
              return link
            },
          },
          {
            key: 'hours',
            label: 'Invoice hours',
            sortValue: (item) => item.quantity_seconds,
            render: (item) =>
              item.quantity_seconds === null
                ? 'Not recorded'
                : myPaymentsHours(item.quantity_seconds),
          },
          {
            key: 'amount',
            label: 'Amount',
            sortValue: (item) =>
              item.amount_cents === null ? null : [item.currency ?? '', item.amount_cents],
            render: (item) =>
              item.amount_cents === null
                ? 'Not recorded'
                : myPaymentsMoney(item.amount_cents, item.currency!),
          },
          {
            key: 'target',
            label: 'Recipient',
            sortValue: (item) => item.target,
            render: (item) => item.target ?? 'Not recorded',
          },
          {
            key: 'state',
            label: 'Result',
            sortValue: (item) => item.failure_reason ?? item.delivery_status ?? item.state,
            render: (item) =>
              [
                item.state === 'done' ? 'Queued' : item.state,
                item.delivery_status ? `Delivery ${item.delivery_status}` : null,
                item.failure_reason,
              ]
                .filter(Boolean)
                .join(' · '),
          },
        ],
      }),
    )
    const flagged = value.items.flatMap((item) =>
      (item.report_warnings ?? []).map((warning) => ({ item, warning })),
    )
    warnings.replaceChildren()
    if (flagged.length) {
      const title = document.createElement('p')
      title.textContent =
        'Review notes before sending: the saved PDFs contain these report-note warnings.'
      const list = document.createElement('ul')
      for (const { item, warning } of flagged) {
        const row = document.createElement('li')
        row.textContent = `${item.description}: entry ${warning.entryId}, ${warning.kind} — ${warning.match}`
        list.append(row)
      }
      warnings.append(title, list)
    }
    warnings.hidden = !flagged.length
    acknowledge.checked = false
    acknowledgeLabel.hidden = !flagged.length || value.state !== 'proposed'
    confirm.disabled = flagged.length > 0
    retry.hidden =
      !api.retry ||
      value.state !== 'confirmed' ||
      !value.items.some(
        (item) => item.state === 'failed' && item.attempt_count >= (item.attempt_limit ?? 3),
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
  const answer = async (decision: 'confirm' | 'cancel' | 'retry') => {
    if (
      !active ||
      active.aborted ||
      !run ||
      busy ||
      (decision === 'retry' ? retry.hidden : actions.hidden) ||
      (decision === 'confirm' && !acknowledgeLabel.hidden && !acknowledge.checked)
    )
      return
    const signal = active,
      request = ++generation,
      id = run.id
    busy = true
    confirm.disabled = cancel.disabled = refresh.disabled = retry.disabled = true
    status.textContent =
      decision === 'confirm'
        ? 'Recording confirmation…'
        : decision === 'retry'
          ? 'Authorizing failed-item retries…'
          : 'Cancelling proposal…'
    try {
      const response =
        decision === 'confirm'
          ? await api.confirm(id, signal, acknowledge.checked)
          : decision === 'retry'
            ? await api.retry!(id, signal)
            : await api.cancel(id, signal)
      if (!signal.aborted && request === generation) draw(response.data)
    } catch {
      if (signal.aborted || request !== generation) return
      clear()
      status.textContent =
        'The answer could not be verified. Refresh to check the recorded state before trying again.'
    } finally {
      if (request === generation) {
        busy = false
        confirm.disabled = cancel.disabled = refresh.disabled = retry.disabled = false
      }
    }
  }
  acknowledge.addEventListener('change', () => {
    confirm.disabled = busy || (!acknowledgeLabel.hidden && !acknowledge.checked)
  })
  retry.addEventListener('click', () => {
    void answer('retry')
  })
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
      confirm.disabled = cancel.disabled = refresh.disabled = retry.disabled = false
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
