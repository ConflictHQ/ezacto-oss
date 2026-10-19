// Provenance: ezacto-pvt #899. Review a payment allocation before confirming it,
// and reconcile existing monthly payments explicitly. Additive: nothing here
// changes a monthly total, and no hour split is ever inferred.
import type {
  AllocatePayment,
  PaymentAllocationPerson,
  PaymentAllocationPreview,
  PaymentAllocationReport,
  StaffPaymentReport,
  UnallocatedPayment,
} from '@ezacto/core'
import { moneyText } from '../money-display.js'
import { staffPaymentAmount, staffPaymentMoney } from './model.js'

export interface PaymentAllocationsApi {
  getPaymentAllocationReport?(month: string, signal?: AbortSignal): Promise<PaymentAllocationReport>
  previewPaymentAllocation?(command: AllocatePayment, signal?: AbortSignal): Promise<PaymentAllocationPreview>
  allocatePayment?(command: AllocatePayment, signal?: AbortSignal): Promise<void>
}
// appendChild, never append, and `field` accepts any Node: the api, worker and
// container typechecks compile this file too (via shell/model.ts), under
// workers-types, whose HTMLRewriter Element merges into the DOM one. There
// `append` takes string | Response | ReadableStream and an HTMLSelectElement
// is not an HTMLElement. apps/web's own typecheck is clean either way.
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, label = ''): HTMLElementTagNameMap[K] => {
  const element = document.createElement(tag)
  element.textContent = label
  return element
}
const hours = (seconds: number): string => (seconds / 3600).toFixed(4)
const paymentKey = (payment: UnallocatedPayment): string => `${payment.payment_kind}|${payment.payment_id}`

