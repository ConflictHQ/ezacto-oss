import { createDeelStageController, type DeelStageApi } from './deel-stage-browser.js'
import { createContractorReviewController, type ContractorReviewApi } from './reconciliation-browser.js'
import { createStaffInvoicesController, type StaffInvoicesApi } from './invoices-browser.js'
import { createAdvanceCreditsController, type AdvanceCreditsApi } from './advances-browser.js'
import { createActualsController, type PaymentActualsApi } from './actuals-browser.js'
import { createAllocationsController, type PaymentAllocationsApi } from './allocations-browser.js'
import { createPaymentTabs } from './tabs.js'
import { createDeelSyncController, type DeelSyncApi } from './deel-sync-browser.js'
import { canPayNow } from './runs-model.js'
import { createPaymentRunsController, type PaymentRunsApi } from './runs-browser.js'
import { EzactoApiError } from '@conflict-hq/ezacto-client'
import {
  paymentMonthEnd,
  previousPaymentMonth,
  validPaymentMonth,
  type StaffPaymentCommand,
  type StaffPaymentProviderCommand,
  type StaffPaymentReport,
  type StaffPaymentRow,
} from '@ezacto/core'
import { renderDataTable, type DataTableSort } from '../components/data-table.js'
import { isDemoDeployment } from '../demo.js'
import { moneyText } from '../money-display.js'
import {
  hasPaymentActivity,
  staffPaymentAmount,
  staffPaymentCsv,
  staffPaymentMoney,
  staffPaymentStatus,
} from './model.js'

export interface StaffPaymentsApi
  extends ContractorReviewApi,
    PaymentRunsApi,
    PaymentActualsApi,
    PaymentAllocationsApi,
    DeelSyncApi,
    DeelStageApi,
    AdvanceCreditsApi,
    StaffInvoicesApi {
  configureStaffPaymentProvider?(
    command: StaffPaymentProviderCommand,
    signal?: AbortSignal,
  ): Promise<void>
  getStaffPaymentReport?(month: string, signal?: AbortSignal): Promise<StaffPaymentReport>
  recordStaffPaymentEvent?(command: StaffPaymentCommand, signal?: AbortSignal): Promise<void>
}

const moneySort = (
  amount: number | null,
  currency: string | null,
): readonly [string, number] | null =>
  amount === null || currency === null ? null : [currency, amount]
const moneySortDescription = 'Sort by currency, then amount; unspecified amounts stay last.'

const failure = (error: unknown): string => {
  if (error instanceof EzactoApiError) {
    const body = error.body as {
      error?: { message?: string; fields?: { message?: string }[] }
    } | null
    const message =
      body?.error?.fields?.[0]?.message ??
      body?.error?.message ??
      'The payment record could not be saved.'
    return error.requestId === null ? message : `${message} Reference: ${error.requestId}`
  }
  return error instanceof Error ? error.message : 'The payment register could not be loaded.'
}
const element = <T extends HTMLElement>(root: Document | HTMLElement, selector: string): T => {
  const value = root.querySelector<T>(selector)
  if (value === null) throw new Error(`Missing payment register element: ${selector}`)
  return value
}
const text = (tag: string, value: string): HTMLElement => {
  const node = document.createElement(tag)
  node.textContent = value
  return node
}

