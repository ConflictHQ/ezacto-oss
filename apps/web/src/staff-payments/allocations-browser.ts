import { setRequestBusy } from '../request-feedback.js'
// Provenance: ezacto-pvt #899. Review a payment allocation before confirming it,
// and reconcile existing monthly payments explicitly. Additive: nothing here
// changes a monthly total, and no hour split is ever inferred.
import type {
  AllocatePayment,
  ConfirmPaymentActuals,
  PaymentActuals,
  PaymentAllocation,
  PaymentAllocationEntry,
  PaymentAllocationPerson,
  PaymentAllocationPreview,
  PaymentAllocationReport,
  ReversePaymentAllocation,
  StaffPaymentReport,
  UnallocatedPayment,
} from '@ezacto/core'
import { moneyText } from '../money-display.js'
import { staffPaymentAmount, staffPaymentMoney } from './model.js'

export interface PaymentAllocationsApi {
  getPaymentAllocationReport?(month: string, signal?: AbortSignal): Promise<PaymentAllocationReport>
  previewPaymentAllocation?(command: AllocatePayment, signal?: AbortSignal): Promise<PaymentAllocationPreview>
  allocatePayment?(command: AllocatePayment, signal?: AbortSignal): Promise<void>
  reversePaymentAllocation?(command: ReversePaymentAllocation, signal?: AbortSignal): Promise<void>
  getPaymentActuals?(month: string, signal?: AbortSignal): Promise<PaymentActuals>
  confirmPaymentActuals?(command: ConfirmPaymentActuals, signal?: AbortSignal): Promise<void>
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
    setRequestBusy(status, false)
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
    setRequestBusy(status, true)
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
      if (!active.aborted && own === generation) {
        setRequestBusy(status, false)
        refresh.disabled = false
      }
    }
  }
  // Reversal keeps the allocation row and records an audit event beside it.
  const reversal = (a: PaymentAllocation, active: AbortSignal, own: number): HTMLElement => {
    const wrap = node('div')
    if (a.state === 'reversed' || !api.reversePaymentAllocation) return wrap
    const open = node('button', 'Reverse')
    open.type = 'button'
    open.setAttribute('aria-label', `Reverse allocation ${a.id}`)
    open.addEventListener('click', () => {
      open.hidden = true
      const reason = node('textarea'),
        confirm = node('button', 'Confirm reversal'),
        message = node('p')
      reason.required = true
      reason.maxLength = 2000
      reason.setAttribute('aria-label', `Reversal reason for ${a.id}`)
      confirm.type = 'button'
      message.setAttribute('role', 'status')
      message.setAttribute('aria-live', 'polite')
      confirm.addEventListener('click', () => {
        const text = reason.value.trim()
        if (!text) {
          message.textContent = 'Explain the reversal.'
          return
        }
        confirm.disabled = true
        message.textContent = 'Reversing allocation…'
        setRequestBusy(message, true)
        void api
          .reversePaymentAllocation!({ id: crypto.randomUUID(), allocation_id: a.id, reason: text }, active)
          .then(async () => {
            if (active.aborted || own !== generation) return
            await load(selectedUser)
            if (!active.aborted) status.textContent = 'Allocation reversed. The record is kept; no money has moved.'
          })
          .catch((error: unknown) => {
            if (!active.aborted && own === generation) {
              message.textContent = errorText(error)
              confirm.disabled = false
            }
          })
          .finally(() => setRequestBusy(message, false))
      })
      for (const part of [reason, confirm, message]) wrap.appendChild(part)
    })
    wrap.appendChild(open)
    return wrap
  }
  // Source time changed after review: show the reviewed and current hours, then
  // reverse the entry's allocations, re-confirm this person's earnings from the
  // current hours and allocate again. Every step carries an identifier derived from
  // one adjustment identifier, so a retry replays what already succeeded and
  // nothing is recorded twice. Reversed rows stay in the history.
  const adjustment = (
    person: PaymentAllocationPerson,
    month: string,
    entry: PaymentAllocationEntry,
    host: HTMLElement,
    active: AbortSignal,
    own: number,
  ): void => {
    const live = person.allocations.filter(
      (a) => a.entry_id === entry.entry_id && (a.state === 'applied' || a.state === 'reserved'),
    )
    const currency = person.currency
    const [grid, body] = table(`Source time change for entry ${entry.entry_id}`, ['', 'Reviewed', 'Now'])
    const line = (name: string, reviewed: string | HTMLElement, now: string | HTMLElement) => {
      const row = node('tr')
      cell(row, name)
      cell(row, reviewed)
      cell(row, now)
      body.appendChild(row)
    }
    line(
      'Hours worked',
      hours(entry.reviewed_rounded_seconds),
      entry.current_rounded_seconds === null ? 'Entry removed' : hours(entry.current_rounded_seconds),
    )
    line(
      'Rate',
      entry.rate_cents === null ? 'Missing rate' : money(entry.rate_cents, currency),
      entry.current_rate_cents === null ? 'Missing rate' : money(entry.current_rate_cents, currency),
    )
    line('Hours selected for pay', hours(entry.selected_seconds), '')
    line('Allocated', money(entry.applied_cents + entry.reserved_cents, currency), '')
    const reason = node('textarea'),
      go = node('button', 'Reverse and re-allocate'),
      message = node('p')
    reason.required = true
    reason.maxLength = 2000
    reason.setAttribute('aria-label', `Adjustment reason for entry ${entry.entry_id}`)
    go.type = 'button'
    message.setAttribute('role', 'status')
    message.setAttribute('aria-live', 'polite')
    const id = crypto.randomUUID()
    let confirmCommand: ConfirmPaymentActuals | null = null,
      allocateCommands: AllocatePayment[] = [],
      reasonText = ''
    const plan = async (): Promise<void> => {
      if (confirmCommand) return
      const version = ledger?.rows.find((r) => r.user_id === person.user_id)?.version
      if (version === undefined) throw new Error('Reload the payments before adjusting.')
      const actuals = await api.getPaymentActuals!(month, active)
      const entries = actuals.people.find((p) => p.user_id === person.user_id)?.entries
      const current = entries?.find((e) => e.entry_id === entry.entry_id)
      if (!entries || !current) throw new Error('This time entry is no longer in the month. Reverse its allocations instead.')
      let left = current.selected_seconds
      const commands: AllocatePayment[] = []
      for (const a of live) {
        const seconds = a.seconds === null ? null : Math.min(a.seconds, left)
        if (seconds === 0) continue
        if (seconds !== null) left -= seconds
        commands.push({
          id: `${id}-alloc-${commands.length}`,
          payment_kind: a.payment_kind,
          payment_id: a.payment_id,
          user_id: person.user_id,
          month,
          scope: a.scope,
          project_id: a.project_id,
          entry_id: a.entry_id,
          seconds,
          amount_cents: seconds === null ? a.amount_cents : null,
          reason: reasonText,
        })
      }
      allocateCommands = commands
      confirmCommand = {
        id: `${id}-review`,
        user_id: person.user_id,
        month,
        expected_version: version,
        currency: actuals.currency,
        entries,
        note: reasonText,
      }
    }
    go.addEventListener('click', () => {
      reasonText ||= reason.value.trim()
      if (!reasonText) {
        message.textContent = 'Explain the adjustment.'
        return
      }
      go.disabled = true
      reason.disabled = true
      message.textContent = 'Adjusting…'
      setRequestBusy(message, true)
      void (async () => {
        for (const a of live)
          await api.reversePaymentAllocation!({ id: `${id}-rev-${a.id}`, allocation_id: a.id, reason: reasonText }, active)
        await plan()
        await api.confirmPaymentActuals!(confirmCommand!, active)
        for (const command of allocateCommands) await api.allocatePayment!(command, active)
      })()
        .then(async () => {
          if (active.aborted || own !== generation) return
          await load(selectedUser)
          if (!active.aborted)
            status.textContent =
              'Allocations adjusted to the current hours. Reversed rows are kept in the history; no money has been sent.'
        })
        .catch((error: unknown) => {
          if (active.aborted || own !== generation) return
          message.textContent = `${errorText(error)} Retry to continue; steps already recorded are not repeated.`
          go.disabled = false
        })
        .finally(() => setRequestBusy(message, false))
    })
    host.replaceChildren(grid)
    if (live.length === 0) {
      host.appendChild(node('p', 'Nothing is allocated to this entry, so there is nothing to adjust.'))
      return
    }
    host.appendChild(
      node(
        'p',
        'This reverses the allocations on this entry, confirms this person’s earnings again from the current hours and allocates the same payments again. Hours cannot rise above what was selected for pay.',
      ),
    )
    for (const part of [reason, go, message]) host.appendChild(part)
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
    const adjustHost = node('section')
    adjustHost.dataset.allocationAdjust = ''
    detail.appendChild(adjustHost)

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
      'Reverse',
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
      cell(row, reversal(a, active, own))
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
        const flags = node('div')
        flags.appendChild(
          document.createTextNode(
            [entry.source_changed ? 'Source time changed: reverse and re-review' : '', entry.over_allocated ? 'Over-allocated' : '']
              .filter(Boolean)
              .join(' · '),
          ),
        )
        if (
          entry.source_changed &&
          api.reversePaymentAllocation &&
          api.getPaymentActuals &&
          api.confirmPaymentActuals &&
          api.allocatePayment
        ) {
          const review = node('button', 'Review change')
          review.type = 'button'
          review.setAttribute('aria-label', `Review source change for entry ${entry.entry_id}`)
          review.addEventListener('click', () => adjustment(person, month, entry, adjustHost, active, own))
          flags.appendChild(review)
        }
        cell(line, flags)
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
      message.textContent = 'Reviewing allocation…'
      setRequestBusy(message, true)
      void api
        .previewPaymentAllocation(command, active)
        .then((preview) => {
          if (active.aborted || own !== generation) return
          approved = command
          show(preview)
          confirm.hidden = false
          message.textContent = 'Allocation reviewed. Confirm to record it.'
        })
        .catch((error: unknown) => {
          if (!active.aborted && own === generation) message.textContent = errorText(error)
        })
        .finally(() => {
          setRequestBusy(message, false)
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
      message.textContent = 'Recording allocation…'
      setRequestBusy(message, true)
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
          setRequestBusy(message, false)
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