export const createAllocationsController = (
  page: HTMLElement,
  api: PaymentAllocationsApi,
  errorText: (error: unknown) => string,
) => {
  const panel = page.querySelector<HTMLElement>('[data-payment-allocations]')!
  const status = panel.querySelector<HTMLElement>('[data-allocations-status]')!
  const content = panel.querySelector<HTMLElement>('[data-allocations-content]')!
  const refresh = panel.querySelector<HTMLButtonElement>('[data-allocations-load]')!
  let ledger: StaffPaymentReport | null = null,
    signal: AbortSignal | null = null,
    generation = 0,
    selectedUser = ''
  const reset = () => {
    generation++
    ledger = null
    selectedUser = ''
    content.replaceChildren()
    status.textContent = ''
    refresh.disabled = true
  }
  refresh.addEventListener('click', () => {
    void load()
  })
  const money = (cents: number, currency: string | null): HTMLElement =>
    moneyText(staffPaymentMoney(cents, currency))
  const cell = (row: HTMLElement, value: string | HTMLElement): void => {
    const td = node('td')
    td.appendChild(typeof value === 'string' ? document.createTextNode(value) : value)
    row.appendChild(td)
  }
  const table = (caption: string, titles: string[]): [HTMLElement, HTMLElement] => {
    const wrapper = node('div'),
      grid = node('table'),
      head = node('tr'),
      body = node('tbody')
    wrapper.className = 'data-table-scroll'
    grid.className = 'data-table'
    grid.appendChild(node('caption', caption))
    for (const title of titles) head.appendChild(node('th', title))
    const thead = node('thead')
    thead.appendChild(head)
    grid.appendChild(thead)
    grid.appendChild(body)
    wrapper.appendChild(grid)
    return [wrapper, body]
  }
  const load = async (keep = ''): Promise<void> => {
    const current = ledger,
      active = signal,
      own = ++generation
    if (!current || !active || active.aborted || !api.getPaymentAllocationReport) return
    content.replaceChildren()
    status.textContent = 'Loading allocations…'
    refresh.disabled = true
    try {
      const report = await api.getPaymentAllocationReport(current.month, active)
      if (active.aborted || own !== generation) return
      status.textContent = report.people.length
        ? 'Select a person. Allocating links a payment to earnings; it does not move money.'
        : 'No contractor earnings or payments for this work month.'
      if (!report.people.length) return
      const label = node('label', 'Person '),
        select = node('select')
      select.setAttribute('aria-label', 'Allocate payments for person')
      for (const person of report.people) {
        const option = node('option', person.name)
        option.value = String(person.user_id)
        select.appendChild(option)
      }
      if (keep && report.people.some((p) => String(p.user_id) === keep)) select.value = keep
      label.appendChild(select)
      content.appendChild(label)
      const detail = node('section')
      content.appendChild(detail)
      const paint = (): void => {
        selectedUser = select.value
        detail.replaceChildren()
        const person = report.people.find((p) => String(p.user_id) === select.value)
        if (person) paintPerson(person, report.month, detail, active, own)
      }
      select.addEventListener('change', paint)
      paint()
    } catch (error) {
      if (!active.aborted && own === generation) status.textContent = errorText(error)
    } finally {
      if (!active.aborted && own === generation) refresh.disabled = false
    }
  }
  const paintPerson = (
    person: PaymentAllocationPerson,
    month: string,
    detail: HTMLElement,
    active: AbortSignal,
    own: number,
    fill?: UnallocatedPayment,
  ): void => {
    detail.replaceChildren()
    const currency = person.currency
    const summary = node('p', `${person.name} · ${month} · Earned: `)
    for (const part of [
      money(person.earned_cents, currency),
      ' · Paid: ',
      money(person.paid_cents, currency),
      ' · Reserved: ',
      money(person.reserved_cents, currency),
      ' · Allocated to earnings: ',
      money(person.allocated_applied_cents + person.allocated_reserved_cents, currency),
      ' · Not yet paid or reserved: ',
      money(person.remaining_cents, currency),
    ])
      summary.appendChild(typeof part === 'string' ? document.createTextNode(part) : part)
    detail.appendChild(summary)

    const [paymentsTable, paymentsBody] = table('Payments not fully allocated', [
      'Payment',
      'State',
      'Amount',
      'Allocated',
      'Unallocated',
      'Reconcile',
    ])
    for (const payment of person.unallocated_payments) {
      const row = node('tr')
      cell(row, payment.payment_id)
      cell(row, payment.state === 'reserved' ? 'Reserved (scheduled or processing)' : 'Paid')
      cell(row, money(payment.amount_cents, currency))
      cell(row, money(payment.allocated_cents, currency))
      cell(row, money(payment.unallocated_cents, currency))
      const button = node('button', 'Reconcile to month')
      button.type = 'button'
      button.setAttribute('aria-label', `Reconcile payment ${payment.payment_id} to the work month`)
      button.addEventListener('click', () => paintPerson(person, month, detail, active, own, payment))
      cell(row, button)
      paymentsBody.appendChild(row)
    }
    if (person.unallocated_payments.length) detail.appendChild(paymentsTable)
    else detail.appendChild(node('p', 'Every payment for this work month is fully allocated.'))

    paintForm(person, month, detail, active, own, fill)

    const [allocTable, allocBody] = table('Recorded allocations', [
      'Recorded',
      'Payment',
      'Target',
      'Hours',
      'Rate',
      'Amount',
      'State',
      'Reason',
    ])
    for (const a of person.allocations) {
      const row = node('tr')
      cell(row, a.recorded_at.slice(0, 10))
      cell(row, a.payment_id)
      cell(
        row,
        a.scope === 'month'
          ? 'Whole month'
          : a.scope === 'project'
            ? (a.project_name ?? `Project ${a.project_id}`)
            : `${a.project_name ?? 'Project'} · entry ${a.entry_id}`,
      )
      cell(row, a.seconds === null ? '' : hours(a.seconds))
      cell(row, a.rate_cents === null ? '' : money(a.rate_cents, a.currency))
      cell(row, money(a.amount_cents, a.currency))
      cell(row, a.state)
      cell(row, a.reason)
      allocBody.appendChild(row)
    }
    if (person.allocations.length) detail.appendChild(allocTable)

    const [entryTable, entryBody] = table('Earnings by project and time entry', [
      'Project / entry',
      'Selected hours',
      'Rate',
      'Earned',
      'Paid',
      'Reserved',
      'Remaining',
      'Remaining hours',
      'Flags',
    ])
    for (const project of person.projects) {
      const row = node('tr')
      cell(row, project.project_name)
      cell(row, '')
      cell(row, '')
      cell(row, money(project.earned_cents, currency))
      cell(row, money(project.applied_cents, currency))
      cell(row, money(project.reserved_cents, currency))
      cell(row, money(project.remaining_cents, currency))
      cell(row, '')
      cell(row, '')
      entryBody.appendChild(row)
      for (const entry of project.entries) {
        const line = node('tr')
        cell(line, `${entry.spent_date} · entry ${entry.entry_id}`)
        cell(line, hours(entry.selected_seconds))
        cell(line, entry.rate_cents === null ? 'Missing rate' : money(entry.rate_cents, currency))
        cell(line, money(entry.earned_cents, currency))
        cell(line, money(entry.applied_cents, currency))
        cell(line, money(entry.reserved_cents, currency))
        cell(line, money(entry.remaining_cents, currency))
        cell(line, hours(entry.remaining_seconds))
        cell(
          line,
          [entry.source_changed ? 'Source time changed: reverse and re-review' : '', entry.over_allocated ? 'Over-allocated' : '']
            .filter(Boolean)
            .join(' · '),
        )
        entryBody.appendChild(line)
      }
    }
    if (person.projects.length) detail.appendChild(entryTable)
  }
  const paintForm = (
    person: PaymentAllocationPerson,
    month: string,
    detail: HTMLElement,
    active: AbortSignal,
    own: number,
    fill?: UnallocatedPayment,
  ): void => {
    if (!person.unallocated_payments.length) return
    const currency = person.currency
    const form = node('form')
    form.dataset.allocationForm = ''
    form.appendChild(node('h3', 'Allocate a payment'))
    const field = <T extends Node>(text: string, control: T): T => {
      const wrap = node('label', `${text} `)
      wrap.appendChild(control)
      form.appendChild(wrap)
      return control
    }
    const payment = field('Payment', node('select')),
      scope = field('Allocate to', node('select')),
      project = field('Project', node('select')),
      entry = field('Time entry', node('select')),
      seconds = field('Hours paid (valued at the captured rate)', node('input')),
      amount = field('Exact amount (required without hours)', node('input')),
      reason = field('Reason', node('textarea'))
    payment.setAttribute('aria-label', 'Payment to allocate')
    scope.setAttribute('aria-label', 'Allocate to')
    for (const p of person.unallocated_payments) {
      const option = node('option', `${p.payment_id} · ${staffPaymentMoney(p.unallocated_cents, currency)} unallocated`)
      option.value = paymentKey(p)
      payment.appendChild(option)
    }
    for (const [value, text] of [
      ['month', 'Whole work month (amount only)'],
      ['project', 'A project (amount only)'],
      ['entry', 'A time entry (hours or amount)'],
    ] as const) {
      const option = node('option', text)
      option.value = value
      scope.appendChild(option)
    }
    for (const p of person.projects) {
      const option = node('option', p.project_name)
      option.value = String(p.project_id)
      project.appendChild(option)
    }
    seconds.type = 'number'
    seconds.step = 'any'
    seconds.min = '0'
    seconds.setAttribute('aria-label', 'Hours paid')
    amount.inputMode = 'decimal'
    amount.placeholder = '0.00'
    amount.setAttribute('aria-label', 'Exact amount')
    reason.required = true
    reason.maxLength = 2000
    reason.setAttribute('aria-label', 'Allocation reason')
    const result = node('div'),
      message = node('p'),
      review = node('button', 'Review allocation'),
      confirm = node('button', 'Confirm allocation')
    message.setAttribute('role', 'status')
    message.setAttribute('aria-live', 'polite')
    review.type = 'submit'
    confirm.type = 'button'
    confirm.className = 'primary-action'
    confirm.hidden = true
    let approved: AllocatePayment | null = null,
      saving = false
    const paintEntries = () => {
      entry.replaceChildren()
      const entries = person.projects.find((p) => String(p.project_id) === project.value)?.entries ?? []
      for (const e of entries) {
        const option = node('option', `${e.spent_date} · entry ${e.entry_id} · ${hours(e.remaining_seconds)} h left`)
        option.value = String(e.entry_id)
        entry.appendChild(option)
      }
    }
    const layout = () => {
      project.parentElement!.hidden = scope.value === 'month'
      entry.parentElement!.hidden = scope.value !== 'entry'
      seconds.parentElement!.hidden = scope.value !== 'entry'
    }
    const invalidate = () => {
      approved = null
      confirm.hidden = true
      result.replaceChildren()
      message.textContent = ''
    }
    paintEntries()
    if (fill) {
      payment.value = paymentKey(fill)
      scope.value = 'month'
      amount.value = (fill.unallocated_cents / 100).toFixed(2)
      reason.value = `Reconciled existing ${month} payment ${fill.payment_id} to the work month`
    }
    layout()
    scope.addEventListener('change', () => {
      layout()
      invalidate()
    })
    project.addEventListener('change', () => {
      paintEntries()
      invalidate()
    })
    for (const control of [payment, entry, seconds, amount, reason]) {
      control.addEventListener('input', invalidate)
      control.addEventListener('change', invalidate)
    }
    const build = (): AllocatePayment => {
      const [kind, id] = payment.value.split('|') as [AllocatePayment['payment_kind'], string]
      const hoursValue =
        scope.value === 'entry' && seconds.value !== '' ? Math.round(Number(seconds.value) * 3600) : null
      if (hoursValue !== null && !Number.isSafeInteger(hoursValue)) throw new Error('Enter a valid number of hours.')
      return {
        id: crypto.randomUUID(),
        payment_kind: kind,
        payment_id: id,
        user_id: person.user_id,
        month,
        scope: scope.value as AllocatePayment['scope'],
        project_id: scope.value === 'month' ? null : Number(project.value),
        entry_id: scope.value === 'entry' ? Number(entry.value) : null,
        seconds: hoursValue,
        amount_cents: amount.value.trim() === '' ? null : staffPaymentAmount(amount.value.trim()),
        reason: reason.value.trim(),
      }
    }
    const show = (preview: PaymentAllocationPreview): void => {
      const [grid, body] = table('Allocation review', ['Item', 'Value'])
      const line = (name: string, value: string | HTMLElement) => {
        const row = node('tr')
        cell(row, name)
        cell(row, value)
        body.appendChild(row)
      }
      const c = preview.currency
      if (preview.seconds !== null) line('Selected hours', hours(preview.seconds))
      if (preview.rate_cents !== null) line('Captured rate', money(preview.rate_cents, c))
      line('This allocation', money(preview.amount_cents, c))
      line('Payment', money(preview.payment_cents, c))
      line('Payment already allocated', money(preview.payment_allocated_cents, c))
      line('Payment unallocated after this', money(preview.payment_remaining_cents, c))
      line('Earnings', money(preview.earning_cents, c))
      line('Earnings already paid or reserved', money(preview.earning_allocated_cents, c))
      line('Earnings remaining after this', money(preview.earning_remaining_cents, c))
      if (preview.earning_remaining_seconds !== null)
        line('Hours remaining after this', hours(preview.earning_remaining_seconds))
      result.replaceChildren(grid)
    }
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      if (saving || !api.previewPaymentAllocation) return
      invalidate()
      let command: AllocatePayment
      try {
        command = build()
      } catch (error) {
        message.textContent = errorText(error)
        return
      }
      saving = true
      review.disabled = true
      void api
        .previewPaymentAllocation(command, active)
        .then((preview) => {
          if (active.aborted || own !== generation) return
          approved = command
          show(preview)
          confirm.hidden = false
        })
        .catch((error: unknown) => {
          if (!active.aborted && own === generation) message.textContent = errorText(error)
        })
        .finally(() => {
          saving = false
          review.disabled = false
        })
    })
    confirm.addEventListener('click', () => {
      if (saving || !approved || !api.allocatePayment) return
      const command = approved
      saving = true
      confirm.disabled = true
      review.disabled = true
      void api
        .allocatePayment(command, active)
        .then(async () => {
          if (active.aborted || own !== generation) return
          await load(selectedUser)
          if (!active.aborted) status.textContent = 'Allocation recorded. No money has been sent.'
        })
        .catch((error: unknown) => {
          if (!active.aborted && own === generation) message.textContent = errorText(error)
        })
        .finally(() => {
          saving = false
          confirm.disabled = false
          review.disabled = false
        })
    })
    form.appendChild(review)
    form.appendChild(confirm)
    form.appendChild(message)
    form.appendChild(result)
    detail.appendChild(form)
  }
  return {
    reset,
    ledger: (report: StaffPaymentReport, active: AbortSignal) => {
      if (ledger?.month !== report.month) reset()
      ledger = report
      signal = active
      refresh.disabled = !api.getPaymentAllocationReport
    },
    activate: (active: AbortSignal) => {
      signal = active
      reset()
      active.addEventListener('abort', reset, { once: true })
    },
  }
}