export const createStaffPaymentsController = (api: StaffPaymentsApi) => {
  const page = document.querySelector<HTMLElement>('[data-staff-payments-page]')
  if (page === null) return { activate: async () => {} }
  const content = element<HTMLElement>(page, '[data-staff-payment-content]')
  const status = element<HTMLElement>(page, '[data-staff-payment-status]')
  const month = element<HTMLInputElement>(page, '[data-payment-month]')
  const filter = element<HTMLInputElement>(page, '[data-payment-filter]')
  const showEmpty = element<HTMLInputElement>(page, '[data-payment-show-empty]')
  const activityRows = () => report?.rows.filter((row) => showEmpty.checked || hasPaymentActivity(row)) ?? []
  const search = element<HTMLInputElement>(page, '[data-payment-search]')
  const list = element<HTMLElement>(page, '[data-payment-list]')
  const summary = element<HTMLElement>(page, '[data-payment-summary]')
  const person = element<HTMLElement>(page, '[data-payment-person]')
  const history = element<HTMLElement>(page, '[data-payment-history]')
  const form = element<HTMLFormElement>(page, '[data-payment-entry-form]')
  const openingForm = element<HTMLFormElement>(page, '[data-payment-opening-form]')
  const result = element<HTMLElement>(page, '[data-payment-entry-result]')
  const providerForms = [...page.querySelectorAll<HTMLFormElement>('[data-payment-provider-form]')]
  const providerSettings = element<HTMLElement>(page, '[data-payment-provider-settings]')
  const providerHistory = element<HTMLElement>(page, '[data-payment-provider-history]')
  // Which provider pays a person is not the public demo's to choose (issue
  // 931): the forms are withheld there, with the note in their place.
  const demo = isDemoDeployment()
  for (const note of page.querySelectorAll<HTMLElement>('[data-payment-provider-demo]')) {
    note.hidden = !demo
  }
  const input = (name: string): HTMLInputElement =>
    form.elements.namedItem(name) as HTMLInputElement
  let signal: AbortSignal | null = null
  let report: StaffPaymentReport | null = null
  let selected: number | null = null
  let generation = 0
  let busy = false
  let command: StaffPaymentCommand | null = null
  // Undefined until somebody sorts in this visit: a table then starts from the
  // sort they last chose for it, else from its default (issue 852).
  let registerSort: DataTableSort | undefined
  let historySort: DataTableSort | undefined
  let providerSort: DataTableSort | undefined
  const tabs = createPaymentTabs(page)
  const runs = createPaymentRunsController(
    api,
    () => load(),
    () => tabs.select('history', true),
  )
  const actuals = createActualsController(
    page,
    api,
    () => load(),
    (userId) => {
      tabs.select('send')
      runs.payNow(userId)
    },
    failure,
  )
  const allocations = createAllocationsController(page, api, failure)
  const payNow = element<HTMLButtonElement>(page, '[data-payment-pay-now]')
  payNow.addEventListener('click', () => {
    tabs.select('send')
    runs.payNow()
  })

  const configureForm = (): void => {
    const kind = input('kind').value
    const visible: Record<string, boolean> = {
      amount: kind === 'amount' || kind === 'payment',
      currency: kind === 'amount' || kind === 'payment',
      due: kind === 'amount',
      paid: kind === 'payment',
      reference: kind === 'payment',
      source: kind === 'payment',
      void: kind === 'void',
    }
    for (const field of form.querySelectorAll<HTMLElement>('[data-payment-field]')) {
      field.hidden = visible[field.dataset.paymentField ?? ''] !== true
      for (const control of field.querySelectorAll<HTMLInputElement>('input, select')) {
        control.disabled = field.hidden || busy
        control.required = !field.hidden && control.name !== 'due_on'
      }
    }
  }
  const setBusy = (value: boolean): void => {
    busy = value
    for (const control of content.querySelectorAll<HTMLInputElement>(
      'input, select, textarea, button',
    ))
      control.disabled = value
    configureForm()
    deelStage.setParentBusy(value)
  }
  const rowForSelection = (): StaffPaymentRow | undefined =>
    report?.rows.find((row) => row.user_id === selected)
  const paintPerson = (): void => {
    const row = rowForSelection()
    person.hidden = row === undefined
    if (row === undefined || report === null) return
    element<HTMLElement>(person, '[data-payment-person-title]').textContent =
      `${row.name} · ${row.month}`
    element<HTMLAnchorElement>(person, '[data-payment-destination]').href = `/team/${row.user_id}`
    element<HTMLElement>(person, '[data-payment-person-summary]').textContent =
      row.status === 'settled'
        ? `Confirmed settled through ${row.settled_through}. ${row.amount_basis === 'contractor_cost' ? 'Amount reflects current contractor cost for this work month; payment receipts and dates are unspecified.' : 'Historical amounts are unspecified.'}`
        : `${staffPaymentStatus(row)}. Remaining: ${staffPaymentMoney(row.balance_cents, row.currency)}.`
    const preferenceForm = providerForms.find(
      (item) => item.dataset.paymentProviderForm === 'person',
    )!
    preferenceForm.hidden = demo || api.configureStaffPaymentProvider === undefined
    preferenceForm.reset()
    element<HTMLElement & { value: string }>(preferenceForm, '[name=provider]').value =
      row.provider_override ?? ''
    const inherit = preferenceForm.querySelector<HTMLOptionElement>('option[value=""]')!
    inherit.textContent = `Use organization default (${report.provider_settings.default_provider === 'wise' ? 'Wise' : 'Deel'})`
    element<HTMLAnchorElement>(person, '[data-payment-destination]').textContent =
      row.payout_provider === 'wise' ? 'Manage Wise destination' : 'View person'
    form.reset()
    input('source').value = row.payout_provider
    input('currency').value = row.currency ?? ''
    input('paid_on').value = report.as_of
    input('paid_on').max = report.as_of
    input('due_on').value = row.due_on ?? ''
    if (row.amount_cents !== null) input('amount').value = (row.amount_cents / 100).toFixed(2)
    const voided = new Set(
      row.events.filter((event) => event.kind === 'void').map((event) => event.payment_id),
    )
    input('payment_id').replaceChildren(
      ...row.events
        .filter((event) => event.kind === 'payment' && !voided.has(event.id))
        .map((event) => {
          const option = document.createElement('option')
          option.value = event.id
          option.textContent = `${event.paid_on} · ${staffPaymentMoney(event.amount_cents, event.currency)} · ${event.reference}`
          return option
        }),
    )
    history.replaceChildren(
      renderDataTable({
        caption: 'Payment history',
        table: 'staff-payments-history',
        defaultSort: { column: 'when', direction: 'descending' },
        ...(historySort === undefined ? {} : { sort: historySort }),
        onSort: (sort) => {
          historySort = sort
        },
        rows: [...row.events].sort(
          (a, b) => b.recorded_at.localeCompare(a.recorded_at) || b.version - a.version,
        ),
        rowKey: (event) => event.id,
        empty: 'No records yet.',
        columns: [
          {
            key: 'when',
            label: 'Recorded',
            sortValue: (event) => event.recorded_at,
            render: (event) => event.recorded_at,
          },
          {
            key: 'event',
            label: 'Entry',
            sortValue: (event) => [event.kind, voided.has(event.id) ? 1 : 0, event.month],
            render: (event) =>
              `${event.kind}${voided.has(event.id) ? ' (voided)' : ''} · ${event.month}`,
          },
          {
            key: 'amount',
            label: 'Amount',
            sortValue: (event) => moneySort(event.amount_cents, event.currency),
            sortDescription: moneySortDescription,
            render: (event) =>
              event.amount_cents === null
                ? '—'
                : moneyText(staffPaymentMoney(event.amount_cents, event.currency)),
          },
          {
            key: 'paid',
            label: 'Paid on',
            sortValue: (event) => event.paid_on,
            render: (event) => event.paid_on ?? '—',
          },
          {
            key: 'source',
            label: 'Source / reference',
            sortValue: (event) => [event.source, event.reference],
            render: (event) => `${event.source === "advance_credit" ? "Advance credit applied" : event.source} ${event.reference}`,
          },
          { key: 'note', label: 'Note', render: (event) => event.note },
          {
            key: 'actor',
            label: 'Recorded by',
            sortValue: (event) => event.actor_name,
            render: (event) => event.actor_name,
          },
        ],
      }),
    )
    configureForm()
  }
  const paintList = (): void => {
    if (report === null) return
    const rows = activityRows().filter(
      (row) =>
        row.name.toLocaleLowerCase().includes(search.value.toLocaleLowerCase()) &&
        (filter.value === 'outstanding'
          ? row.status !== 'paid' && row.status !== 'settled'
          : filter.value === 'paid'
            ? row.status === 'paid' || row.status === 'settled'
            : filter.value === 'overdue'
              ? row.overdue
              : filter.value === 'unready'
                ? !(row.payout_provider === 'deel' ? row.deel_ready : row.wise_ready)
                : true),
    )
    list.replaceChildren(
      renderDataTable({
        caption: 'Monthly staff payment register',
        table: 'staff-payments-register',
        defaultSort: { column: 'name', direction: 'ascending' },
        ...(registerSort === undefined ? {} : { sort: registerSort }),
        onSort: (sort) => {
          registerSort = sort
        },
        rows,
        rowKey: (row) => String(row.user_id),
        empty: 'No people match this view.',
        columns: [
          {
            key: 'name',
            label: 'Person',
            sortValue: (row) => row.name,
            render: (row) => {
              const button = document.createElement('button')
              button.type = 'button'
              button.textContent = row.name
              button.addEventListener('click', () => {
                selected = row.user_id
                command = null
                result.textContent = ''
                paintPerson()
                person.scrollIntoView({ block: 'nearest' })
              })
              return button
            },
          },
          {
            key: 'pay',
            label: 'Action',
            render: (row) => {
              if (row.active && row.payout_provider === 'deel' && deelStage.available()) {
                const button = document.createElement('button')
                button.type = 'button'
                button.textContent = 'Stage in Deel'
                button.setAttribute('aria-label', `Stage approved hours in Deel: ${row.name}`)
                button.addEventListener('click', () => deelStage.open(row.user_id))
                return button
              }
              if (api.previewPaymentRun && canPayNow(row)) {
                const button = document.createElement('button')
                button.type = 'button'
                button.className = 'primary-action'
                button.textContent = 'Pay now'
                button.setAttribute('aria-label', `Pay now: ${row.name}`)
                button.addEventListener('click', () => {
                  tabs.select('send')
                  runs.payNow(row.user_id)
                })
                return button
              }
              if (row.amount_cents === null && row.status !== 'settled') {
                const button = document.createElement('button')
                button.type = 'button'
                button.textContent = 'Set amount'
                button.addEventListener('click', () => {
                  selected = row.user_id
                  command = null
                  result.textContent = ''
                  paintPerson()
                  person.scrollIntoView({ block: 'nearest' })
                  input('amount').focus()
                })
                return button
              }
              if (row.payout_provider === 'wise' && !row.wise_ready) {
                const link = document.createElement('a')
                link.href = `/team/${row.user_id}`
                link.textContent = 'Set up Wise'
                return link
              }
              return '—'
            },
          },
          {
            key: 'status',
            label: 'Status',
            sortValue: staffPaymentStatus,
            render: (row) => staffPaymentStatus(row),
          },
          {
            key: 'due',
            label: 'Due',
            sortValue: (row) => row.due_on,
            render: (row) => row.due_on ?? 'Not set',
          },
          {
            key: 'amount',
            label: 'Amount owed',
            sortValue: (row) => moneySort(row.amount_cents, row.currency),
            sortDescription: moneySortDescription,
            numeric: true,
            render: (row) => {
              const value = moneyText(staffPaymentMoney(row.amount_cents, row.currency))
              if (row.amount_basis === 'contractor_cost')
                value.appendChild(document.createTextNode(' · contractor cost'))
              return value
            },
          },
          {
            key: 'paid',
            label: 'Recorded paid',
            sortValue: (row) =>
              moneySort(row.status === 'settled' ? null : row.paid_cents, row.currency),
            sortDescription: moneySortDescription,
            numeric: true,
            render: (row) =>
              row.status === 'settled'
                ? 'Unspecified'
                : moneyText(staffPaymentMoney(row.paid_cents, row.currency)),
          },
          {
            key: 'balance',
            label: 'Remaining',
            sortValue: (row) =>
              moneySort(row.status === 'settled' ? null : row.balance_cents, row.currency),
            sortDescription: moneySortDescription,
            numeric: true,
            render: (row) =>
              row.status === 'settled'
                ? 'Settled'
                : moneyText(staffPaymentMoney(row.balance_cents, row.currency)),
          },
          {
            key: 'reserved',
            label: 'Scheduled / processing',
            numeric: true,
            render: (row) => moneyText(staffPaymentMoney(row.reserved_cents ?? 0, row.currency)),
          },
          {
            key: 'available',
            label: 'Available to pay',
            numeric: true,
            render: (row) =>
              moneyText(staffPaymentMoney(row.available_cents ?? row.balance_cents, row.currency)),
          },
          {
            key: 'provider',
            label: 'Preferred provider',
            sortValue: (row) => [row.payout_provider, row.provider_override === null ? 0 : 1],
            render: (row) =>
              `${row.payout_provider === 'deel' ? 'Deel' : 'Wise'}${row.provider_override === null ? ' (default)' : ''}`,
          },
          {
            key: 'destination',
            label: 'Preferred destination',
            sortValue: (row) =>
              (row.payout_provider === 'deel' ? row.deel_ready : row.wise_ready) ? 1 : 0,
            render: (row) =>
              (row.payout_provider === 'deel' ? row.deel_ready : row.wise_ready)
                ? 'Ready'
                : 'Needs setup',
          },
        ],
      }),
    )
  }
  const paint = (): void => {
    if (report === null) return
    providerSettings.hidden = demo || api.configureStaffPaymentProvider === undefined
    const organizationForm = providerForms.find(
      (item) => item.dataset.paymentProviderForm === 'organization',
    )!
    organizationForm.reset()
    element<HTMLElement & { value: string }>(organizationForm, '[name=provider]').value =
      report.provider_settings.default_provider
    providerHistory.replaceChildren(
      renderDataTable({
        caption: 'Provider settings history (all dates)',
        table: 'staff-payments-provider-history',
        defaultSort: { column: 'when', direction: 'descending' },
        ...(providerSort === undefined ? {} : { sort: providerSort }),
        onSort: (sort) => {
          providerSort = sort
        },
        rows: [...report.provider_settings.events].sort(
          (a, b) => b.recorded_at.localeCompare(a.recorded_at) || b.version - a.version,
        ),
        rowKey: (event) => event.id,
        empty: 'No provider changes recorded. The initial default is Wise.',
        columns: [
          {
            key: 'when',
            label: 'Recorded',
            sortValue: (event) => event.recorded_at,
            render: (event) => event.recorded_at,
          },
          {
            key: 'person',
            label: 'Applies to',
            sortValue: (event) =>
              event.user_id === null
                ? 'Organization default'
                : (report!.rows.find((row) => row.user_id === event.user_id)?.name ??
                  `User ${event.user_id}`),
            render: (event) =>
              event.user_id === null
                ? 'Organization default'
                : (report!.rows.find((row) => row.user_id === event.user_id)?.name ??
                  `User ${event.user_id}`),
          },
          {
            key: 'provider',
            label: 'Preference',
            sortValue: (event) =>
              event.provider === null ? 'Use organization default' : event.provider,
            render: (event) =>
              event.provider === null
                ? 'Use organization default'
                : event.provider === 'wise'
                  ? 'Wise'
                  : 'Deel',
          },
          { key: 'note', label: 'Reason', render: (event) => event.note },
          {
            key: 'actor',
            label: 'Recorded by',
            sortValue: (event) => event.actor_name,
            render: (event) => event.actor_name,
          },
          {
            key: 'request',
            label: 'Request ID',
            sortValue: (event) => event.request_id,
            render: (event) => event.request_id,
          },
        ],
      }),
    )
    const totals = new Map<string, { paid: bigint; remaining: bigint; historical: bigint }>()
    for (const row of report.rows) {
      if (row.currency === null) continue
      const bucket = totals.get(row.currency) ?? {
        paid: 0n,
        remaining: 0n,
        historical: 0n,
      }
      if (row.amount_basis === 'contractor_cost') bucket.historical += BigInt(row.amount_cents ?? 0)
      bucket.paid += BigInt(row.paid_cents)
      bucket.remaining += BigInt(row.balance_cents ?? 0)
      totals.set(row.currency, bucket)
    }
    const pending = report.rows.filter((row) => hasPaymentActivity(row) && row.status !== 'paid' && row.status !== 'settled')
    summary.replaceChildren(
      text(
        'p',
        `${pending.length} outstanding · ${report.rows.filter((row) => row.overdue).length} overdue · ${pending.filter((row) => row.amount_cents === null).length} outstanding amounts unspecified. As of ${report.as_of}.`,
      ),
    )
    for (const [currency, values] of totals) {
      const line = document.createElement('p')
      line.appendChild(document.createTextNode('Recorded paid: '))
      line.appendChild(moneyText(staffPaymentMoney(values.paid, currency)))
      line.appendChild(document.createTextNode(' · remaining: '))
      line.appendChild(moneyText(staffPaymentMoney(values.remaining, currency)))
      line.appendChild(document.createTextNode(' · historically settled contractor cost: '))
      line.appendChild(moneyText(staffPaymentMoney(values.historical, currency)))
      summary.appendChild(line)
    }
    if (report.rows.some((row) => row.status === 'settled'))
      summary.appendChild(
        text(
          'p',
          'Historical amounts use current contractor costs where available. They are separate from recorded payments; missing rates or absent hours remain unspecified.',
        ),
      )
    element<HTMLAnchorElement>(page, '[data-payment-costs]').href =
      `/reports?report=contractor-cost&from=${report.month}-01&to=${paymentMonthEnd(report.month)}`
    element<HTMLElement>(page, '[data-payment-opening-people]').replaceChildren(
      ...report.rows
        .filter((row) => row.amount_cents === null && row.status !== 'settled')
        .map((row) => {
          const label = document.createElement('label')
          const checkbox = document.createElement('input')
          checkbox.type = 'checkbox'
          checkbox.name = 'person'
          checkbox.value = String(row.user_id)
          label.appendChild(checkbox)
          label.appendChild(document.createTextNode(row.name))
          return label
        }),
    )
    paintList()
    paintPerson()
  }
  const load = async (): Promise<void> => {
    const active = signal
    if (active === null || active.aborted || api.getStaffPaymentReport === undefined) return
    const ownGeneration = ++generation
    report = null
    reconciliation.reset()
    providerSettings.hidden = true
    person.hidden = true
    list.replaceChildren()
    summary.replaceChildren()
    history.replaceChildren()
    element<HTMLElement>(page, '[data-payment-opening-people]').replaceChildren()
    if (!validPaymentMonth(month.value)) {
      status.textContent = 'Choose a valid month.'
      return
    }
    status.textContent = 'Loading payment register…'
    try {
      const response = await api.getStaffPaymentReport(month.value, active)
      if (active.aborted || generation !== ownGeneration) return
      report = response
      deelStage.update(response)
      paint()
      runs.ledger(response)
      actuals.ledger(response, active)
      allocations.ledger(response, active)
      advances.ledger(response)
      staffInvoices.ledger(response)
      reconciliation.ledger(response, active)
      status.textContent = ''
    } catch (error) {
      if (!active.aborted && generation === ownGeneration) status.textContent = failure(error)
    }
  }
  month.addEventListener('change', () => {
    runs.resetSelection()
    actuals.reset()
    allocations.reset()
    selected = null
    command = null
    void load()
  })
  filter.addEventListener('change', paintList)
  showEmpty.addEventListener('change', paintList)
  search.addEventListener('input', paintList)
  element<HTMLElement>(page, '[data-payment-refresh]').addEventListener('click', () => {
    command = null
    void load()
  })
  input('kind').addEventListener('change', () => {
    const row = rowForSelection()
    if (
      input('kind').value === 'payment' &&
      row?.balance_cents !== null &&
      row?.balance_cents !== undefined
    )
      input('amount').value = (row.balance_cents / 100).toFixed(2)
    configureForm()
  })
  form.addEventListener('input', () => {
    command = null
    result.textContent = ''
  })
  form.addEventListener('change', () => {
    command = null
  })
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const row = rowForSelection()
    const active = signal
    if (
      busy ||
      report === null ||
      row === undefined ||
      active === null ||
      active.aborted ||
      api.recordStaffPaymentEvent === undefined
    )
      return
    try {
      const kind = input('kind').value as StaffPaymentCommand['kind']
      command ??= {
        id: crypto.randomUUID(),
        user_id: row.user_id,
        month: report.month,
        expected_version: row.version,
        kind,
        amount_cents:
          kind === 'amount' || kind === 'payment'
            ? staffPaymentAmount(input('amount').value.trim())
            : null,
        currency:
          kind === 'amount' || kind === 'payment'
            ? input('currency').value.trim().toUpperCase()
            : null,
        due_on: kind === 'amount' ? input('due_on').value || null : null,
        paid_on: kind === 'payment' ? input('paid_on').value : null,
        reference: kind === 'payment' ? input('reference').value.trim() : '',
        note: input('note').value.trim(),
        payment_id: kind === 'void' ? input('payment_id').value : null,
        source:
          kind === 'payment'
            ? (input('source').value as StaffPaymentCommand['source'])
            : 'historical',
      }
      const saving = command
      setBusy(true)
      result.textContent = 'Saving…'
      void api
        .recordStaffPaymentEvent(saving, active)
        .then(async () => {
          if (active.aborted) return
          command = null
          await load()
          result.textContent = 'Record saved.'
        })
        .catch((error: unknown) => {
          if (!active.aborted) result.textContent = failure(error)
        })
        .finally(() => {
          if (!active.aborted) setBusy(false)
        })
    } catch (error) {
      result.textContent = failure(error)
    }
  })
  openingForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const active = signal
    const snapshot = report
    const record = api.recordStaffPaymentEvent
    if (busy || active === null || active.aborted || snapshot === null || record === undefined)
      return
    const data = new FormData(openingForm)
    const selectedIds = data.getAll('person').map(Number)
    if (selectedIds.length === 0) {
      status.textContent = 'Choose the people whose earlier periods are settled.'
      return
    }
    if (paymentMonthEnd(snapshot.month) >= snapshot.as_of) {
      status.textContent = 'Choose a completed month for historical settlement.'
      return
    }
    const commands = snapshot.rows
      .filter((row) => selectedIds.includes(row.user_id))
      .map((row): StaffPaymentCommand => ({
        id: crypto.randomUUID(),
        user_id: row.user_id,
        month: snapshot.month,
        expected_version: row.version,
        kind: 'opening',
        amount_cents: null,
        currency: null,
        paid_on: null,
        due_on: null,
        reference: '',
        note: String(data.get('note') ?? '').trim(),
        payment_id: null,
        source: 'historical',
      }))
    setBusy(true)
    void (async () => {
      let saved = 0
      try {
        for (const entry of commands) {
          await record(entry, active)
          saved += 1
        }
        if (!active.aborted) {
          await load()
          status.textContent = `Settlement recorded for ${saved} people.`
        }
      } catch (error) {
        if (!active.aborted) {
          await load()
          status.textContent = `${saved} records saved. ${failure(error)} Refresh and select any remaining people to continue.`
        }
      } finally {
        if (!active.aborted) setBusy(false)
      }
    })()
  })
  for (const providerForm of providerForms) {
    let pending: StaffPaymentProviderCommand | null = null
    providerForm.addEventListener('reset', () => {
      pending = null
    })
    providerForm.addEventListener('input', () => {
      pending = null
    })
    providerForm.addEventListener('change', () => {
      pending = null
    })
    providerForm.addEventListener('submit', (event) => {
      event.preventDefault()
      const active = signal
      const save = api.configureStaffPaymentProvider
      if (busy || report === null || active === null || active.aborted || save === undefined) return
      const organization = providerForm.dataset.paymentProviderForm === 'organization'
      const row = rowForSelection()
      if (!organization && row === undefined) return
      const data = new FormData(providerForm)
      const provider = String(data.get('provider') ?? '')
      const next = {
        user_id: organization ? null : row!.user_id,
        expected_version: organization ? report.provider_settings.version : row!.provider_version,
        provider: provider === '' ? null : (provider as 'wise' | 'deel'),
        note: String(data.get('note') ?? '').trim(),
      }
      if (
        pending === null ||
        JSON.stringify({ ...pending, id: undefined }) !== JSON.stringify(next)
      )
        pending = { ...next, id: crypto.randomUUID() }
      setBusy(true)
      status.textContent = 'Saving provider preference…'
      void save(pending, active)
        .then(async () => {
          if (active.aborted) return
          pending = null
          await load()
          status.textContent = 'Provider preference saved.'
        })
        .catch((error: unknown) => {
          if (!active.aborted) status.textContent = failure(error)
        })
        .finally(() => {
          if (!active.aborted) setBusy(false)
        })
    })
  }
  const download = (audit: boolean): void => {
    if (report === null || signal?.aborted !== false) return
    const url = URL.createObjectURL(
      new Blob([staffPaymentCsv(audit ? report : { ...report, rows: activityRows() }, audit)], {
        type: 'text/csv;charset=utf-8',
      }),
    )
    const link = document.createElement('a')
    link.href = url
    link.download = `staff-payments-${report.month}${audit ? '-audit' : ''}.csv`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  element<HTMLElement>(page, '[data-payment-export]').addEventListener('click', () =>
    download(false),
  )
  element<HTMLElement>(page, '[data-payment-audit-export]').addEventListener('click', () =>
    download(true),
  )
  const stageButton = element<HTMLButtonElement>(page, '[data-payment-stage-deel]')
  const deelStage = createDeelStageController(page, api, () => { stageButton.hidden = !deelStage.available(); if (report) paintList() })
  stageButton.addEventListener('click', () => { tabs.select('balances'); deelStage.open() })
  const deelSync = createDeelSyncController(page, api)
  const advances = createAdvanceCreditsController(page, api, failure)
  const staffInvoices = createStaffInvoicesController(page, api, failure)
  const reconciliation = createContractorReviewController(page, api, failure, (tab) => tabs.select(tab, true))

  return {
    activate: async (identity: { profile: string }, active: AbortSignal): Promise<void> => {
      deelStage.clear()
      signal = active
      content.hidden = true
      if (identity.profile !== 'administrator') {
        status.textContent = 'Only administrators can view staff payment records.'
        return
      }
      if (api.getStaffPaymentReport === undefined || api.recordStaffPaymentEvent === undefined) {
        status.textContent = 'The payment register is unavailable on this instance.'
        return
      }
      active.addEventListener(
        'abort',
        () => {
          generation += 1
          report = null
          selected = null
          command = null
          busy = false
          content.hidden = true
          list.replaceChildren()
          summary.replaceChildren()
          history.replaceChildren()
          form.reset()
          providerForms.forEach((providerForm) => providerForm.reset())
          providerHistory.replaceChildren()
          providerSettings.hidden = true
          openingForm.reset()
          result.textContent = ''
          person.hidden = true
          element<HTMLElement>(person, '[data-payment-person-title]').textContent = ''
          element<HTMLElement>(person, '[data-payment-person-summary]').textContent = ''
          status.textContent = ''
          element<HTMLElement>(page, '[data-payment-opening-people]').replaceChildren()
        },
        { once: true },
      )
      const queryMonth = new URLSearchParams(location.search).get('month')
      month.value =
        queryMonth !== null && validPaymentMonth(queryMonth)
          ? queryMonth
          : previousPaymentMonth(
              new Intl.DateTimeFormat('en-CA', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
              }).format(new Date()),
            )
      setBusy(false)
      content.hidden = false
      const reportMode = location.pathname === '/payments/report'
      const ledger = page.querySelector<HTMLElement>('[data-payment-ledger]')
      if (ledger) ledger.hidden = reportMode
      const toolbar = page.querySelector<HTMLElement>('[data-payment-ledger-toolbar]')
      if (toolbar) toolbar.hidden = reportMode
      payNow.hidden = reportMode || api.previewPaymentRun === undefined
      const heading = page.querySelector('h1')
      if (heading) heading.textContent = reportMode ? 'Payments report' : 'Payments'
      actuals.activate(active)
      allocations.activate(active)
      advances.activate(active)
      staffInvoices.activate(active)
      reconciliation.activate(active)
      await runs.activate(active)
      await deelSync.activate(active)
      if (!reportMode) await deelStage.activate(active)
      tabs.activate(reportMode, api.previewPaymentRun !== undefined)
      if (!reportMode) await load()
    },
  }
}
